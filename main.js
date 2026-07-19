const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { app, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const http = require('http');
const { spawn } = require('child_process');

let mainWindow;

// =================================================================
// GLOBAL CRASH SAFETY
// =================================================================
const logFatalCrash = (errorType, error) => {
  const logPath = path.join(app.getPath('userData'), 'crash-log.txt');
  const timestamp = new Date().toISOString();
  const logMessage = `\n=================================================================\nFATAL UNCAUGHT OVERRIDE EVENT DETECTED\nTimestamp: ${timestamp}\nException Context: ${errorType}\nMessage: ${error?.message || error}\nStack Trace:\n${error?.stack || 'No extended system trace provided.'}\n=================================================================\n`;
  try {
    fs.appendFileSync(logPath, logMessage, 'utf8');
  } catch (fsErr) {
    console.error('Failed to commit crash log:', fsErr);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { dialog } = require('electron');
    dialog.showErrorBox('System Engine Exception', `A fatal background exception occurred.\n\nCrash trace saved to:\n${logPath}`);
  }
  app.quit();
};

process.on('uncaughtException', (err) => { logFatalCrash('uncaughtException', err); });
process.on('unhandledRejection', (reason) => { logFatalCrash('unhandledRejection', reason); });

// =================================================================
// STEP 1: READ SYSTEM CONFIG BEFORE ANYTHING ELSE
// This file lives on each individual PC and tells the app
// whether it is a Server or a Client, and where to find the data.
// =================================================================
const configPath = path.join(app.getPath('userData'), 'system-config.json');

const DEFAULT_CONFIG = {
  mode: 'server',        // 'server' or 'client'
  serverIp: '',          // Used by client to find the server
  serverPort: '3847',    // The port the server listens on
  devPasswordHash: '',   // Bcrypt hash of the developer password
  apiToken: '',          // Shared secret; must match on server + every client
  printerName: ''        // Exact Windows name of the receipt printer ('' = auto-detect)
};

let sysConfig = { ...DEFAULT_CONFIG };

if (fs.existsSync(configPath)) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    sysConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    console.log(`System config loaded. Mode: ${sysConfig.mode}`);
  } catch (e) {
    console.error('Failed to parse system-config.json, using defaults:', e.message);
  }
}

// =================================================================
// STEP 2: DECIDE MODE — SERVER OR CLIENT
// =================================================================
const IS_SERVER = sysConfig.mode !== 'client';
const IS_CLIENT = sysConfig.mode === 'client';

// =================================================================
// STEP 3: DATABASE SETUP (SERVER ONLY)
// Client machines never open a local database at all.
// =================================================================
let db = null;

if (IS_SERVER) {
  let dbPath = path.join(__dirname, 'pharmacy.db');

  if (app.isPackaged || !fs.existsSync(dbPath)) {
    const userDataPath = app.getPath('userData');
    dbPath = path.join(userDataPath, 'pharmacy.db');
    if (!fs.existsSync(dbPath)) {
      const templatePath = path.join(process.resourcesPath, 'pharmacy.db');
      const sourcePath = fs.existsSync(templatePath) ? templatePath : path.join(__dirname, 'pharmacy.db');
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, dbPath);
        console.log('Seeded fresh database to user data directory.');
      }
    }
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) logFatalCrash('Database connection error', err);
    else console.log('Database safely connected at:', dbPath);
  });

  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL;');

    db.run(`CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT, name TEXT, generic TEXT, batch TEXT, expiry TEXT,
      totalUnits INTEGER, factor INTEGER, buyingPrice REAL DEFAULT 0,
      retailPrice REAL, category TEXT, intake_time TEXT, is_active INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sales_history (
      id TEXT PRIMARY KEY, timestamp TEXT, itemsJson TEXT,
      subtotal REAL, discountPercent REAL, discountDeduction REAL, grandTotal REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, password TEXT NOT NULL
    )`);

    db.run(`ALTER TABLE credentials ADD COLUMN username TEXT DEFAULT 'admin'`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN intake_time TEXT`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN is_active INTEGER DEFAULT 1`, () => {});
    db.run(`ALTER TABLE inventory ADD COLUMN barcode TEXT`, () => {});

    // Without these, every barcode scan and every 5s inventory/history poll
    // does a full table scan. Cheap to create, and IF NOT EXISTS makes it a
    // no-op on existing installs.
    db.run(`CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode)`, () => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_inventory_active ON inventory(is_active)`, () => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_sales_timestamp ON sales_history(timestamp)`, () => {});

    db.get(`SELECT COUNT(*) as count FROM credentials`, [], (err, row) => {
      if (!err && row.count === 0) {
        const defaultTerminal = bcrypt.hashSync('1234', 10);
        const defaultVault = bcrypt.hashSync('admin786', 10);
        db.run(`INSERT INTO credentials (role, password) VALUES ('terminal', ?), ('vault', ?)`, [defaultTerminal, defaultVault]);
      }
    });
  });
}

// =================================================================
// STEP 4: EXPRESS API SERVER (SERVER MODE ONLY)
// Every database operation is exposed as an HTTP endpoint.
// Client machines call these instead of IPC.
// =================================================================
let expressServer = null;

if (IS_SERVER) {
  // We only require express if we're a server — clients don't need it
  let express;
  try {
    express = require('express');
  } catch (e) {
    logFatalCrash('Express not installed', e);
  }

  const expressApp = express();
  expressApp.use(express.json());

  // Health endpoint stays open — it exposes no data and the "Test Connection"
  // button needs it before a token is configured.
  expressApp.get('/api/health', (req, res) => {
    res.json({ status: 'ok', mode: 'server', version: '1.4', authRequired: !!sysConfig.apiToken });
  });

  // ---------------------------------------------------------------
  // API TOKEN GUARD
  // The server listens on 0.0.0.0, so without this ANY device on the
  // pharmacy WiFi can read costs, delete products or post fake sales.
  // Backwards compatible: with no token set the API still works, but
  // warns loudly. Set a token in the dev screen on the server AND on
  // every client to lock it down.
  // ---------------------------------------------------------------
  if (!sysConfig.apiToken) {
    console.warn(
      '\n*** SECURITY WARNING ***\n' +
      'No apiToken is set, so this pharmacy API is OPEN to every device on the network.\n' +
      'Set one in the hidden developer screen (server + each client) to secure it.\n'
    );
  }

  expressApp.use('/api', (req, res, next) => {
    if (!sysConfig.apiToken) return next();       // not configured yet
    if (req.path === '/health') return next();    // always open
    const presented = req.get('x-api-token');
    if (presented && presented === sysConfig.apiToken) return next();
    return res.status(401).json({ error: 'Unauthorized: bad or missing API token.' });
  });

  // Brute-force guard for the auth routes. The 3-strike lockout used to live
  // only in the IPC handlers, so anything hitting HTTP directly could try the
  // vault PIN forever. Tracked per client IP, cleared on success.
  const httpAuthFailures = new Map(); // ip -> { count, until }
  const AUTH_MAX_ATTEMPTS = 5;
  const AUTH_LOCK_MS = 5 * 60 * 1000;

  const authLimiter = (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const rec = httpAuthFailures.get(ip);
    if (rec && rec.until > Date.now()) {
      const mins = Math.ceil((rec.until - Date.now()) / 60000);
      return res.status(429).json({ success: false, message: `Too many failed attempts. Locked for ${mins} more minute(s).` });
    }
    req.authIp = ip;
    next();
  };

  const noteAuthResult = (ip, ok) => {
    if (ok) return httpAuthFailures.delete(ip);
    const rec = httpAuthFailures.get(ip) || { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= AUTH_MAX_ATTEMPTS) {
      rec.until = Date.now() + AUTH_LOCK_MS;
      rec.count = 0;
    }
    httpAuthFailures.set(ip, rec);
  };

  expressApp.get('/api/status', (req, res) => {
    res.json({ status: isSystemBusy ? 'busy' : 'online' });
  });

  // Mirror every IPC handler as an HTTP endpoint
  expressApp.get('/api/inventory', (req, res) => {
    db.all(`SELECT * FROM inventory WHERE is_active = 1 ORDER BY datetime(intake_time) DESC, id DESC`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });

  expressApp.get('/api/inventory/barcode/:barcode', (req, res) => {
    db.all(`SELECT * FROM inventory WHERE barcode = ? AND is_active = 1`, [req.params.barcode], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });

  expressApp.get('/api/inventory/search', (req, res) => {
    const query = req.query.q || '';
    const pattern = `%${query.toLowerCase()}%`;
    db.all(
      `SELECT * FROM inventory WHERE is_active = 1 AND (LOWER(name) LIKE ? OR LOWER(generic) LIKE ? OR LOWER(batch) LIKE ? OR barcode = ?) ORDER BY name ASC, totalUnits DESC LIMIT 10`,
      [pattern, pattern, pattern, query],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  });

  expressApp.post('/api/inventory', (req, res) => {
    const item = req.body;
    const ts = new Date().toISOString();
    db.run(
      `INSERT INTO inventory (barcode, name, generic, batch, expiry, totalUnits, factor, buyingPrice, retailPrice, category, intake_time, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      [item.barcode || '', item.name, item.generic, item.batch, item.expiry, item.totalUnits, item.factor, item.buyingPrice, item.retailPrice, item.category, ts],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID.toString() });
      }
    );
  });

  expressApp.put('/api/inventory/:id', (req, res) => {
    const item = req.body;
    db.run(
      `UPDATE inventory SET barcode=?, name=?, generic=?, batch=?, expiry=?, totalUnits=?, factor=?, buyingPrice=?, retailPrice=?, category=? WHERE id=?`,
      [item.barcode || '', item.name, item.generic, item.batch, item.expiry, parseInt(item.totalUnits) || 0, parseInt(item.factor) || 10, parseFloat(item.buyingPrice) || 0, parseFloat(item.retailPrice) || 0, item.category, req.params.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      }
    );
  });

  expressApp.delete('/api/inventory/:id', (req, res) => {
    db.run(`UPDATE inventory SET is_active = 0 WHERE id = ?`, [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });

  expressApp.get('/api/sales', (req, res) => {
    db.all(`SELECT * FROM sales_history ORDER BY timestamp DESC`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });

  expressApp.get('/api/sales/search', (req, res) => {
    const query = (req.query.q || '').trim().toLowerCase()
      .replace(/^inv-/, '').replace(/^sale-/, '').replace(/^ret-/, '');
    if (!query) {
      return db.all(`SELECT * FROM sales_history ORDER BY timestamp DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      });
    }
    db.all(
      `SELECT * FROM sales_history WHERE LOWER(id) LIKE ? OR CAST(SUBSTR(id, 6) AS TEXT) = ? ORDER BY timestamp DESC`,
      [`%${query}%`, query],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  });

  // Checkout and return share ONE implementation with the IPC handlers
  // (performCheckout / performReturn below). Both run through the write queue,
  // so two cashiers can never interleave transactions on the shared connection.
  expressApp.post('/api/checkout', (req, res) => {
    performCheckout(req.body)
      .then((result) => res.json(result))
      .catch((err) => res.status(err.statusCode || 500).json({ error: err.message }));
  });

  expressApp.post('/api/return', (req, res) => {
    performReturn(req.body)
      .then((result) => res.json(result))
      .catch((err) => res.status(err.statusCode || 500).json({ error: err.message }));
  });

  expressApp.post('/api/inventory/:id/restock', (req, res) => {
    performRestock({ id: req.params.id, unitsToAdd: req.body && req.body.unitsToAdd })
      .then((result) => res.json(result))
      .catch((err) => res.status(err.statusCode || 500).json({ error: err.message }));
  });

  // Reprint an existing receipt on the server's printer. Client machines call
  // this; the printer lives on the server PC so the print always happens here.
  expressApp.post('/api/reprint', (req, res) => {
    const { saleId } = req.body || {};
    printSaleById(saleId || null, (result) => {
      if (!result.success) return res.status(404).json(result);
      res.json(result);
    });
  });

  expressApp.post('/api/auth/terminal', authLimiter, (req, res) => {
    const { username, password } = req.body || {};
    if (!username) {
      noteAuthResult(req.authIp, false);
      return res.json({ success: false, message: 'Invalid credentials.' });
    }
    db.get(`SELECT username, password FROM credentials WHERE role = 'terminal'`, [], (err, row) => {
      if (err || !row) return res.json({ success: false, message: 'Auth service error.' });
      const storedUsername = row.username || 'admin';
      if (username.toLowerCase() !== storedUsername.toLowerCase()) {
        noteAuthResult(req.authIp, false);
        return res.json({ success: false, message: 'Invalid credentials.' });
      }
      let isMatch = row.password.startsWith('$2') ? bcrypt.compareSync(password, row.password) : row.password === password;
      if (isMatch && !row.password.startsWith('$2')) db.run(`UPDATE credentials SET password=? WHERE role='terminal'`, [bcrypt.hashSync(password, 10)]);
      noteAuthResult(req.authIp, isMatch);
      res.json(isMatch ? { success: true } : { success: false, message: 'Invalid credentials.' });
    });
  });

  expressApp.post('/api/auth/vault', authLimiter, (req, res) => {
    const { pin } = req.body || {};
    db.get(`SELECT password FROM credentials WHERE role = 'vault'`, [], (err, row) => {
      if (err || !row) return res.json({ success: false, message: 'Auth service error.' });
      let isMatch = row.password.startsWith('$2') ? bcrypt.compareSync(pin, row.password) : row.password === pin;
      noteAuthResult(req.authIp, isMatch);
      res.json(isMatch ? { success: true } : { success: false, message: 'Invalid PIN.' });
    });
  });

  const port = parseInt(sysConfig.serverPort) || 3847;
  expressServer = expressApp.listen(port, '0.0.0.0', () => {
    console.log(`PharmTrack API server running on port ${port}`);
  });

  expressServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logFatalCrash('Port already in use', new Error(`Port ${port} is already in use. Change serverPort in system-config.json.`));
    } else {
      logFatalCrash('Express server error', err);
    }
  });
}

// =================================================================
// RECEIPT PRINTING (SERVER ONLY — printer is attached to server PC)
// =================================================================
function triggerReceiptPrint(cleanSaleId, timestamp, cartItems, subtotal, discountDeduction, grandTotal) {
  try {
    const bwipjs = require('bwip-js');
    const barcodeSvg = bwipjs.toSVG({ bcid: 'code128', text: `INV-${cleanSaleId}`, height: 12, includetext: false });

    const escapeHtml = (unsafe) => (unsafe || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

    // Load logo as base64 so it works both in dev and packaged builds
    let logoHtml = '';
    try {
      const logoPath = app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'receipt-logo.png')
        : fs.existsSync(path.join(__dirname, 'assets', 'receipt-logo.png'))
          ? path.join(__dirname, 'assets', 'receipt-logo.png')
          : path.join(__dirname, 'frontend', 'src', 'assets', 'receipt-logo.png');
      if (fs.existsSync(logoPath)) {
        const logoBase64 = fs.readFileSync(logoPath).toString('base64');
        logoHtml = `<div style="text-align:center;margin-bottom:4px;">
          <img src="data:image/png;base64,${logoBase64}"
               style="width:80px;height:80px;object-fit:contain;" alt="Logo" />
        </div>`;
      }
    } catch (logoErr) {
      // Logo load failed — fall through to text header silently
    }

    // Calculate total item discounts and global discount for proportional distribution
    const totalItemDiscounts = cartItems.reduce((s, i) => s + Math.round(i.itemDiscountAmount || 0), 0);
    const globalDiscountOnly = Math.max(0, Math.round(discountDeduction) - totalItemDiscounts);
    const subtotalAfterItemDisc = Math.max(1, Math.round(subtotal) - totalItemDiscounts);

    // Build per-item rows — 4 columns: Name+Qty | Price | Disc | Net
    const itemRows = cartItems.map((i, idx) => {
      const isLast       = idx === cartItems.length - 1;
      const lineTotal    = Math.round((i.price || 0) * (i.qty || 1));
      const itemDiscount = Math.round(i.itemDiscountAmount || 0);
      const afterItemDisc = lineTotal - itemDiscount;

      // Proportional share of the global bill discount for this line
      const globalShare = globalDiscountOnly > 0
        ? Math.round((afterItemDisc / subtotalAfterItemDisc) * globalDiscountOnly)
        : 0;

      const totalDiscForLine = itemDiscount + globalShare;
      const netTotal = lineTotal - totalDiscForLine;
      const sellType = i.type ? i.type.charAt(0).toUpperCase() : '';

      return `
        <div style="display:flex;justify-content:space-between;
                    align-items:flex-start;margin-bottom:5px;
                    padding-bottom:4px;
                    ${isLast ? '' : 'border-bottom:1px dotted #000;'}
                    font-size:11px;">
          <span style="width:40%;word-break:break-all;font-weight:bold;">
            ${escapeHtml(i.name)}
            <span style="font-weight:normal;font-size:9px;"> (${sellType}) x${escapeHtml(i.qty)}</span>
          </span>
          <span style="width:20%;text-align:right;">Rs.${lineTotal}</span>
          <span style="width:20%;text-align:right;">
            ${totalDiscForLine > 0 ? `-${totalDiscForLine}` : '-'}
          </span>
          <span style="width:20%;text-align:right;font-weight:bold;">Rs.${netTotal}</span>
        </div>`;
    }).join('');

    const globalDiscountRows = '';

    const receiptHtml = `<html><head><meta charset="utf-8"/><style>
      /* Black Copper BC-88AC: 80mm roll, but the print head only covers
         ~72.1mm (that's what the driver's "80(72.1) x 3276mm" label means).
         The page stays 80mm to match the paper; the 4mm side padding keeps all
         content inside the 72mm printable band so nothing is clipped.
         Real page height is injected at print time (see main.js). Do NOT use
         'auto' here — Chromium ignores it and falls back to Letter paper. */
      @page { margin: 0; size: 80mm 297mm; }

      /* Ensure padding doesn't stretch elements past 80mm */
      *, *::before, *::after { box-sizing: border-box; }

      html, body { width: 80mm; margin: 0; padding: 0; background: #fff; }
      body {
        font-family: 'Courier New', monospace; font-size: 14px;
        padding: 4px 4mm;              /* 80mm - 8mm = 72mm printable band */
        color: #000;
        /* Thermal head is 1-bit: keep tones exactly as authored */
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }

      .tc{text-align:center;}
      .rj{display:flex;justify-content:space-between;}
      .bc{margin:8px 0 2px 0;text-align:center;}
      .bc svg{width:90%;max-height:50px;}
      .id{font-size:13px;font-weight:bold;text-align:center;letter-spacing:2px;margin-bottom:6px;}
      hr{border:none;border-top:1px dashed #000;margin:6px 0;}
      /* Monochrome thermal: mid-greys dither to faint/blank, so use black */
      .footer-note{font-size:11px;text-align:center;color:#000;margin-top:4px;line-height:1.4;}
    </style></head><body>

      ${logoHtml}
      <div class="tc" style="font-size:16px;font-weight:900;letter-spacing:1px;margin-bottom:1px;">NOUMAN PHARMACY</div>
      <div class="tc" style="font-size:10px;color:#000;margin-bottom:1px;">&#9990; 0327-8322014</div>
      <div class="tc" style="font-size:10px;color:#000;margin-bottom:4px;">&#9993; noumanpharmacy12@gmail.com</div>

      <hr/>

      <div class="bc">${barcodeSvg}</div>
      <div class="id">INV-${escapeHtml(cleanSaleId)}</div>
      <div style="font-size:11px;margin-bottom:4px;">
        <b>Date:</b> ${new Date(timestamp).toLocaleString('en-PK')}
      </div>

      <hr/>

      <div style="display:flex;justify-content:space-between;font-weight:bold;
                  font-size:10px;padding-bottom:4px;border-bottom:1px dashed #000;margin-bottom:4px;">
        <span style="width:40%;">Item</span>
        <span style="width:20%;text-align:right;">Price</span>
        <span style="width:20%;text-align:right;">Disc</span>
        <span style="width:20%;text-align:right;">Net</span>
      </div>

      <div style="font-size:11px;margin-bottom:6px;">
        ${itemRows}
        ${globalDiscountRows}
      </div>

      <div style="font-size:12px;line-height:1.5;">
        <div class="rj"><span>Subtotal</span><span>Rs.${Math.round(subtotal)}</span></div>
        <div class="rj" style="font-size:14px;font-weight:900;margin-top:3px;padding-top:3px;border-top:1px solid #000;">
          <span>NET PAID</span><span>Rs.${Math.round(grandTotal)}</span>
        </div>
      </div>

      <hr/>

      <div class="tc" style="font-size:11px;font-weight:bold;margin-top:6px;">
        Thank you for your visit!
      </div>
      <div class="footer-note">
        Return / Exchange only possible if original<br/>
        receipt is presented within 3 days.
      </div>

    </body></html>`;

    // Hidden window sized to an 80mm roll (80mm ~= 302px at 96dpi).
    // Giving it a real size + disabling throttling forces it to actually
    // paint a frame — a zero-size/throttled hidden window prints blank.
    let printWindow = new BrowserWindow({
      show: false,
      width: 320,
      height: 900,
      webPreferences: { offscreen: false, backgroundThrottling: false }
    });
    const printTimeout = setTimeout(() => { if (printWindow && !printWindow.isDestroyed()) printWindow.destroy(); }, 15000);
    const cleanup = () => {
      clearTimeout(printTimeout);
      if (printWindow && !printWindow.isDestroyed()) printWindow.close();
      printWindow = null;
    };

    printWindow.webContents.on('did-finish-load', async () => {
      try {
        // Wait for two animation frames so layout + the base64 logo have
        // actually painted, THEN measure the real rendered height. Printing
        // straight from did-finish-load captures a blank, un-laid-out page.
        //
        // Measure the bottom edge of the last content element — NOT
        // document.body height / scrollHeight. Chromium stretches the body to
        // the window height, so those report ~900px (the window) and would
        // leave a long blank tail on the roll.
        const heightPx = await printWindow.webContents.executeJavaScript(
          'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {' +
          '  let max = 0;' +
          '  for (const el of document.body.children) {' +
          '    const b = el.getBoundingClientRect().bottom; if (b > max) max = b;' +
          '  }' +
          '  const pb = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;' +
          '  r(Math.ceil(max + pb));' +
          '})))'
        );

        const MICRONS_PER_PX = 264.5833; // 1 CSS px @96dpi = 1/96 inch
        const pageWidth = 80000;          // 80mm roll
        // Match page height to content (+ small tail) so the roll printer
        // feeds exactly the receipt length instead of a fixed 297mm page.
        const pageHeight = Math.max(50000, Math.round((heightPx + 24) * MICRONS_PER_PX));

        // Inject an explicit @page rule matching the print pageSize below.
        // This keeps the CSS page box and the physical paper identical, so
        // Chromium neither scales the content nor falls back to Letter paper.
        const heightMm = (pageHeight / 1000).toFixed(1);
        await printWindow.webContents.executeJavaScript(
          `(() => { const s = document.createElement('style');` +
          ` s.textContent = '@page { margin: 0; size: 80mm ${heightMm}mm; }';` +
          ` document.head.appendChild(s); })()`
        );

        printWindow.webContents.print(
          { silent: true, printBackground: true, margins: { marginType: 'none' }, pageSize: { width: pageWidth, height: pageHeight } },
          (success, failureReason) => {
            if (!success) console.error('Receipt print failed:', failureReason);
            cleanup();
          }
        );
      } catch (e) {
        console.error('Receipt print error:', e);
        cleanup();
      }
    });
    printWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('Receipt page failed to load:', code, desc);
      cleanup();
    });
    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(receiptHtml)}`);
  } catch (err) {
    console.error('Print failed:', err);
  }
}

// =================================================================
// ESC/POS RAW PRINTING (primary path)
// Builds the receipt as native ESC/POS commands (~2 KB) and writes it
// straight to the Windows print queue in RAW mode — no HTML rendering,
// no page rasterization, instant output, explicit paper cut. Falls back
// to the HTML print path (triggerReceiptPrint) if anything fails.
// =================================================================

async function buildEscPosReceipt(cleanSaleId, timestamp, cartItems, subtotal, discountDeduction, grandTotal) {
  const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
  // The interface is a placeholder — execute() is never called, so no TCP
  // connection is attempted. We only use the library to build the byte
  // buffer, then hand it to the Windows spooler ourselves.
  const p = new ThermalPrinter({ type: PrinterTypes.EPSON, interface: 'tcp://127.0.0.1:9100', width: 48 });

  // 48 columns at Font A on an 80mm head (576 dots / 12-dot glyphs)
  const W = 48;
  const NAME_W = 22, PRICE_W = 9, DISC_W = 7, NET_W = 10;
  const rightPair = (left, right) => left.padEnd(Math.max(1, W - right.length)) + right;
  const wrap = (text, width) => {
    const out = [];
    let s = (text || '').toString().trim();
    while (s.length > width) {
      let cut = s.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      out.push(s.slice(0, cut));
      s = s.slice(cut).trim();
    }
    if (s.length) out.push(s);
    return out.length ? out : [''];
  };

  // Same proportional discount math as the HTML receipt
  const totalItemDiscounts = cartItems.reduce((s, i) => s + Math.round(i.itemDiscountAmount || 0), 0);
  const globalDiscountOnly = Math.max(0, Math.round(discountDeduction) - totalItemDiscounts);
  const subtotalAfterItemDisc = Math.max(1, Math.round(subtotal) - totalItemDiscounts);

  // ---- Logo (1-bit raster; 200x200px = 25mm wide at 203dpi) ----
  // The library thresholds pixels itself: opaque + dark -> black dot.
  try {
    const logoPath = app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'receipt-logo.png')
      : fs.existsSync(path.join(__dirname, 'assets', 'receipt-logo.png'))
        ? path.join(__dirname, 'assets', 'receipt-logo.png')
        : path.join(__dirname, 'frontend', 'src', 'assets', 'receipt-logo.png');
    if (fs.existsSync(logoPath)) {
      p.alignCenter();
      await p.printImage(logoPath);
      p.newLine();
    }
  } catch (logoErr) {
    console.error('Logo raster failed, printing text-only header:', logoErr.message);
  }

  // ---- Header ----
  p.alignCenter();
  p.setTextDoubleHeight();
  p.setTextDoubleWidth();
  p.bold(true);
  p.println('NOUMAN PHARMACY');
  p.setTextNormal();
  p.bold(false);
  p.println('Tel: 0327-8322014');
  p.println('noumanpharmacy12@gmail.com');
  p.drawLine();

  // ---- Barcode (native Code128, HRI text off, printed centred) ----
  const barcodeText = `INV-${cleanSaleId}`;
  const barcodeData = '{B' + barcodeText; // '{B' selects Code 128 code set B
  p.append(Buffer.from([0x1d, 0x68, 50]));  // GS h — barcode height (dots)
  p.append(Buffer.from([0x1d, 0x77, 2]));   // GS w — module width
  p.append(Buffer.from([0x1d, 0x48, 0]));   // GS H — no HRI text (we print our own)
  p.append(Buffer.concat([
    Buffer.from([0x1d, 0x6b, 73, barcodeData.length]), // GS k m=73 (CODE128)
    Buffer.from(barcodeData, 'ascii')
  ]));
  p.newLine();
  p.bold(true);
  p.println(barcodeText);
  p.bold(false);
  p.newLine();

  p.alignLeft();
  p.println(`Date: ${new Date(timestamp).toLocaleString('en-PK')}`);
  p.drawLine();

  // ---- Items table ----
  p.bold(true);
  p.println('Item'.padEnd(NAME_W) + 'Price'.padStart(PRICE_W) + 'Disc'.padStart(DISC_W) + 'Net'.padStart(NET_W));
  p.bold(false);
  p.drawLine();

  cartItems.forEach((i) => {
    const lineTotal = Math.round((i.price || 0) * (i.qty || 1));
    const itemDiscount = Math.round(i.itemDiscountAmount || 0);
    const afterItemDisc = lineTotal - itemDiscount;
    const globalShare = globalDiscountOnly > 0
      ? Math.round((afterItemDisc / subtotalAfterItemDisc) * globalDiscountOnly)
      : 0;
    const totalDiscForLine = itemDiscount + globalShare;
    const netTotal = lineTotal - totalDiscForLine;
    const sellType = i.type ? i.type.charAt(0).toUpperCase() : '';

    const nameLines = wrap(`${i.name || ''} (${sellType})x${i.qty || 1}`, NAME_W);
    const priceStr = `Rs.${lineTotal}`;
    const discStr = totalDiscForLine > 0 ? `-${totalDiscForLine}` : '-';
    const netStr = `Rs.${netTotal}`;

    p.println(nameLines[0].padEnd(NAME_W) + priceStr.padStart(PRICE_W) + discStr.padStart(DISC_W) + netStr.padStart(NET_W));
    for (let n = 1; n < nameLines.length; n++) p.println(nameLines[n]);
  });

  // ---- Totals ----
  p.drawLine();
  const itemCount = cartItems.reduce((s, i) => s + (parseInt(i.qty) || 1), 0);
  p.println(rightPair(`Items: ${itemCount}`, ''));
  p.println(rightPair('Subtotal', `Rs.${Math.round(subtotal)}`));
  if (Math.round(discountDeduction) > 0) {
    p.println(rightPair('Discount', `-Rs.${Math.round(discountDeduction)}`));
  }
  p.println('='.repeat(W));
  p.bold(true);
  p.setTextDoubleHeight();
  p.println(rightPair('NET PAID', `Rs.${Math.round(grandTotal)}`));
  p.setTextNormal();
  p.bold(false);
  p.println('='.repeat(W));

  // ---- Footer ----
  p.newLine();
  p.alignCenter();
  p.bold(true);
  p.println('Thank you for your visit!');
  p.bold(false);
  p.println('Return / Exchange only possible if original');
  p.println('receipt is presented within 3 days.');
  p.newLine();
  p.cut();          // full cut (matches the driver's "Full cut at Doc End")
  p.openCashDrawer(); // kick pulse — harmless if no drawer is attached

  return p.getBuffer();
}

// Writes an ESC/POS buffer to a Windows printer queue with the RAW datatype
// (bytes go straight to the printer, bypassing the driver's page renderer).
// Uses an inline PowerShell + winspool helper — no native Node modules.
function sendRawToPrinter(printerName, buffer) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(app.getPath('temp'), `pharm-receipt-${Date.now()}.bin`);
    try {
      fs.writeFileSync(tmpFile, buffer);
    } catch (e) {
      return reject(e);
    }

    // Single-quoted PS strings: escape embedded quotes by doubling them
    const psPrinter = printerName.replace(/'/g, "''");
    const psFile = tmpFile.replace(/'/g, "''");
    const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter")]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter")]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter")]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter")]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static bool Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return false;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "PharmTrack Receipt";
    di.pDataType = "RAW";
    bool ok = false;
    if (StartDocPrinter(h, 1, di)) {
      if (StartPagePrinter(h)) {
        IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, ptr, bytes.Length);
        int written;
        ok = WritePrinter(h, ptr, bytes.Length, out written) && written == bytes.Length;
        Marshal.FreeHGlobal(ptr);
        EndPagePrinter(h);
      }
      EndDocPrinter(h);
    }
    ClosePrinter(h);
    return ok;
  }
}
'@
$bytes = [System.IO.File]::ReadAllBytes('${psFile}')
if (-not [RawPrinter]::Send('${psPrinter}', $bytes)) { exit 2 }
exit 0
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    );

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => child.kill(), 20000);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      fs.unlink(tmpFile, () => {});
      if (code === 0) return resolve();
      // Drop PowerShell's CLIXML progress-stream noise from the error text
      const errText = stderr.replace(/#< CLIXML[\s\S]*/g, '').trim().slice(0, 300);
      reject(new Error(`Raw print helper exited with code ${code}${errText ? '. ' + errText : ' (printer not found or spooler refused the job).'}`));
    });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      fs.unlink(tmpFile, () => {});
      reject(e);
    });
  });
}

// Picks the receipt printer: explicit config first, then a thermal-looking
// name, then the OS default (unless the default is a document printer —
// raw ESC/POS bytes would just corrupt a PDF/XPS queue).
async function resolveReceiptPrinterName() {
  if (sysConfig.printerName) return sysConfig.printerName;
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const printers = await mainWindow.webContents.getPrintersAsync();
  const thermal = printers.find((pr) => /copper|thermal|80\s?mm|pos-?\d|receipt/i.test(pr.name));
  if (thermal) return thermal.name;
  const def = printers.find((pr) => pr.isDefault);
  if (def && !/pdf|xps|onenote|fax/i.test(def.name)) return def.name;
  return null;
}

// Primary print entry point: ESC/POS raw first, HTML window as fallback.
async function printReceipt(cleanSaleId, timestamp, cartItems, subtotal, discountDeduction, grandTotal) {
  try {
    const printerName = await resolveReceiptPrinterName();
    if (!printerName) throw new Error('No thermal/receipt printer found on this machine.');
    const buffer = await buildEscPosReceipt(cleanSaleId, timestamp, cartItems, subtotal, discountDeduction, grandTotal);
    await sendRawToPrinter(printerName, buffer);
    console.log(`Receipt INV-${cleanSaleId} printed via ESC/POS on "${printerName}" (${buffer.length} bytes).`);
  } catch (err) {
    console.error('ESC/POS print failed, falling back to HTML print:', err.message);
    triggerReceiptPrint(cleanSaleId, timestamp, cartItems, subtotal, discountDeduction, grandTotal);
  }
}

// =================================================================
// REPRINT (SERVER ONLY — rebuilds a receipt from sales_history)
// Pass a saleId ('sale-42' or '42') to reprint that invoice, or omit
// it to reprint the most recent sale. Returns are not reprintable.
// =================================================================
function printSaleById(saleId, callback) {
  if (!db) return callback({ success: false, message: 'No database on this machine.' });

  // Accept '42', 'INV-42' or 'sale-42' from the caller
  const normalisedId = saleId
    ? `sale-${saleId.toString().trim().replace(/^(inv-|sale-)/i, '')}`
    : null;

  const sql = normalisedId
    ? `SELECT * FROM sales_history WHERE id = ?`
    : `SELECT * FROM sales_history WHERE id LIKE 'sale-%' ORDER BY datetime(timestamp) DESC LIMIT 1`;

  db.get(sql, normalisedId ? [normalisedId] : [], (err, row) => {
    if (err) return callback({ success: false, message: err.message });
    if (!row) return callback({ success: false, message: 'No receipt found to reprint.' });

    let items;
    try {
      items = JSON.parse(row.itemsJson || '[]');
    } catch (parseErr) {
      return callback({ success: false, message: 'Receipt data is corrupted and cannot be reprinted.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return callback({ success: false, message: 'This receipt has no line items.' });
    }

    const cleanSaleId = row.id.replace('sale-', '');
    printReceipt(cleanSaleId, row.timestamp, items, row.subtotal, row.discountDeduction, row.grandTotal);
    callback({ success: true, saleId: cleanSaleId });
  });
}

// =================================================================
// WINDOW CREATION
// =================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    }
  });

  mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('devtools-opened', () => {
    if (app.isPackaged) mainWindow.webContents.closeDevTools();
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, 'frontend/dist/index.html'));
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

let isDbClosed = false;
app.on('before-quit', (e) => {
  if (isDbClosed) return;

  if (expressServer) {
    expressServer.close();
  }

  if (db) {
    e.preventDefault();
    db.close((err) => {
      if (err) console.error('Error closing database:', err);
      isDbClosed = true;
      app.quit();
    });
  }
});

// =================================================================
// DEVELOPER SETTINGS IPC HANDLERS
// These are used by the hidden 7-tap developer screen
// =================================================================

// Returns current config so the UI can show current settings
ipcMain.handle('getSystemConfig', async () => {
  return {
    mode: sysConfig.mode,
    serverIp: sysConfig.serverIp,
    serverPort: sysConfig.serverPort,
    hasDevPassword: !!sysConfig.devPasswordHash,
    // Shown in the (password-protected) dev screen so it can be copied to
    // each client machine.
    apiToken: sysConfig.apiToken || ''
  };
});

// Verify the developer password before showing the config screen
ipcMain.handle('verifyDevPassword', async (event, password) => {
  if (!sysConfig.devPasswordHash) {
    // No password set yet — this is first-time setup, allow access
    return { success: true, firstTime: true };
  }
  const match = bcrypt.compareSync(password, sysConfig.devPasswordHash);
  return { success: match };
});

// Save network config and optionally set/change the dev password
ipcMain.handle('saveSystemConfig', async (event, payload) => {
  const { mode, serverIp, serverPort, newDevPassword, apiToken } = payload;

  const updatedConfig = {
    ...sysConfig,
    mode: mode || 'server',
    serverIp: (serverIp || '').trim(),
    serverPort: serverPort || '3847',
    apiToken: (apiToken || '').trim(),
  };

  if (newDevPassword && newDevPassword.length >= 4) {
    updatedConfig.devPasswordHash = bcrypt.hashSync(newDevPassword, 10);
  }

  // Optional: exact Windows printer name for ESC/POS receipts ('' = auto-detect)
  if (typeof payload.printerName === 'string') {
    updatedConfig.printerName = payload.printerName.trim();
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// Generates a strong shared secret for the API. Used by the dev screen's
// "Generate" button on the server machine; copy the value to each client.
ipcMain.handle('generateApiToken', async () => {
  return require('crypto').randomBytes(24).toString('hex');
});

// Test connection from client to server
ipcMain.handle('testServerConnection', async (event, { serverIp, serverPort, apiToken }) => {
  return new Promise((resolve) => {
    const options = {
      hostname: serverIp,
      port: parseInt(serverPort) || 3847,
      // Hit an authenticated route so a wrong/missing token is caught HERE,
      // in the dev screen, rather than at the till mid-sale.
      path: '/api/status',
      method: 'GET',
      timeout: 5000,
      headers: apiToken ? { 'x-api-token': apiToken } : {}
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401) {
          return resolve({ success: false, message: 'Server reached, but the security token does not match the server\'s.' });
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === 'online' || parsed.status === 'busy') {
            resolve({ success: true, message: `Connected! Server is ${parsed.status}.` });
          } else {
            resolve({ success: false, message: 'Connected, but invalid API response.' });
          }
        } catch (e) {
          // Fails properly if the device returns HTML instead of JSON
          resolve({ success: false, message: 'Invalid response. Check if IP belongs to a router or wrong device.' });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, message: `Cannot reach server: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, message: 'Connection timed out. Check the IP and port.' }); });
    req.end();
  });
});

// Restart the app after config is saved
ipcMain.handle('restartApp', async () => {
  app.relaunch();
  app.exit(0);
});

// =================================================================
// BACKUP & RESTORE IPC HANDLERS
// =================================================================

// Export (backup) the current database to a user-chosen location
ipcMain.handle('exportDatabase', async () => {
  if (IS_CLIENT) return { success: false, message: 'Backups can only be created on the server machine.' };

  const dateStr = new Date().toISOString().split('T')[0]; // e.g. 2025-01-15
  const defaultName = `pharmacy-backup-${dateStr}.db`;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Database Backup',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'Database Backup', extensions: ['db'] }]
  });

  if (result.canceled || !result.filePath) return { success: false, message: 'Backup cancelled.' };

  try {
    // Get current db path
    let dbPath = path.join(app.getPath('userData'), 'pharmacy.db');
    if (!app.isPackaged && fs.existsSync(path.join(__dirname, 'pharmacy.db'))) {
      dbPath = path.join(__dirname, 'pharmacy.db');
    }

    // We run in WAL mode, so recently committed sales live in pharmacy.db-wal
    // and are NOT in the .db file yet. Copying without this checkpoint produced
    // backups that silently missed the most recent transactions.
    await new Promise((resolve) => {
      if (!db) return resolve();
      db.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
        if (err) console.error('WAL checkpoint before backup failed:', err.message);
        resolve();
      });
    });

    fs.copyFileSync(dbPath, result.filePath);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, message: `Backup failed: ${err.message}` };
  }
});

// Open the backup file in the file explorer so user can attach it to email
ipcMain.handle('revealBackupInFolder', async (event, filePath) => {
  shell.showItemInFolder(filePath);
  return { success: true };
});

// Open default mail client with pre-filled recipient and subject
ipcMain.handle('openEmailWithBackup', async (event, { filePath, devEmail }) => {
  const dateStr = new Date().toISOString().split('T')[0];
  const subject = encodeURIComponent(`Pharmacy DB Backup - ${dateStr}`);
  const body = encodeURIComponent(`Daily backup attached.\n\nDate: ${dateStr}\nFile: ${path.basename(filePath)}`);
  const mailto = `mailto:${devEmail || ''}?subject=${subject}&body=${body}`;
  shell.openExternal(mailto);
  // Also reveal file so they can manually attach it
  shell.showItemInFolder(filePath);
  return { success: true };
});

// Import (restore) a backup database file — only accessible from the developer screen
ipcMain.handle('importDatabase', async () => {
  if (IS_CLIENT) return { success: false, message: 'Database restore can only be done on the server machine.' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup File to Restore',
    filters: [{ name: 'Database Backup', extensions: ['db'] }],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return { success: false, message: 'Import cancelled.' };

  const sourcePath = result.filePaths[0];

  // Verify it's a valid SQLite file
  try {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(sourcePath, 'r');
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (!header.toString('utf8', 0, 15).startsWith('SQLite format 3')) {
      return { success: false, message: 'Invalid file. This does not appear to be a valid database backup.' };
    }
  } catch (err) {
    return { success: false, message: `Cannot read file: ${err.message}` };
  }

  let dbPath = path.join(app.getPath('userData'), 'pharmacy.db');

  try {
    // Close the current database connection first
    await new Promise((resolve) => {
      if (db) {
        db.close(() => { isDbClosed = true; resolve(); });
      } else {
        resolve();
      }
    });

    // Make a safety copy of the current db before overwriting
    const safetyCopyPath = dbPath + '.before-import.bak';
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, safetyCopyPath);
    }

    // Replace with the backup
    fs.copyFileSync(sourcePath, dbPath);

    // Drop the OLD database's write-ahead log. Left in place, SQLite would
    // replay the previous db's WAL on top of the restored backup and corrupt
    // it. The backup file is self-contained, so these must go.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = dbPath + suffix;
      try {
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      } catch (unlinkErr) {
        console.error(`Could not remove ${sidecar}:`, unlinkErr.message);
      }
    }

    return { success: true, message: 'Database restored successfully. The app will now restart.' };
  } catch (err) {
    return { success: false, message: `Restore failed: ${err.message}` };
  }
});

// =================================================================
// STANDARD IPC HANDLERS (Used when in SERVER mode via IPC)
// Client mode uses HTTP instead of these — see preload.js
// =================================================================
let terminalFailedAttempts = 0;
let vaultFailedAttempts = 0;

// Tracks whether a checkout transaction is currently in progress.
// The status endpoint exposes this so client machines can show
// an "amber / busy" indicator instead of just green/red.
let isSystemBusy = false;

// Status check — used by the client heartbeat ping every 5 seconds.
// On a server machine this answers directly. On a client it makes
// a lightweight HTTP call to the server's /api/status endpoint.
ipcMain.handle('checkServerStatus', async () => {
  if (IS_SERVER) {
    return { status: isSystemBusy ? 'busy' : 'online' };
  }
  // Client machine — ping the server
  return new Promise((resolve) => {
    const options = {
      hostname: sysConfig.serverIp,
      port: parseInt(sysConfig.serverPort) || 3847,
      path: '/api/status',
      method: 'GET',
      timeout: 4000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ status: 'offline' }); }
      });
    });
    req.on('error', () => resolve({ status: 'offline' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'offline' }); });
    req.end();
  });
});

ipcMain.handle('authenticateTerminal', async (event, credentials) => {
  if (terminalFailedAttempts >= 3) return { success: false, message: 'Terminal permanently locked for this session. Restart required.' };
  if (!credentials || !credentials.username) return { success: false, message: 'Invalid credentials payload.' };

  if (IS_CLIENT) {
    // Route to server
    return networkCall('POST', '/api/auth/terminal', { username: credentials.username, password: credentials.password }, sysConfig);
  }

  return new Promise((resolve, reject) => {
    db.get(`SELECT username, password FROM credentials WHERE role = 'terminal'`, [], (err, row) => {
      if (err) return reject(err);
      if (row) {
        const storedUsername = row.username || 'admin';
        if (credentials.username.toLowerCase() === storedUsername.toLowerCase()) {
          let isMatch = row.password.startsWith('$2') ? bcrypt.compareSync(credentials.password, row.password) : row.password === credentials.password;
          if (isMatch && !row.password.startsWith('$2')) db.run(`UPDATE credentials SET password=? WHERE role='terminal'`, [bcrypt.hashSync(credentials.password, 10)]);
          if (isMatch) { terminalFailedAttempts = 0; return resolve({ success: true }); }
        }
      }
      terminalFailedAttempts++;
      resolve({ success: false, message: 'Invalid administrative terminal credentials.' });
    });
  });
});

ipcMain.handle('authenticateVault', async (event, pin) => {
  if (vaultFailedAttempts >= 3) return { success: false, message: 'Vault permanently locked for this session. Restart required.' };

  if (IS_CLIENT) {
    return networkCall('POST', '/api/auth/vault', { pin }, sysConfig);
  }

  return new Promise((resolve, reject) => {
    db.get(`SELECT password FROM credentials WHERE role = 'vault'`, [], (err, row) => {
      if (err) return reject(err);
      if (row) {
        let isMatch = row.password.startsWith('$2') ? bcrypt.compareSync(pin, row.password) : row.password === pin;
        if (isMatch && !row.password.startsWith('$2')) db.run(`UPDATE credentials SET password=? WHERE role='vault'`, [bcrypt.hashSync(pin, 10)]);
        if (isMatch) { vaultFailedAttempts = 0; return resolve({ success: true }); }
      }
      vaultFailedAttempts++;
      resolve({ success: false, message: 'Invalid master vault PIN.' });
    });
  });
});

ipcMain.handle('updateTerminalUsername', async (event, { newUsername }) => {
  if (!newUsername || newUsername.trim().length < 3) return { success: false, message: 'Username must be at least 3 characters.' };
  return new Promise((resolve) => {
    db.run(`UPDATE credentials SET username = ? WHERE role = 'terminal'`, [newUsername.trim().toLowerCase()], function (err) {
      if (err) return resolve({ success: false, message: 'Database error.' });
      resolve({ success: true, message: 'Username updated successfully!' });
    });
  });
});

ipcMain.handle('updateTerminalPassword', async (event, { oldPassword, newPassword }) => {
  if (!newPassword || newPassword.trim().length < 4) return { success: false, message: 'New password must be at least 4 characters.' };
  return new Promise((resolve) => {
    db.get(`SELECT password FROM credentials WHERE role = 'terminal'`, [], (err, row) => {
      if (err || !row) return resolve({ success: false, message: 'Database error.' });
      let isMatch = row.password.startsWith('$2') ? bcrypt.compareSync(oldPassword, row.password) : row.password === oldPassword;
      if (!isMatch) return resolve({ success: false, message: 'Incorrect current password.' });
      db.run(`UPDATE credentials SET password=? WHERE role='terminal'`, [bcrypt.hashSync(newPassword, 10)], function (err) {
        if (err) return resolve({ success: false, message: 'Failed to update password.' });
        resolve({ success: true, message: 'Password updated successfully!' });
      });
    });
  });
});

ipcMain.handle('updateVaultPassword', async (event, payload) => {
  const { oldPin, newPin } = payload || {};
  if (!oldPin || !newPin) return { success: false, message: 'Missing credentials.' };
  if (!/^\d{4,8}$/.test(newPin)) return { success: false, message: 'PIN must be 4 to 8 digits.' };

  return new Promise((resolve, reject) => {
    db.get(`SELECT password FROM credentials WHERE role = 'vault'`, [], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve({ success: false, message: 'Vault profile not found.' });
      let isMatch = row.password.startsWith('$2') ? bcrypt.compareSync(oldPin, row.password) : row.password === oldPin;
      if (!isMatch) return resolve({ success: false, message: 'Current PIN is incorrect.' });
      db.run(`UPDATE credentials SET password=? WHERE role='vault'`, [bcrypt.hashSync(newPin, 10)], function (err) {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  });
});

ipcMain.handle('getInventory', async () => {
  if (IS_CLIENT) return networkCall('GET', '/api/inventory', null, sysConfig);
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM inventory WHERE is_active = 1 ORDER BY datetime(intake_time) DESC, id DESC`, [], (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
});

ipcMain.handle('getProductsByBarcode', async (event, barcode) => {
  if (IS_CLIENT) return networkCall('GET', `/api/inventory/barcode/${encodeURIComponent(barcode)}`, null, sysConfig);
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM inventory WHERE barcode = ? AND is_active = 1`, [barcode], (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
});

ipcMain.handle('getProductByBarcode', async (event, barcode) => {
  if (IS_CLIENT) {
    const rows = await networkCall('GET', `/api/inventory/barcode/${encodeURIComponent(barcode)}`, null, sysConfig);
    return Array.isArray(rows) ? rows[0] : null;
  }
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM inventory WHERE barcode = ? AND is_active = 1 LIMIT 1`, [barcode], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
});

ipcMain.handle('addInventory', async (event, newItem) => {
  if (IS_CLIENT) return networkCall('POST', '/api/inventory', newItem, sysConfig);
  return new Promise((resolve, reject) => {
    const ts = new Date().toISOString();
    db.run(
      `INSERT INTO inventory (barcode, name, generic, batch, expiry, totalUnits, factor, buyingPrice, retailPrice, category, intake_time, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      [newItem.barcode || '', newItem.name, newItem.generic, newItem.batch, newItem.expiry, newItem.totalUnits, newItem.factor, newItem.buyingPrice, newItem.retailPrice, newItem.category, ts],
      function (err) { if (err) reject(err); else resolve({ success: true, id: this.lastID.toString() }); }
    );
  });
});

ipcMain.handle('updateInventory', async (event, item) => {
  if (IS_CLIENT) return networkCall('PUT', `/api/inventory/${item.id}`, item, sysConfig);
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE inventory SET barcode=?,name=?,generic=?,batch=?,expiry=?,totalUnits=?,factor=?,buyingPrice=?,retailPrice=?,category=? WHERE id=?`,
      [item.barcode || '', item.name, item.generic, item.batch, item.expiry, parseInt(item.totalUnits) || 0, parseInt(item.factor) || 10, parseFloat(item.buyingPrice) || 0, parseFloat(item.retailPrice) || 0, item.category, item.id.toString()],
      function (err) { if (err) reject(err); else resolve({ success: true }); }
    );
  });
});

ipcMain.handle('searchInventory', async (event, query) => {
  if (IS_CLIENT) return networkCall('GET', `/api/inventory/search?q=${encodeURIComponent(query)}`, null, sysConfig);
  return new Promise((resolve, reject) => {
    const pattern = `%${query.toLowerCase()}%`;
    db.all(
      `SELECT * FROM inventory WHERE is_active = 1 AND (LOWER(name) LIKE ? OR LOWER(generic) LIKE ? OR LOWER(batch) LIKE ? OR barcode = ?) ORDER BY name ASC LIMIT 10`,
      [pattern, pattern, pattern, query],
      (err, rows) => { if (err) reject(err); else resolve(rows); }
    );
  });
});

ipcMain.handle('deleteInventory', async (event, itemId) => {
  if (IS_CLIENT) return networkCall('DELETE', `/api/inventory/${itemId}`, null, sysConfig);
  return new Promise((resolve, reject) => {
    db.run(`UPDATE inventory SET is_active = 0 WHERE id = ?`, [itemId.toString()], function (err) {
      if (err) reject(err); else resolve({ success: true });
    });
  });
});

ipcMain.handle('getSalesHistory', async () => {
  if (IS_CLIENT) return networkCall('GET', '/api/sales', null, sysConfig);
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM sales_history ORDER BY timestamp DESC`, [], (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
});

ipcMain.handle('searchSalesHistory', async (event, query) => {
  if (IS_CLIENT) return networkCall('GET', `/api/sales/search?q=${encodeURIComponent(query || '')}`, null, sysConfig);
  return new Promise((resolve, reject) => {
    if (!query || query.trim() === '') {
      return db.all(`SELECT * FROM sales_history ORDER BY timestamp DESC`, [], (err, rows) => {
        if (err) reject(err); else resolve(rows);
      });
    }
    let q = query.trim().toLowerCase().replace(/^inv-/, '').replace(/^sale-/, '').replace(/^ret-/, '');
    db.all(
      `SELECT * FROM sales_history WHERE LOWER(id) LIKE ? OR CAST(SUBSTR(id, 6) AS TEXT) = ? ORDER BY timestamp DESC`,
      [`%${q}%`, q],
      (err, rows) => { if (err) reject(err); else resolve(rows); }
    );
  });
});

// =================================================================
// WRITE-TRANSACTION QUEUE
// =================================================================
// We have ONE shared sqlite3 connection, and SQLite allows only one
// transaction per connection. db.serialize() only orders statements issued
// synchronously inside its callback — checkout/return continue inside async
// db.get/db.run callbacks, so two concurrent requests used to interleave:
// the second BEGIN failed, and that request's ROLLBACK aborted the FIRST
// request's transaction (sale committed to nothing, but a receipt printed).
// Every write transaction now runs one-at-a-time through this queue.
let writeQueue = Promise.resolve();

function queueWrite(work) {
  const next = writeQueue.then(() => new Promise((resolve, reject) => {
    let settled = false;
    const guard = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    // Safety net: a handler that never settles must not deadlock the queue.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error('Write transaction timed out; releasing queue.');
      db.run('ROLLBACK', () => {});
      isSystemBusy = false;
      reject(new Error('The database was busy for too long. Please try again.'));
    }, 20000);

    try {
      work(guard(resolve), guard(reject));
    } catch (e) {
      guard(reject)(e);
    }
  }));
  // Keep the chain alive even when a transaction fails.
  writeQueue = next.then(() => {}, () => {});
  return next;
}

// Shared by the IPC handler and the HTTP endpoint so server and client
// machines behave identically.
function performCheckout(payload) {
  const cartItems = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.cart) ? payload.cart : null);

  if (!cartItems || cartItems.length === 0) {
    const e = new Error('Invalid basket payload.');
    e.statusCode = 400;
    return Promise.reject(e);
  }

  const subtotal = parseFloat(payload.subtotal) || 0;
  const discountPercent = parseFloat(payload.discountPercent) || 0;
  const discountDeduction = parseFloat(payload.discountDeduction) || 0;
  const grandTotal = parseFloat(payload.grandTotal) || 0;
  const timestamp = new Date().toISOString();

  return queueWrite((resolve, reject) => {
    isSystemBusy = true;
    const done = (fn) => (arg) => { isSystemBusy = false; fn(arg); };
    const succeed = done(resolve);
    const failNoTx = done(reject);
    const fail = (err) => db.run('ROLLBACK', () => failNoTx(err));

    db.run('BEGIN IMMEDIATE', (beginErr) => {
      if (beginErr) return failNoTx(beginErr);

      db.get(
        `SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) as maxId FROM sales_history WHERE id LIKE 'sale-%'`,
        [],
        (err, row) => {
          if (err) return fail(err);

          const saleId = `sale-${((row && row.maxId) ? parseInt(row.maxId) : 0) + 1}`;
          const cleanSaleId = saleId.replace('sale-', '');

          db.run(
            `INSERT INTO sales_history (id, timestamp, itemsJson, subtotal, discountPercent, discountDeduction, grandTotal) VALUES (?,?,?,?,?,?,?)`,
            [saleId, timestamp, JSON.stringify(cartItems), subtotal, discountPercent, discountDeduction, grandTotal],
            function (insertErr) {
              if (insertErr) return fail(insertErr);

              const stmt = db.prepare(`UPDATE inventory SET totalUnits = totalUnits - ? WHERE id = ? AND totalUnits >= ?`);
              let shortItem = null;
              cartItems.forEach((item) => {
                const units = (parseInt(item.rawUnits) || 0) * (parseInt(item.qty) || 0);
                if (units <= 0 || !item.productId) return;
                stmt.run([units, item.productId.toString(), units], function (stmtErr) {
                  if (stmtErr || this.changes === 0) shortItem = shortItem || (item.name || 'an item');
                });
              });

              stmt.finalize((finalizeErr) => {
                if (finalizeErr || shortItem) {
                  // Name the offending product — the old message never did.
                  const e = new Error(
                    finalizeErr ? finalizeErr.message : `Insufficient stock for "${shortItem}". The sale was not saved.`
                  );
                  e.statusCode = finalizeErr ? 500 : 409;
                  return fail(e);
                }
                db.run('COMMIT', (commitErr) => {
                  if (commitErr) return fail(commitErr);
                  printReceipt(cleanSaleId, timestamp, cartItems, subtotal, discountDeduction, grandTotal);
                  succeed({ success: true, saleId: cleanSaleId });
                });
              });
            }
          );
        }
      );
    });
  });
}

// Relative restock: "add N units" instead of "set total to N".
// The UI used to send snapshot + delta as an absolute value, so a restock
// computed from a 5s-old poll silently erased any sale made in between.
// Doing the arithmetic in SQL makes concurrent sales and restocks compose.
function performRestock(payload) {
  const { id, unitsToAdd } = payload || {};
  const units = parseInt(unitsToAdd) || 0;

  if (!id || units <= 0) {
    const e = new Error('Invalid restock request.');
    e.statusCode = 400;
    return Promise.reject(e);
  }

  return queueWrite((resolve, reject) => {
    db.run(
      `UPDATE inventory SET totalUnits = totalUnits + ?, is_active = 1 WHERE id = ?`,
      [units, id.toString()],
      function (err) {
        if (err) return reject(err);
        if (this.changes === 0) {
          const e = new Error('Product not found.');
          e.statusCode = 404;
          return reject(e);
        }
        resolve({ success: true, unitsAdded: units });
      }
    );
  });
}

function performReturn(payload) {
  const {
    saleId, returnItems = [], remainingItemsJson, returnedItemsJson,
    newGrandTotal, newSubtotal, newDiscountDeduction, deleteEntireSale, refundAmount
  } = payload || {};

  if (!saleId) {
    const e = new Error('Missing sale reference for return.');
    e.statusCode = 400;
    return Promise.reject(e);
  }

  return queueWrite((resolve, reject) => {
    const fail = (err) => db.run('ROLLBACK', () => reject(err));

    db.run('BEGIN IMMEDIATE', (beginErr) => {
      if (beginErr) return reject(beginErr);

      const stmt = db.prepare(`UPDATE inventory SET totalUnits = totalUnits + ?, is_active = 1 WHERE id = ?`);
      let restockErr = null;
      returnItems.forEach((item) => {
        const targetId = item.productId || item.id;
        if (!targetId) return;
        stmt.run([parseInt(item.unitsToReturn) || 0, targetId.toString()], function (err) {
          if (err) restockErr = restockErr || err;
        });
      });

      stmt.finalize((finErr) => {
        if (finErr || restockErr) return fail(new Error('Failed to restock returned items.'));

        // Unique per return: timestamp + random suffix. The HTTP path used to
        // omit the random part, so two returns on one sale inside the same
        // 10s window could collide on the PRIMARY KEY.
        const returnId = `RET-${saleId.replace('sale-', '')}-${Date.now().toString().slice(-4)}-${Math.floor(Math.random() * 1000)}`;
        const timestamp = new Date().toISOString();

        db.run(
          `INSERT INTO sales_history (id, timestamp, itemsJson, subtotal, discountPercent, discountDeduction, grandTotal) VALUES (?,?,?,?,?,?,?)`,
          [returnId, timestamp, returnedItemsJson, 0, 0, 0, -Math.abs(refundAmount)],
          function (insertErr) {
            if (insertErr) return fail(insertErr);

            const finishTx = (deleted) => db.run('COMMIT', (commitErr) => {
              if (commitErr) return fail(commitErr);
              resolve({ success: true, deleted });
            });

            if (deleteEntireSale) {
              db.run(`DELETE FROM sales_history WHERE id = ?`, [saleId], (delErr) => {
                if (delErr) return fail(delErr);
                finishTx(true);
              });
            } else {
              db.run(
                `UPDATE sales_history SET itemsJson=?, subtotal=?, discountDeduction=?, grandTotal=? WHERE id=?`,
                [remainingItemsJson, newSubtotal, newDiscountDeduction, newGrandTotal, saleId],
                (updErr) => {
                  if (updErr) return fail(updErr);
                  finishTx(false);
                }
              );
            }
          }
        );
      });
    });
  });
}

// Reprint a receipt. Omit saleId to reprint the most recent sale.
// On a client machine this asks the server to print (printer is on the server).
ipcMain.handle('reprintReceipt', async (event, saleId) => {
  if (IS_CLIENT) {
    try {
      return await networkCall('POST', '/api/reprint', { saleId: saleId || null }, sysConfig);
    } catch (e) {
      // networkCall rejects on HTTP >= 400, so surface a readable message
      return { success: false, message: e.message };
    }
  }
  return new Promise((resolve) => printSaleById(saleId || null, resolve));
});

// Checkout / return run the SAME queued transaction as the HTTP endpoints.
ipcMain.handle('process-checkout', async (event, payload) => {
  if (IS_CLIENT) return networkCall('POST', '/api/checkout', payload, sysConfig);
  return performCheckout(payload);
});

ipcMain.handle('returnSaleItem', async (event, payload) => {
  if (IS_CLIENT) return networkCall('POST', '/api/return', payload, sysConfig);
  return performReturn(payload);
});

// Adds units to existing stock without clobbering concurrent sales.
ipcMain.handle('restockInventory', async (event, payload) => {
  if (IS_CLIENT) {
    return networkCall('POST', `/api/inventory/${payload.id}/restock`, { unitsToAdd: payload.unitsToAdd }, sysConfig);
  }
  return performRestock(payload);
});

// =================================================================
// NETWORK HELPER — used by client mode to call the server
// =================================================================
function networkCall(method, endpoint, body, config) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: config.serverIp,
      port: parseInt(config.serverPort) || 3847,
      path: endpoint,
      method: method,
      // Checkout waits on the server's write queue behind other cashiers, so
      // this must be comfortably longer than the queue's 20s safety timeout —
      // a client that gave up at 8s while the server committed caused
      // duplicate sales when the cashier retried.
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      }
    };
    if (config.apiToken) options.headers['x-api-token'] = config.apiToken;
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* handled below */ }

        if (res.statusCode >= 400) {
          // Use the server's own message ("Insufficient stock for X") rather
          // than a bare "HTTP 409" — client machines showed the useless code.
          const serverMsg = parsed && (parsed.error || parsed.message);
          const err = new Error(serverMsg || `Server returned HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        if (parsed === null) return reject(new Error('Invalid response from server.'));
        resolve(parsed);
      });
    });
    req.on('error', (err) => reject(new Error(`Server unreachable: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Server connection timed out. Is the main PC on?')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}