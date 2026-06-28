const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { app, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const http = require('http');

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
  devPasswordHash: ''    // Bcrypt hash of the developer password
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

  // Simple auth middleware — every client request must include the shared secret
  // This is your DEV PASSWORD (the one used to access developer settings)
  // It ensures only your own app instances can talk to the server, not random devices on the LAN
  expressApp.use((req, res, next) => {
    if (req.path === '/api/health') return next(); // health check is public
    const key = req.headers['x-pharmtrack-key'];
    if (!key || !sysConfig.devPasswordHash || !bcrypt.compareSync(key, sysConfig.devPasswordHash)) {
      // If no dev password is set yet, allow connections (first-time setup)
      if (!sysConfig.devPasswordHash) return next();
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // Health / status endpoint — used by client heartbeat and "Test Connection" button
  expressApp.get('/api/health', (req, res) => {
    res.json({ status: 'ok', mode: 'server', version: '1.4' });
  });

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

  expressApp.post('/api/checkout', (req, res) => {
    const payload = req.body;
    let cartItems = Array.isArray(payload) ? payload : (Array.isArray(payload.cart) ? payload.cart : null);
    if (!cartItems || cartItems.length === 0) return res.status(400).json({ error: 'Invalid basket payload.' });

    const subtotal = parseFloat(payload.subtotal) || 0;
    const discountPercent = parseFloat(payload.discountPercent) || 0;
    const discountDeduction = parseFloat(payload.discountDeduction) || 0;
    const grandTotal = parseFloat(payload.grandTotal) || 0;
    const timestamp = new Date().toISOString();

    db.serialize(() => {
      isSystemBusy = true;
      db.run('BEGIN IMMEDIATE', (err) => { if (err) { isSystemBusy = false; return res.status(500).json({ error: err.message }); } });

      db.get(`SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) as maxId FROM sales_history WHERE id LIKE 'sale-%'`, [], (err, row) => {
        if (err) { isSystemBusy = false; db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }

        const saleId = `sale-${((row && row.maxId) ? parseInt(row.maxId) : 0) + 1}`;
        const cleanSaleId = saleId.replace('sale-', '');

        db.run(
          `INSERT INTO sales_history (id, timestamp, itemsJson, subtotal, discountPercent, discountDeduction, grandTotal) VALUES (?,?,?,?,?,?,?)`,
          [saleId, timestamp, JSON.stringify(cartItems), subtotal, discountPercent, discountDeduction, grandTotal],
          function (insertErr) {
            if (insertErr) { db.run('ROLLBACK'); return res.status(500).json({ error: insertErr.message }); }

            const stmt = db.prepare(`UPDATE inventory SET totalUnits = totalUnits - ? WHERE id = ? AND totalUnits >= ?`);
            let errorOccurred = false;
            cartItems.forEach((item) => {
              const units = (parseInt(item.rawUnits) || 0) * (parseInt(item.qty) || 0);
              if (units <= 0 || !item.productId) return;
              stmt.run([units, item.productId.toString(), units], function (stmtErr) {
                if (stmtErr || this.changes === 0) errorOccurred = true;
              });
            });

            stmt.finalize((finalizeErr) => {
              if (finalizeErr || errorOccurred) {
                db.run('ROLLBACK', () => { isSystemBusy = false; res.status(409).json({ error: 'Insufficient stock for one or more items.' }); });
              } else {
                db.run('COMMIT', () => {
                  isSystemBusy = false;
                  // Trigger receipt printing on the server machine
                  triggerReceiptPrint(cleanSaleId, timestamp, cartItems, subtotal, discountDeduction, grandTotal);
                  res.json({ success: true, saleId: cleanSaleId });
                });
              }
            });
          }
        );
      });
    });
  });

  expressApp.post('/api/return', (req, res) => {
    const payload = req.body;
    const { saleId, returnItems = [], remainingItemsJson, returnedItemsJson, newGrandTotal, newSubtotal, newDiscountDeduction, deleteEntireSale, refundAmount } = payload;

    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (err) => { if (err) return res.status(500).json({ error: err.message }); });

      const stmt = db.prepare(`UPDATE inventory SET totalUnits = totalUnits + ?, is_active = 1 WHERE id = ?`);
      let errorOccurred = false;
      returnItems.forEach((item) => {
        const targetId = item.productId || item.id;
        if (targetId) {
          stmt.run([parseInt(item.unitsToReturn) || 0, targetId.toString()], function (err) {
            if (err) errorOccurred = true;
          });
        }
      });

      stmt.finalize((err) => {
        if (err || errorOccurred) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Failed to restock items.' }); }

        const returnId = `RET-${saleId.replace('sale-', '')}-${Date.now().toString().slice(-4)}`;
        const timestamp = new Date().toISOString();

        db.run(
          `INSERT INTO sales_history (id, timestamp, itemsJson, subtotal, discountPercent, discountDeduction, grandTotal) VALUES (?,?,?,?,?,?,?)`,
          [returnId, timestamp, returnedItemsJson, 0, 0, 0, -Math.abs(refundAmount)],
          function (insertErr) {
            if (insertErr) { db.run('ROLLBACK'); return res.status(500).json({ error: insertErr.message }); }

            if (deleteEntireSale) {
              db.run(`DELETE FROM sales_history WHERE id = ?`, [saleId], function (delErr) {
                if (delErr) { db.run('ROLLBACK'); return res.status(500).json({ error: delErr.message }); }
                db.run('COMMIT');
                res.json({ success: true, deleted: true });
              });
            } else {
              db.run(
                `UPDATE sales_history SET itemsJson=?, subtotal=?, discountDeduction=?, grandTotal=? WHERE id=?`,
                [remainingItemsJson, newSubtotal, newDiscountDeduction, newGrandTotal, saleId],
                function (updErr) {
                  if (updErr) { db.run('ROLLBACK'); return res.status(500).json({ error: updErr.message }); }
                  db.run('COMMIT');
                  res.json({ success: true, deleted: false });
                }
              );
            }
          }
        );
      });
    });
  });

  expressApp.post('/api/auth/terminal', (req, res) => {
    const { username, password } = req.body || {};
    if (!username) return res.json({ success: false, message: 'Invalid credentials.' });
    db.get(`SELECT username, password FROM credentials WHERE role = 'terminal'`, [], (err, row) => {
      if (err || !row) return res.json({ success: false, message: 'Auth service error.' });
      const storedUsername = row.username || 'admin';
      if (username.toLowerCase() !== storedUsername.toLowerCase()) return res.json({ success: false, message: 'Invalid credentials.' });
      let isMatch = row.password.startsWith('$2') ? bcrypt.compareSync(password, row.password) : row.password === password;
      if (isMatch && !row.password.startsWith('$2')) db.run(`UPDATE credentials SET password=? WHERE role='terminal'`, [bcrypt.hashSync(password, 10)]);
      res.json(isMatch ? { success: true } : { success: false, message: 'Invalid credentials.' });
    });
  });

  expressApp.post('/api/auth/vault', (req, res) => {
    const { pin } = req.body || {};
    db.get(`SELECT password FROM credentials WHERE role = 'vault'`, [], (err, row) => {
      if (err || !row) return res.json({ success: false, message: 'Auth service error.' });
      let isMatch = row.password.startsWith('$2') ? bcrypt.compareSync(pin, row.password) : row.password === pin;
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
                    ${isLast ? '' : 'border-bottom:1px dotted #ccc;'}
                    font-size:11px;">
          <span style="width:40%;word-break:break-all;font-weight:bold;">
            ${escapeHtml(i.name)}
            <span style="font-weight:normal;font-size:9px;"> (${sellType}) x${escapeHtml(i.qty)}</span>
          </span>
          <span style="width:20%;text-align:right;">Rs.${lineTotal}</span>
          <span style="width:20%;text-align:right;color:#c00;">
            ${totalDiscForLine > 0 ? `-${totalDiscForLine}` : '-'}
          </span>
          <span style="width:20%;text-align:right;font-weight:bold;">Rs.${netTotal}</span>
        </div>`;
    }).join('');

    const globalDiscountRows = '';

    const receiptHtml = `<html><head><meta charset="utf-8"/><style>
      body{font-family:'Courier New',monospace;font-size:13px;width:58mm;padding:6px;color:#000;margin:0;}
      .tc{text-align:center;}
      .rj{display:flex;justify-content:space-between;}
      .bc{margin:8px 0 2px 0;text-align:center;}
      .bc svg{width:88%;max-height:44px;}
      .id{font-size:11px;font-weight:bold;text-align:center;letter-spacing:2px;margin-bottom:6px;}
      hr{border:none;border-top:1px dashed #000;margin:6px 0;}
      .footer-note{font-size:9px;text-align:center;color:#555;margin-top:4px;line-height:1.4;}
    </style></head><body>

      ${logoHtml}
      <div class="tc" style="font-size:16px;font-weight:900;letter-spacing:1px;margin-bottom:1px;">NOUMAN PHARMACY</div>
      <div class="tc" style="font-size:10px;color:#444;margin-bottom:1px;">&#9990; 0328-3220140</div>
      <div class="tc" style="font-size:10px;color:#444;margin-bottom:4px;">&#9993; noumanpharmacy12@gmail.com</div>

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

      <div style="font-size:11px;">
        ${itemRows}
        ${globalDiscountRows}
      </div>

      <hr/>

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

    let printWindow = new BrowserWindow({ show: false });
    const printTimeout = setTimeout(() => { if (printWindow && !printWindow.isDestroyed()) printWindow.destroy(); }, 10000);
    const cleanup = () => { clearTimeout(printTimeout); if (printWindow && !printWindow.isDestroyed()) printWindow.close(); };

    printWindow.webContents.on('did-finish-load', () => {
      printWindow.webContents.print({ silent: true, printBackground: true }, () => cleanup());
    });
    printWindow.webContents.on('did-fail-load', () => cleanup());
    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(receiptHtml)}`);
  } catch (err) {
    console.error('Print failed:', err);
  }
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
    hasDevPassword: !!sysConfig.devPasswordHash
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
  const { mode, serverIp, serverPort, newDevPassword } = payload;

  const updatedConfig = {
    ...sysConfig,
    mode: mode || 'server',
    serverIp: (serverIp || '').trim(),
    serverPort: serverPort || '3847',
  };

  if (newDevPassword && newDevPassword.length >= 4) {
    updatedConfig.devPasswordHash = bcrypt.hashSync(newDevPassword, 10);
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// Test connection from client to server
ipcMain.handle('testServerConnection', async (event, { serverIp, serverPort }) => {
  return new Promise((resolve) => {
    const options = {
      hostname: serverIp,
      port: parseInt(serverPort) || 3847,
      path: '/api/health',
      method: 'GET',
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ success: true, message: `Connected! Server version: ${parsed.version || '?'}` });
        } catch (e) {
          resolve({ success: true, message: 'Connected to server.' });
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

ipcMain.handle('process-checkout', async (event, payload) => {
  if (IS_CLIENT) {
    const result = await networkCall('POST', '/api/checkout', payload, sysConfig);
    return result;
  }

  return new Promise((resolve, reject) => {
    let cartItems = Array.isArray(payload) ? payload : (Array.isArray(payload.cart) ? payload.cart : null);
    if (!cartItems || cartItems.length === 0) return reject(new Error('Invalid basket payload.'));

    const subtotal = parseFloat(payload.subtotal) || 0;
    const discountPercent = parseFloat(payload.discountPercent) || 0;
    const discountDeduction = parseFloat(payload.discountDeduction) || 0;
    const grandTotal = parseFloat(payload.grandTotal) || 0;
    const timestamp = new Date().toISOString();

    isSystemBusy = true;

    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (err) => { if (err) { isSystemBusy = false; return reject(err); } });

      db.get(`SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) as maxId FROM sales_history WHERE id LIKE 'sale-%'`, [], (err, row) => {
        if (err) { db.run('ROLLBACK'); return reject(err); }

        const saleId = `sale-${((row && row.maxId) ? parseInt(row.maxId) : 0) + 1}`;
        const cleanSaleId = saleId.replace('sale-', '');

        db.run(
          `INSERT INTO sales_history (id, timestamp, itemsJson, subtotal, discountPercent, discountDeduction, grandTotal) VALUES (?,?,?,?,?,?,?)`,
          [saleId, timestamp, JSON.stringify(cartItems), subtotal, discountPercent, discountDeduction, grandTotal],
          function (insertErr) {
            if (insertErr) { db.run('ROLLBACK'); return reject(insertErr); }

            const stmt = db.prepare(`UPDATE inventory SET totalUnits = totalUnits - ? WHERE id = ? AND totalUnits >= ?`);
            let errorOccurred = false;
            cartItems.forEach((item) => {
              const units = (parseInt(item.rawUnits) || 0) * (parseInt(item.qty) || 0);
              if (units <= 0 || !item.productId) return;
              stmt.run([units, item.productId.toString(), units], function (stmtErr) {
                if (stmtErr || this.changes === 0) errorOccurred = true;
              });
            });

            stmt.finalize((finalizeErr) => {
              if (finalizeErr || errorOccurred) {
                db.run('ROLLBACK', () => { isSystemBusy = false; reject(new Error('Insufficient stock for one or more items.')); });
              } else {
                db.run('COMMIT', () => {
                  isSystemBusy = false;
                  triggerReceiptPrint(cleanSaleId, timestamp, cartItems, subtotal, discountDeduction, grandTotal);
                  resolve({ success: true, saleId: cleanSaleId });
                });
              }
            });
          }
        );
      });
    });
  });
});

ipcMain.handle('returnSaleItem', async (event, payload) => {
  if (IS_CLIENT) return networkCall('POST', '/api/return', payload, sysConfig);

  const { saleId, returnItems = [], remainingItemsJson, returnedItemsJson, newGrandTotal, newSubtotal, newDiscountDeduction, deleteEntireSale, refundAmount } = payload;

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (err) => { if (err) return reject(err); });

      const stmt = db.prepare(`UPDATE inventory SET totalUnits = totalUnits + ?, is_active = 1 WHERE id = ?`);
      let errorOccurred = false;
      returnItems.forEach((item) => {
        const targetId = item.productId || item.id;
        if (targetId) {
          stmt.run([parseInt(item.unitsToReturn) || 0, targetId.toString()], function (err) {
            if (err) errorOccurred = true;
          });
        }
      });

      stmt.finalize((err) => {
        if (err || errorOccurred) { db.run('ROLLBACK'); return reject(new Error('Failed to restock items.')); }

        const returnId = `RET-${saleId.replace('sale-', '')}-${Date.now().toString().slice(-4)}-${Math.floor(Math.random() * 100)}`;
        const timestamp = new Date().toISOString();

        db.run(
          `INSERT INTO sales_history (id, timestamp, itemsJson, subtotal, discountPercent, discountDeduction, grandTotal) VALUES (?,?,?,?,?,?,?)`,
          [returnId, timestamp, returnedItemsJson, 0, 0, 0, -Math.abs(refundAmount)],
          function (insertErr) {
            if (insertErr) { db.run('ROLLBACK'); return reject(insertErr); }

            if (deleteEntireSale) {
              db.run(`DELETE FROM sales_history WHERE id = ?`, [saleId], function (delErr) {
                if (delErr) { db.run('ROLLBACK'); return reject(delErr); }
                db.run('COMMIT');
                resolve({ success: true, deleted: true });
              });
            } else {
              db.run(
                `UPDATE sales_history SET itemsJson=?,subtotal=?,discountDeduction=?,grandTotal=? WHERE id=?`,
                [remainingItemsJson, newSubtotal, newDiscountDeduction, newGrandTotal, saleId],
                function (updErr) {
                  if (updErr) { db.run('ROLLBACK'); return reject(updErr); }
                  db.run('COMMIT');
                  resolve({ success: true, deleted: false });
                }
              );
            }
          }
        );
      });
    });
  });
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
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        ...(config.devPasswordHash ? {} : {}),
        // Pass the raw dev password stored locally on the client
        // We store it as plaintext on client (hashed only on server)
        'x-pharmtrack-key': config.devPasswordPlain || ''
      }
    };

    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid response from server.'));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Server unreachable: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Server connection timed out. Is the main PC on?')); });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}