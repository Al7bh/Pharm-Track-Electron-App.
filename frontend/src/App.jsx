import React, { useState, useEffect, useRef } from "react";
import SalesCounter from "./components/SalesCounter";
import StockManagement from "./components/StockManagement";
import SalesHistory from "./components/SalesHistory";
import OwnerEarnings from "./components/OwnerEarnings";
import receiptLogo from "./assets/receipt-logo.png";
// =========================================================================
// ENTERPRISE GS1 BARCODE PARSER ENGINE
// =========================================================================
// GS1-128 barcodes terminate variable-length fields (batch/lot = AI 10,
// serial = AI 21, count = AI 30, additional product data = AI 240) with an
// FNC1 control character, transmitted by most scanners as ASCII 0x1D
// (Group Separator). That character is the ONLY unambiguous way to know
// where a variable-length field ends — digit-pattern guessing is a
// fallback for scanners/barcodes that don't send it, and can misfire if
// the field's own content happens to contain a sequence that looks like
// the start of another Application Identifier (this is what was truncating
// batch codes and letting price text leak into the name field).
const GS = "\x1D";

const parsePharmacyBarcode = (scan) => {
  let parsed = {
    raw: scan,
    gtin: scan,
    batch: "",
    expiry: "",
    name: "",
    retailPrice: "",
  };

  if (!scan.startsWith("01") || scan.length < 16) return parsed;

  parsed.gtin = scan.slice(2, 16);
  let remaining = scan.slice(16);
  // Fixed-length AIs (e.g. GTIN, expiry) are sometimes still followed by a
  // defensive separator from the encoder even though the spec doesn't
  // require one — strip a leading one if present so it doesn't get
  // mistaken for the start of the next field's content.
  if (remaining.startsWith(GS)) remaining = remaining.slice(1);

  // Finds where the CURRENT variable-length field ends within `str`.
  const findFieldEnd = (str) => {
    // Preferred: the true GS1 separator, if the scanner transmitted it.
    // Authoritative — can't be fooled by digits inside the field.
    const gsIdx = str.indexOf(GS);
    if (gsIdx !== -1) return { end: gsIdx, matchedSeparator: true };

    // Fallback: best-effort guess based on the next recognizable AI
    // pattern. Only used when no real separator is present.
    let boundaryIdx = str.length;
    const match17 = str.match(/17\d{6}/);
    if (match17 && match17.index < boundaryIdx) boundaryIdx = match17.index;

    const match240 = str.match(/240/);
    if (match240 && match240.index < boundaryIdx) boundaryIdx = match240.index;

    const match21 = str.match(/21[A-Za-z0-9]{3,}/);
    if (match21 && match21.index < boundaryIdx) boundaryIdx = match21.index;

    const match30 = str.match(/30\d{1,8}/);
    if (match30 && match30.index < boundaryIdx) boundaryIdx = match30.index;

    return { end: boundaryIdx, matchedSeparator: false };
  };

  // Consumes a leading separator, if any, after a field has been sliced off.
  const consumeSeparator = (str) => (str.startsWith(GS) ? str.slice(1) : str);

  while (remaining.length > 0) {
    if (remaining.startsWith("17") && remaining.length >= 8) {
      const rawExp = remaining.slice(2, 8);
      if (/^\d{6}$/.test(rawExp)) {
        parsed.expiry = `20${rawExp.slice(0, 2)}-${rawExp.slice(2, 4)}-${rawExp.slice(4, 6)}`;
        remaining = consumeSeparator(remaining.slice(8));
        continue;
      }
    }

    if (remaining.startsWith("10")) {
      remaining = remaining.slice(2);
      const { end } = findFieldEnd(remaining);
      parsed.batch = remaining.slice(0, end);
      remaining = consumeSeparator(remaining.slice(end));
    } else if (remaining.startsWith("21") || remaining.startsWith("30")) {
      remaining = remaining.slice(2);
      const { end } = findFieldEnd(remaining);
      remaining = consumeSeparator(remaining.slice(end));
    } else if (remaining.startsWith("240")) {
      remaining = remaining.slice(3);
      const { end } = findFieldEnd(remaining);
      const extraText = remaining.slice(0, end);
      const rsMatch = extraText.match(/(.*?)Rs\.?(\d+(\.\d+)?)/i);
      if (rsMatch) {
        parsed.name = rsMatch[1].trim();
        parsed.retailPrice = rsMatch[2];
      } else {
        parsed.name = extraText.trim();
      }
      remaining = consumeSeparator(remaining.slice(end));
    } else {
      break;
    }
  }
  return parsed;
};

function App() {
  const [currentTab, setCurrentTab] = useState("sales");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authForm, setAuthForm] = useState({ username: "", password: "" });
  const [showPassword, setShowPassword] = useState(false); // NEW
  const [attempts, setAttempts] = useState(0);
  const [authError, setAuthError] = useState(""); // Shared error message state
  const [cart, setCart] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [salesHistory, setSalesHistory] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [activeProducts, setActiveProducts] = useState([]);

  const [discountPercent, setDiscountPercent] = useState("");
  const [lightMode, setLightMode] = useState(true);

  // Server status indicator — only active on client machines, only after login.
  // Pings the server's /api/health endpoint every 5 seconds. On a standalone
  // server machine this always shows green without any network calls.
  const [serverStatus, setServerStatus] = useState('online'); // 'online' | 'offline' | 'busy'

  useEffect(() => {
    // Read the system config to know if we're a client or server.
    // We access it via IPC rather than storing a copy in state so it's
    // always the real value from disk, not a stale React snapshot.
    if (!window.electronAPI || !window.electronAPI.getSystemConfig) return;

    // The interval used to be created inside the .then(), so its cleanup was
    // returned to the promise instead of to React — every login/logout leaked
    // another heartbeat that pinged forever. These two handles let the real
    // cleanup below cancel whatever the async work started.
    let interval = null;
    let cancelled = false;

    window.electronAPI.getSystemConfig().then((config) => {
      if (cancelled) return;

      // Standalone or server machines are always "online" — no ping needed.
      if (!config || config.mode !== 'client') {
        setServerStatus('online');
        return;
      }

      // Client machine — start pinging every 5 seconds, but ONLY after login
      // so we don't fill logs with errors before the user even authenticates.
      if (!isAuthenticated) return;

      const ping = async () => {
        try {
          const res = await window.electronAPI.checkServerStatus();
          if (cancelled) return;
          setServerStatus(res && res.status === 'busy' ? 'busy' : res && res.status === 'online' ? 'online' : 'offline');
        } catch {
          if (!cancelled) setServerStatus('offline');
        }
      };

      ping();
      interval = setInterval(ping, 5000);
    }).catch((err) => {
      // Without this the promise rejected unhandled and the badge stayed on a
      // confident green "Online" forever.
      console.error('Could not read system config:', err);
      if (!cancelled) setServerStatus('offline');
    });

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [isAuthenticated]); // re-runs when user logs in/out
  const [isEarningAuthenticated, setIsEarningAuthenticated] = useState(false);
  const [earningPinInput, setEarningPinInput] = useState("");

  const [scannedInventoryData, setScannedInventoryData] = useState(null);
  const [scannedInvoiceId, setScannedInvoiceId] = useState(null);

  const [pendingCollisions, setPendingCollisions] = useState([]);
  const [isProcessingSale, setIsProcessingSale] = useState(false);
  // No-Print toggle at top-right of the Sales tab. Default OFF — receipts
  // print as normal unless explicitly switched on. Session-only by design
  // (resets to OFF on reload), so it can never be silently left on.
  const [noPrintMode, setNoPrintMode] = useState(false);

  // ==========================================
  // CLICK-OUTSIDE DETECTOR FOR SEARCH
  // ==========================================
  const searchContainerRef = useRef(null);

  // ==========================================
  // RESPONSIVE LAYOUT STATES
  // ==========================================
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isCartOpen, setIsCartOpen] = useState(true);

  const [notification, setNotification] = useState({
    isOpen: false,
    title: "",
    message: "",
    type: "success",
  });

  // ── Hidden 7-tap Developer Screen ────────────────────────────────────────
  // Tap the version number 7 times within 3 seconds to open the dev password
  // prompt. Nobody on the pharmacy floor knows this exists.
  const [devTapCount, setDevTapCount] = useState(0);
  const devTapTimer = useRef(null);
  const [devScreen, setDevScreen] = useState({
    showPrompt: false,   // password entry prompt
    showConfig: false,   // full config screen (after password verified)
    isFirstTime: false,  // true = no password set yet, skip verification
    password: '',
    error: '',
  });
  const [sysConfig, setSysConfig] = useState(null);
  const [configForm, setConfigForm] = useState({ mode: 'server', serverIp: '', serverPort: '3847', newDevPassword: '', apiToken: '' });
  const [connectionTest, setConnectionTest] = useState({ result: '', type: '' });
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [lastBackupPath, setLastBackupPath] = useState('');

  const handleDevTap = () => {
    if (devTapTimer.current) clearTimeout(devTapTimer.current);
    const newCount = devTapCount + 1;
    if (newCount >= 7) {
      setDevTapCount(0);
      setDevScreen(s => ({ ...s, showPrompt: true, password: '', error: '' }));
      return;
    }
    setDevTapCount(newCount);
    devTapTimer.current = setTimeout(() => setDevTapCount(0), 3000);
  };

  const handleDevPasswordSubmit = async (e) => {
    e.preventDefault();
    const res = await window.electronAPI.verifyDevPassword(devScreen.password);
    if (res.success) {
      const config = await window.electronAPI.getSystemConfig();
      setSysConfig(config);
      setConfigForm({
        mode: config.mode,
        serverIp: config.serverIp,
        serverPort: config.serverPort,
        newDevPassword: '',
        apiToken: config.apiToken || ''
      });
      setDevScreen(s => ({ ...s, showPrompt: false, showConfig: true, isFirstTime: res.firstTime || false, error: '' }));
    } else {
      setDevScreen(s => ({ ...s, error: 'Incorrect developer password.' }));
    }
  };

  const handleSaveConfig = async (e) => {
    e.preventDefault();
    setIsSavingConfig(true);
    setConnectionTest({ result: '', type: '' });
    const res = await window.electronAPI.saveSystemConfig(configForm);
    if (res.success) {
      setDevScreen(s => ({ ...s, showConfig: false }));
      showNotification('Config Saved', 'Settings saved. The app will now restart.', 'success');
      setTimeout(() => window.electronAPI.restartApp(), 1500);
    } else {
      showNotification('Save Failed', res.message, 'error');
    }
    setIsSavingConfig(false);
  };

  const handleTestConnection = async () => {
    setConnectionTest({ result: 'Testing...', type: 'info' });
    const res = await window.electronAPI.testServerConnection({
      serverIp: configForm.serverIp,
      serverPort: configForm.serverPort,
      apiToken: configForm.apiToken
    });
    setConnectionTest({ result: res.message, type: res.success ? 'success' : 'error' });
  };

  const handleDevExportDb = async () => {
    const res = await window.electronAPI.exportDatabase();
    if (res.success) {
      setLastBackupPath(res.filePath);
      showNotification('Backup Saved', `Saved to: ${res.filePath}`, 'success');
    } else {
      showNotification('Backup Failed', res.message, 'error');
    }
  };

  const handleDevImportDb = async () => {
    const res = await window.electronAPI.importDatabase();
    if (res.success) {
      showNotification('Restore Successful', res.message, 'success');
      setTimeout(() => window.electronAPI.restartApp(), 2000);
    } else {
      showNotification('Restore Failed', res.message, 'error');
    }
  };

  // Reprints the most recent sale — handy for testing the thermal printer
  // without having to ring up a real transaction.
  const [isReprintingLast, setIsReprintingLast] = useState(false);
  const handleDevReprintLast = async () => {
    if (isReprintingLast) return;
    if (!window.electronAPI || !window.electronAPI.reprintReceipt) return;
    setIsReprintingLast(true);
    try {
      const res = await window.electronAPI.reprintReceipt();
      if (res && res.success) {
        showNotification('Receipt Sent', `Last receipt (INV-${res.saleId}) sent to the printer.`, 'success');
      } else {
        showNotification('Reprint Failed', (res && res.message) || 'Could not reprint the last receipt.', 'error');
      }
    } catch (err) {
      showNotification('Reprint Failed', friendlyErrorMessage(err, 'Could not print the receipt. Please check the printer and try again.'), 'error');
    } finally {
      setIsReprintingLast(false);
    }
  };

  // Automatically collapse sidebars on smaller laptop/PC screens
  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      if (width <= 1366) {
        setIsSidebarOpen(false); 
      } else {
        setIsSidebarOpen(true);
      }

      if (width <= 1024) {
        setIsCartOpen(false); 
      } else {
        setIsCartOpen(true);
      }
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    // Initial fetch when the app opens. Surfaces a real error if it fails,
    // because at this point the user has no data at all.
    refreshStockLedger();
    refreshSalesHistory();

    // Background sync every 5s. Silent: a transient network blip must not
    // interrupt a cashier mid-sale with a blocking modal.
    const syncInterval = setInterval(() => {
      refreshStockLedger({ silent: true });
      refreshSalesHistory({ silent: true });
    }, 5000);

    return () => clearInterval(syncInterval);
  }, []);

  // =========================================================================
  // GAP-BASED HARDWARE SCAN DETECTOR
  // =========================================================================
  useEffect(() => {
    let scanBuffer = "";
    let lastKeyTime = 0;

    const handleGlobalBarcodeScan = async (e) => {
      // CRITICAL SECURITY GUARD: Block hardware input parsing until terminal is authorized
      if (!isAuthenticated) return; 

      const now = Date.now();
      const gap = now - lastKeyTime;
      lastKeyTime = now;

      if (gap > 150) {
        scanBuffer = "";
      }

      if (e.key.length === 1) {
        scanBuffer += e.key;
      }

      if (e.key === "Enter") {
        if (scanBuffer.length >= 4 && gap <= 150) {
          e.preventDefault();

          if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
            e.target.blur();
          }

          // Preserve \x1D (GS) — it's the real GS1 field separator the
          // barcode parser relies on to split variable-length fields
          // (batch, price, etc.) reliably. Stripping it here was forcing
          // the parser into unreliable digit-pattern guessing, which is
          // what caused truncated batch codes and price text leaking into
          // the name field.
          let currentScanData = scanBuffer
            .replace(/[\x00-\x1C\x1E\x1F\x7F]/g, "")
            .trim();
          scanBuffer = "";

          currentScanData = currentScanData.replace(/\*/g, "");

          if (/^(INV-|sale-)\d+$/i.test(currentScanData)) {
            const cleanId = currentScanData.replace(/^(INV-|sale-)/i, "");
            setCurrentTab("history");
            setScannedInvoiceId(`sale-${cleanId}`);
            return;
          }

          const parsedData = parsePharmacyBarcode(currentScanData);

          if (currentTab === "sales") {
            setSearchQuery("");
            if (window.electronAPI && window.electronAPI.getProductsByBarcode) {
              const dbProducts = await window.electronAPI.getProductsByBarcode(
                parsedData.gtin,
              );

              if (
                dbProducts &&
                dbProducts.length === 1
              ) {
                handleMagicScanSale(dbProducts[0]);
                loadProductToCounter(dbProducts[0]);
                setIsCartOpen(true);
              } else if (dbProducts && dbProducts.length > 0) {
                setPendingCollisions(dbProducts);
              } else {
                const searchInput = document.querySelector(
                  'input[placeholder*="Search formulations..."]',
                );
                if (searchInput) {
                  searchInput.focus();
                  handleSearchChange({ target: { value: parsedData.gtin } });
                }
                showNotification(
                  "Item Not Found",
                  "This barcode is not in our system. Please register the item first.",
                  "warning",
                );
              }
            }
          } else if (currentTab === "inventory") {
            setScannedInventoryData(parsedData);
          }
        }
      }
    };

    window.addEventListener("keydown", handleGlobalBarcodeScan);
    return () => window.removeEventListener("keydown", handleGlobalBarcodeScan);
  }, [salesHistory, currentTab, cart, inventory]);

  // Handle click outside search box to hide dropdown list
  useEffect(() => {
    const handleClickOutsideSearch = (event) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target)) {
        setSearchResults([]); 
      }
    };
    document.addEventListener("mousedown", handleClickOutsideSearch);
    return () => {
      document.removeEventListener("mousedown", handleClickOutsideSearch);
    };
  }, []);

  useEffect(() => {
    let popupTime = Date.now();
    if (notification.isOpen) {
      popupTime = Date.now();
    }

    const handleNotificationKeyDown = (e) => {
      if (notification.isOpen && (e.key === "Enter" || e.key === "Escape")) {
        if (Date.now() - popupTime < 750) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        closeNotification();
      }
    };
    window.addEventListener("keydown", handleNotificationKeyDown);
    return () =>
      window.removeEventListener("keydown", handleNotificationKeyDown);
  }, [notification.isOpen]);

  const showNotification = (title, message, type = "success") =>
    setNotification({ isOpen: true, title, message, type });
  const closeNotification = () =>
    setNotification((prev) => ({ ...prev, isOpen: false }));

  // Translates raw technical error text (SQL errors, network stack traces,
  // "Failed to fetch", etc.) into something a non-technical cashier won't
  // find alarming. Falls back to the caller-supplied plain-language message
  // for anything not recognized, instead of ever surfacing raw err.message.
  const friendlyErrorMessage = (err, fallback) => {
    const raw = (err && err.message ? err.message : "").toString();
    if (!raw) return fallback;
    const patterns = [
      [/sqlite_constraint.*unique/i, "This item already exists — please check the barcode and batch number."],
      [/sqlite_constraint/i, "This couldn't be saved because it conflicts with an existing record."],
      [/sqlite|database is locked|no such table|no such column/i, "There was a problem saving to the database. Please try again."],
      [/econnrefused|failed to fetch|networkerror|network error|fetch failed/i, "Couldn't reach the main computer. Please check the network connection."],
      [/etimedout|timeout/i, "The request took too long. Please check the connection and try again."],
      [/unexpected token|json/i, "Received an unexpected response. Please try again."],
      [/enoent|no such file/i, "A required file couldn't be found."],
    ];
    for (const [pattern, friendly] of patterns) {
      if (pattern.test(raw)) return friendly;
    }
    // Unrecognized error: prefer the caller's plain-language fallback over
    // showing the raw technical text to the user.
    return fallback || "Something went wrong. Please try again.";
  };

  // Sequence guards: the 5s poll fires regardless of whether the previous
  // request is still in flight. Over the network a slow response could land
  // AFTER a newer one and drag the UI backwards — including undoing the
  // post-checkout refresh, which made a completed sale look like it failed.
  // Only the newest request for each dataset is allowed to write state.
  const inventorySeqRef = useRef(0);
  const salesSeqRef = useRef(0);

  // `silent` is used by the background poll: a failing poll must never raise a
  // modal. It used to throw a blocking, full-screen error every 5 seconds
  // (twice — once per refresher), which bricked the app whenever the server
  // PC slept. The nav status indicator is the right place to show this.
  const refreshStockLedger = ({ silent = false } = {}) => {
    if (!window.electronAPI || !window.electronAPI.getInventory) return;
    const seq = ++inventorySeqRef.current;
    window.electronAPI.getInventory()
      .then((data) => {
        if (seq !== inventorySeqRef.current) return; // a newer request already answered
        setInventory(data);
        setServerStatus("online"); // data fetch succeeded — server is reachable
      })
      .catch((err) => {
        if (seq !== inventorySeqRef.current) return;
        console.error("Inventory refresh failed:", err);
        setServerStatus("offline");
if (!silent) showNotification("Connection Issue", friendlyErrorMessage(err, "Could not load the stock list. Please check the main computer."), "error");
      });
  };

  const refreshSalesHistory = ({ silent = false } = {}) => {
    if (!window.electronAPI || !window.electronAPI.getSalesHistory) return;
    const seq = ++salesSeqRef.current;
    window.electronAPI.getSalesHistory()
      .then((data) => {
        if (seq !== salesSeqRef.current) return;
        setSalesHistory(data);
        setServerStatus("online"); // data fetch succeeded — server is reachable
      })
      .catch((err) => {
        if (seq !== salesSeqRef.current) return;
        console.error("Sales history refresh failed:", err);
        setServerStatus("offline");
if (!silent) showNotification("Connection Issue", friendlyErrorMessage(err, "Could not load the sales history. Please check the main computer."), "error");
      });
  };

  // Deletes a return transcript outright (no inventory reversal — see
  // performDeleteReturnTranscript in main.js for the guard against
  // deleting anything that isn't a return record).
  const handleDeleteReturnTranscript = (returnId) => {
    if (!window.electronAPI || !window.electronAPI.deleteReturnTranscript) return Promise.reject(new Error("Not available"));
    return window.electronAPI.deleteReturnTranscript(returnId)
      .then(() => {
        refreshSalesHistory();
        showNotification("Return Deleted", "The return transcript has been removed.", "success");
      })
      .catch((err) => {
        console.error("Delete return transcript failed:", err);
        showNotification("Couldn't Delete Return", "This return record couldn't be removed. Please try again, and check your connection to the main computer if this keeps happening.", "error");
        throw err;
      });
  };

  const handleMagicScanSale = (dbProduct) => {
    setCart((prevCart) => {
      const packFactor = dbProduct.factor || 2;
      const tabletsPerStripForScan = parseInt(dbProduct.tabletsPerStrip) || 0;
      // remainingUnits is expressed in strip-equivalent units either way —
      // for tablet-enabled products it's derived from real available
      // tablets (accounting for the open-strip accumulator), so it can come
      // out fractional (e.g. 0.3 = 3 loose tablets left), which is handled
      // explicitly below rather than silently letting it round into a sale.
      let remainingUnits;

      if (tabletsPerStripForScan > 0) {
        const openStripTablets = parseInt(dbProduct.openStripTablets) || 0;
        let tabletsInCart = 0;
        prevCart.forEach((item) => {
          if (item.productId === dbProduct.id.toString()) {
            tabletsInCart += item.type === "Tablet"
              ? item.qty
              : item.rawUnits * item.qty * tabletsPerStripForScan;
          }
        });
        const availableTablets = Math.max(
          0,
          (dbProduct.totalUnits * tabletsPerStripForScan) - openStripTablets - tabletsInCart
        );
        remainingUnits = availableTablets / tabletsPerStripForScan;
      } else {
        let currentUnitsInCart = 0;
        prevCart.forEach((item) => {
          if (item.productId === dbProduct.id.toString()) {
            currentUnitsInCart += item.rawUnits * item.qty;
          }
        });
        remainingUnits = dbProduct.totalUnits - currentUnitsInCart;
      }

      if (remainingUnits <= 0) {
        showNotification(
          "Not Enough Stock",
          `Cannot add more "${dbProduct.name}". We only have what's shown on the shelf.`,
          "error",
        );
        return prevCart;
      }

      // This quick-scan flow only ever adds a whole Box or Strip — it has
      // no quantity prompt, so it can't fulfill a loose-tablet sale. If less
      // than a full strip's worth remains (e.g. 3 tablets left in an open
      // strip), refuse here instead of rounding up into an oversold "full"
      // strip — the cashier should use "Add Tablet(s)" on the product card
      // for that instead.
      if (tabletsPerStripForScan > 0 && remainingUnits < 1) {
        showNotification(
          "Loose Tablets Only",
          `Only a few loose tablets of "${dbProduct.name}" remain. Use "Add Tablet(s)" on its card instead.`,
          "warning",
        );
        return prevCart;
      }

      let sellType = "Box";
      let unitsNeeded = packFactor;
      let unitPrice = dbProduct.retailPrice;

      // NEW: Calculate cost snapshot
      const boxCost = parseFloat(dbProduct.buyingPrice) || 0;
      let unitCost = boxCost;

      if (remainingUnits < packFactor) {
        sellType = "Strip";
        unitsNeeded = 1;
        unitPrice = dbProduct.retailPrice / packFactor;
        unitCost = boxCost / packFactor; // NEW: Strip cost snapshot
      }

      const existingItem = prevCart.find(
        (item) =>
          item.productId === dbProduct.id.toString() && item.type === sellType,
      );

      if (existingItem) {
        return prevCart.map((item) =>
          item.productId === dbProduct.id.toString() && item.type === sellType
            ? { ...item, qty: item.qty + 1 }
            : item,
        );
      } else {
        return [
          ...prevCart,
          {
            id: `${dbProduct.id}-${sellType}-${Date.now()}`,
            productId: dbProduct.id.toString(),
            name: dbProduct.name,
            batch: dbProduct.batch,
            price: unitPrice,
            unitCost: unitCost, // <--- NEW: Saved permanently on the receipt
            qty: 1,
            type: sellType,
            rawUnits: unitsNeeded,
            itemDiscountPercent: 0,
          },
        ];
      }
    });
  };

  const loadProductToCounter = (dbProduct) => {
    if (!dbProduct) return;
    const isAlreadyStacked = activeProducts.some(
      (p) => p.id === dbProduct.id.toString() || p.id === dbProduct.id,
    );
    if (isAlreadyStacked) {
      setSearchQuery("");
      setSearchResults([]);
      return;
    }

    const standardProduct = {
      id: dbProduct.id ? dbProduct.id.toString() : Date.now().toString(),
      name: dbProduct.name || "Unknown Medication",
      generic: dbProduct.generic || "Generic Not Listed",
      factor: parseInt(dbProduct.factor) || 10,
      batch: dbProduct.batch || "N/A",
      expiry: dbProduct.expiry || "N/A",
      totalUnitsAvailable: parseInt(dbProduct.totalUnits) || 0,
      retailPricePerBox: parseFloat(dbProduct.retailPrice) || 0,
      buyingPrice: parseFloat(dbProduct.buyingPrice) || 0,
      // Was missing — SalesCounter's "Add Tablet(s)" button checks these,
      // so without them here it could never appear even when a product had
      // Tablets/Strip configured.
      tabletsPerStrip: parseInt(dbProduct.tabletsPerStrip) || 0,
      openStripTablets: parseInt(dbProduct.openStripTablets) || 0,
    };

    setActiveProducts((prev) => [standardProduct, ...prev]);
    setSearchQuery("");
    setSearchResults([]);
  };

  const handleDismissProduct = (productId) =>
    setActiveProducts((prev) => prev.filter((p) => p.id !== productId));

  const handleSearchChange = async (e) => {
    const val = e.target.value;
    setSearchQuery(val);
    if (
      val.trim().length > 0 &&
      window.electronAPI &&
      window.electronAPI.searchInventory
    ) {
      const results = await window.electronAPI.searchInventory(val);
      setSearchResults(results);
    } else {
      setSearchResults([]);
    }
  };

  // Returns true only when the write actually succeeded, so the form knows
  // whether it is safe to clear itself.
  const handleSaveStockToDB = async (itemData, isEditMode) => {
    if (!window.electronAPI) return false;
    try {
      let res;
      if (isEditMode && window.electronAPI.updateInventory) {
        res = await window.electronAPI.updateInventory(itemData);
      } else if (window.electronAPI.addInventory) {
        res = await window.electronAPI.addInventory(itemData);
      } else {
        return false;
      }

      // Some handlers resolve {success:false, message} with HTTP 200 rather
      // than rejecting — don't report those as a success.
      if (res && res.success === false) {
        showNotification("Could Not Save", res.message || "The system could not save this item. Please try again.", "error");
        return false;
      }

      showNotification(
        "Saved Successfully",
        isEditMode ? "Item details have been updated!" : "New stock has been added to the system!",
        "success"
      );
      refreshStockLedger();
      return true;
    } catch (err) {
      showNotification("Stock Update Failed", friendlyErrorMessage(err, "This stock update couldn't be saved. Please try again."), "error");
      return false;
    }
  };

  // Quick Restock sends a DELTA, not a recomputed absolute total, so a restock
  // based on a stale poll can no longer erase another till's sale.
  const handleQuickRestock = async (itemId, unitsToAdd) => {
    if (!window.electronAPI || !window.electronAPI.restockInventory) return false;
    try {
      await window.electronAPI.restockInventory({ id: itemId, unitsToAdd });
      showNotification("Stock Updated", "New stock has been added successfully.", "success");
      refreshStockLedger();
      return true;
    } catch (err) {
      showNotification("Restock Failed", friendlyErrorMessage(err, "Could not add stock. Please check the main computer and try again."), "error");
      return false;
    }
  };

  const handleDeleteStockFromDB = async (itemId) => {
    if (window.electronAPI && window.electronAPI.deleteInventory) {
      try {
        await window.electronAPI.deleteInventory(itemId);
showNotification(
          "Deleted",
          "Item has been removed from stock.",
          "success",
        );
        refreshStockLedger();
      } catch (err) {
        showNotification(
          "Could Not Delete",
          "The item could not be removed. Please try again.",
          "error",
        );
      }
    }
  };

  const handleAddItemToCart = (targetProduct, sellType, tabletQty) => {
    const packFactor = targetProduct.factor || 10;

    // Tablet sales are a distinct unit system (individual tablets, not
    // strips/boxes) and are only ever available for products with a
    // tabletsPerStrip value set (Feature 2/3). Kept as its own branch since
    // its availability check works against the open-strip tablet
    // accumulator rather than plain totalUnits.
    if (sellType === "Tablet") {
      const tabletsPerStrip = parseInt(targetProduct.tabletsPerStrip) || 0;
      const qtyToAdd = parseInt(tabletQty) || 0;
      if (tabletsPerStrip <= 0 || qtyToAdd <= 0) return;

      const boxPrice = parseFloat(targetProduct.retailPricePerBox) || parseFloat(targetProduct.retailPrice) || 0;
      const boxCost = parseFloat(targetProduct.buyingPricePerBox || targetProduct.buyingPrice) || 0;
      const unitPrice = (boxPrice / packFactor) / tabletsPerStrip;
      const unitCost = (boxCost / packFactor) / tabletsPerStrip;

      let stockLimitReached = false;
      let availableForMessage = 0;

      setCart((prevCart) => {
        let tabletsInCart = 0;
        prevCart.forEach((item) => {
          if (item.productId === targetProduct.id?.toString() && item.type === "Tablet") {
            tabletsInCart += item.qty;
          }
        });

        const trueTotalUnits = targetProduct.totalUnits !== undefined ? targetProduct.totalUnits : targetProduct.totalUnitsAvailable;
        const openStripTablets = parseInt(targetProduct.openStripTablets) || 0;
        const availableTablets = (trueTotalUnits * tabletsPerStrip) - openStripTablets;
        availableForMessage = Math.max(0, availableTablets - tabletsInCart);

        if (tabletsInCart + qtyToAdd > availableTablets) {
          stockLimitReached = true;
          return prevCart;
        }

        const existingItemIndex = prevCart.findIndex(
          (item) => item.productId === targetProduct.id?.toString() && item.type === "Tablet",
        );

        if (existingItemIndex >= 0) {
          return prevCart.map((item, index) =>
            index === existingItemIndex ? { ...item, qty: item.qty + qtyToAdd } : item,
          );
        } else {
          return [
            ...prevCart,
            {
              id: `${targetProduct.id}-Tablet-${Date.now()}`,
              productId: targetProduct.id?.toString(),
              name: targetProduct.name,
              batch: targetProduct.batch,
              price: unitPrice,
              unitCost: unitCost,
              // qty IS the tablet count for this line — consistent with the
              // existing price*qty line-total pattern, and what the backend
              // deducts against the open-strip accumulator at checkout.
              qty: qtyToAdd,
              type: "Tablet",
              // Expressed as a strip-fraction so it composes correctly with
              // the existing box/strip "units reserved in cart" displays
              // elsewhere (SalesCounter's Warehouse Sub-Units Balance, etc.)
              // without needing to special-case Tablet lines there too.
              rawUnits: 1 / tabletsPerStrip,
              itemDiscountPercent: 0,
            },
          ];
        }
      });

      if (stockLimitReached) {
        showNotification(
          "Not Enough Stock",
          `Only ${availableForMessage} tablet(s) left in stock.`,
          "warning",
        );
        return;
      }

      if (currentTab === "sales") setIsCartOpen(true);
      return;
    }

    const unitsNeeded = sellType === "Box" ? packFactor : 1;
    const tabletsPerStripForCheck = parseInt(targetProduct.tabletsPerStrip) || 0;
    const isTabletAccurateProduct = tabletsPerStripForCheck > 0;

    const boxPrice =
      parseFloat(targetProduct.retailPricePerBox) ||
      parseFloat(targetProduct.retailPrice) ||
      0;
    const unitPrice = sellType === "Box" ? boxPrice : boxPrice / packFactor;

    // ADD THIS NEW BLOCK: Snapshot the cost for manual clicks
    const boxCost = parseFloat(targetProduct.buyingPricePerBox || targetProduct.buyingPrice) || 0;
    const unitCost = sellType === "Box" ? boxCost : boxCost / packFactor;

    let stockLimitReached = false;

    setCart((prevCart) => {
      const trueTotalUnits =
        targetProduct.totalUnits !== undefined
          ? targetProduct.totalUnits
          : targetProduct.totalUnitsAvailable;

      if (isTabletAccurateProduct) {
        // Tablet-aware check: every reservation already in the cart for this
        // product (Box, Strip, or Tablet) is converted into tablets, and
        // checked against real available tablets — which accounts for
        // whatever's already been sold off a currently-open strip. This is
        // what stops a strip sitting at, say, 3 tablets left from being
        // added to the cart as a full-price "full" strip or box.
        let tabletsInCart = 0;
        prevCart.forEach((item) => {
          if (item.productId === targetProduct.id?.toString()) {
            tabletsInCart += item.type === "Tablet"
              ? item.qty
              : item.rawUnits * item.qty * tabletsPerStripForCheck;
          }
        });
        const openStripTablets = parseInt(targetProduct.openStripTablets) || 0;
        const availableTablets = (trueTotalUnits * tabletsPerStripForCheck) - openStripTablets;
        const tabletsNeeded = unitsNeeded * tabletsPerStripForCheck;

        if (tabletsInCart + tabletsNeeded > availableTablets) {
          stockLimitReached = true;
          return prevCart;
        }
      } else {
        let currentUnitsInCart = 0;
        prevCart.forEach((item) => {
          if (item.productId === targetProduct.id?.toString()) {
            currentUnitsInCart += item.rawUnits * item.qty;
          }
        });

        if (currentUnitsInCart + unitsNeeded > trueTotalUnits) {
          stockLimitReached = true;
          return prevCart;
        }
      }

      const existingItemIndex = prevCart.findIndex(
        (item) =>
          item.productId === targetProduct.id?.toString() &&
          item.type === sellType,
      );

      if (existingItemIndex >= 0) {
        return prevCart.map((item, index) =>
          index === existingItemIndex ? { ...item, qty: item.qty + 1 } : item,
        );
      } else {
        return [
          ...prevCart,
          {
            id: `${targetProduct.id}-${sellType}-${Date.now()}`,
            productId: targetProduct.id?.toString(),
            name: targetProduct.name,
            batch: targetProduct.batch,
            price: unitPrice,
            unitCost: unitCost, // <--- NEW: Cost snapshot for manual additions
            qty: 1,
            type: sellType,
            rawUnits: unitsNeeded,
            itemDiscountPercent: 0,
          },
        ];
      }
    });

    if (stockLimitReached) {
      const trueTotalUnits = targetProduct.totalUnits !== undefined ? targetProduct.totalUnits : targetProduct.totalUnitsAvailable;
      const boxes = Math.floor(trueTotalUnits / packFactor);
      const strips = trueTotalUnits % packFactor;
      showNotification(
"Not Enough Stock",
        `Only ${boxes} Box(es) and ${strips} Strip(s) left in stock.`,
        "warning",
      );
      return;
    }

    if (currentTab === "sales") setIsCartOpen(true);
  };

  const handleClearCart = () => {
    setCart([]);
    setDiscountPercent("");
  };

  const handleItemDiscountChange = (itemId, val) => {
    let numericPercent = Math.round(parseFloat(val)) || 0;
    if (numericPercent > 50) numericPercent = 50;
    if (numericPercent < 0) numericPercent = 0;

    setCart((prevCart) =>
      prevCart.map((item) => {
        if (item.id === itemId)
          return { ...item, itemDiscountPercent: numericPercent };
        return item;
      }),
    );
  };

  const handleCheckoutSale = async () => {
    if (cart.length === 0 || isProcessingSale) return;
    setIsProcessingSale(true);

    if (window.electronAPI && window.electronAPI.processCheckout) {
      try {
        const finalCartToSave = cart.map((item) => ({
          ...item,
          itemDiscountAmount: Math.round(
            item.price * item.qty * ((item.itemDiscountPercent || 0) / 100),
          ),
        }));
        await window.electronAPI.processCheckout({
          cart: finalCartToSave,
          subtotal: baseSubTotal,
          discountPercent: parseFloat(discountPercent) || 0,
          discountDeduction: totalDiscountDeduction,
          grandTotal: grandTotalDue,
          skipPrint: noPrintMode,
        });

showNotification(
          "Transaction Complete",
          noPrintMode ? "Sale saved successfully! (No receipt printed)" : "Sale saved and printed successfully!",
          "success",
        );
        setCart([]);
        setDiscountPercent("");
        setActiveProducts([]);
        // Safety net: No-Print applies to this one sale only — it resets to
        // OFF (print) after every completed transaction, on whichever
        // terminal made the sale, so it can never be accidentally left on
        // for the next customer.
        setNoPrintMode(false);
        refreshStockLedger();
        refreshSalesHistory();
      } catch (err) {
        showNotification("Checkout Failed", friendlyErrorMessage(err, "This sale couldn't be completed. Please try again."), "error");
      } finally {
        setIsProcessingSale(false);
      }
    } else {
      setIsProcessingSale(false);
    }
  };

  const handleGatewayLoginSubmit = async (e) => {
    e.preventDefault();
    if (attempts >= 3) return;

    if (window.electronAPI && window.electronAPI.authenticateTerminal) {
      try {
        const res = await window.electronAPI.authenticateTerminal(authForm);
        if (res.success) {
          setIsAuthenticated(true);
          setAttempts(0);
          setAuthError("");
        } else {
          // res.message can be absent, so never call .includes() on it directly.
          const message = res.message || "Invalid administrative terminal credentials.";

          // Catch the backend lockout message if they bypassed via F5, or the
          // server's HTTP rate limiter.
          if (message.includes("permanently locked") || message.includes("Too many failed attempts")) {
            setAttempts(3);
            setAuthError(message);
            return;
          }

          const newAttempts = attempts + 1;
          setAttempts(newAttempts);
          if (newAttempts >= 3) {
setAuthError("Access locked. Please restart the app.");
          } else {
            setAuthError(`Incorrect username or password. ${3 - newAttempts} attempt(s) left.`);
          }
        }
      } catch (err) {
setAuthError(friendlyErrorMessage(err, "Could not connect to the system. Please check the main computer is on."));
      }
    }
  };

  const [vaultAttempts, setVaultAttempts] = useState(0);

  const handleVerifyEarningSecureAccess = async (e) => {
    e.preventDefault();
    if (vaultAttempts >= 3) return;

    if (window.electronAPI && window.electronAPI.authenticateVault) {
      try {
        const res = await window.electronAPI.authenticateVault(earningPinInput);
        if (res.success) {
          setIsEarningAuthenticated(true);
          setVaultAttempts(0); // Reset on success just in case
        } else {
          // res.message can be absent (or the server may be rate-limiting), so
          // never call .includes() on it directly.
          const message = res.message || "Invalid master vault PIN.";

          // Catch the backend lockout message if they bypassed via F5
          if (message.includes("permanently locked") || message.includes("Too many failed attempts")) {
            setVaultAttempts(3);
            showNotification("Vault Locked", message, "error");
            return;
          }

          const newAttempts = vaultAttempts + 1;
          setVaultAttempts(newAttempts);

          showNotification("Access Denied",
            newAttempts >= 3
              ? "Access is locked for this session. Please restart the app."
              : `Incorrect PIN. ${3 - newAttempts} attempt(s) left.`,
            "error"
          );
        }
      } catch (err) {
showNotification("Error", "Could not verify your PIN. Please try again.", "error");
      }
    }
  };
  
  const baseSubTotal = Math.round(
    cart.reduce((sum, item) => sum + item.price * item.qty, 0),
  );
  const aggregateItemDiscountDeduction = Math.round(
    cart.reduce(
      (sum, item) =>
        sum + item.price * item.qty * ((item.itemDiscountPercent || 0) / 100),
      0,
    ),
  );
  const globalDiscountDeduction = Math.round(
    (baseSubTotal - aggregateItemDiscountDeduction) *
      ((parseFloat(discountPercent) || 0) / 100),
  );
  const totalDiscountDeduction =
    aggregateItemDiscountDeduction + globalDiscountDeduction;
  const grandTotalDue = Math.max(0, baseSubTotal - totalDiscountDeduction);
  const totalItemPacksCount = cart.reduce((sum, item) => sum + item.qty, 0);

  if (!isAuthenticated) {
    return (
      <div className={`${lightMode ? "bg-gradient-to-br from-slate-50 via-white to-emerald-50" : "bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950"} min-h-screen w-full flex items-center justify-center relative overflow-hidden select-none font-sans antialiased`}>
        {/* Animated gradient orbs background */}
        <div className="absolute inset-0 bg-[length:200%_200%] animate-gradient-shift" style={{
          backgroundImage: lightMode
            ? 'radial-gradient(ellipse at 20% 50%, rgba(16,185,129,0.08) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(5,150,105,0.05) 0%, transparent 50%), radial-gradient(ellipse at 50% 80%, rgba(16,185,129,0.06) 0%, transparent 50%)'
            : 'radial-gradient(ellipse at 20% 50%, rgba(16,185,129,0.15) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(99,102,241,0.10) 0%, transparent 50%), radial-gradient(ellipse at 50% 80%, rgba(16,185,129,0.12) 0%, transparent 50%)'
        }} />
        {/* Floating decorative orbs */}
        <div className={`absolute top-20 left-[10%] w-72 h-72 rounded-full opacity-20 blur-3xl pointer-events-none ${lightMode ? "bg-emerald-300" : "bg-emerald-500/20"}`} style={{ animation: 'float-slow 6s ease-in-out infinite' }} />
        <div className={`absolute bottom-20 right-[10%] w-96 h-96 rounded-full opacity-20 blur-3xl pointer-events-none ${lightMode ? "bg-teal-300" : "bg-teal-500/20"}`} style={{ animation: 'float-medium 8s ease-in-out infinite' }} />
        <div className={`absolute top-1/3 right-[15%] w-48 h-48 rounded-full opacity-10 blur-3xl pointer-events-none ${lightMode ? "bg-emerald-400" : "bg-indigo-500/20"}`} style={{ animation: 'float-fast 10s ease-in-out infinite' }} />
        <div className="max-w-md w-full px-6 z-10 flex flex-col gap-8 animate-fade-in-up">
          <div className="flex flex-col items-center text-center gap-3">
            <div className={`w-14 h-14 ${lightMode ? "bg-white/90 border-slate-200 shadow-md" : "bg-slate-800/80 border-slate-700/50 shadow-lg shadow-emerald-500/5"} border rounded-2xl flex items-center justify-center text-emerald-500 backdrop-blur-sm`}>
              <img src={receiptLogo} alt="Nouman Pharmacy" className="w-10 h-10 object-contain" />
            </div>
            <div className="space-y-1 mt-1">
              <h1 className={`text-3xl font-black tracking-tight uppercase ${lightMode ? "text-slate-800" : "text-white"}`}>
                PharmTrack
              </h1>
              <p
                className={`text-xs tracking-wider font-bold uppercase cursor-default select-none ${lightMode ? "text-slate-500" : "text-slate-400"}`}
                onClick={handleDevTap}
              >
                Administrative Terminal Hub
              </p>
            </div>
          </div>
          <div className={`${lightMode ? "bg-white/80 backdrop-blur-xl border border-white/20 shadow-2xl shadow-emerald-500/5" : "bg-slate-900/60 backdrop-blur-xl border border-slate-700/30 shadow-2xl shadow-emerald-500/5"} rounded-3xl p-8 flex flex-col gap-6 relative animate-scale-in`}>
            <div className="space-y-1">
              <h2 className={`text-base font-black uppercase tracking-wide ${lightMode ? "text-slate-800" : "text-slate-100"}`}>
                Terminal Verification
              </h2>
              <p className={`text-xs font-medium ${lightMode ? "text-slate-400" : "text-slate-500"}`}>
                Please authorize session tokens to log records into warehouse
                systems.
              </p>
            </div>
            <form onSubmit={handleGatewayLoginSubmit} className="space-y-4">
              {/* Add this block to show the inline error */}
              {authError && (
                <div className="text-rose-500 text-[10px] font-black uppercase bg-rose-500/10 p-2 rounded-lg text-center border border-rose-500/20">
                  {authError}
                </div>
              )}
              <div className="space-y-1">
                <label className={`text-[10px] font-bold uppercase tracking-wider ${lightMode ? "text-slate-400" : "text-slate-500"}`}>
                  Terminal Operator ID
                </label>
                <input
                  type="text"
                  required
                  placeholder="Enter username..."
                  value={authForm.username}
                  onChange={(e) =>
                    setAuthForm((prev) => ({
                      ...prev,
                      username: e.target.value,
                    }))
                  }
                  className={`w-full rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-2 transition-all ${
                    lightMode
                      ? "bg-slate-50/80 border border-slate-200 focus:border-emerald-500 focus:ring-emerald-500/20 text-slate-900"
                      : "bg-slate-800/50 border border-slate-700/50 focus:border-emerald-500 focus:ring-emerald-500/20 text-slate-100 placeholder-slate-500"
                  }`}
                />
              </div>
              <div className="space-y-1">
                <label className={`text-[10px] font-bold uppercase tracking-wider ${lightMode ? "text-slate-400" : "text-slate-500"}`}>
                  Security Access Pin
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    placeholder="••••"
                    value={authForm.password}
                    onChange={(e) =>
                      setAuthForm((prev) => ({
                        ...prev,
                        password: e.target.value,
                      }))
                    }
                    className={`w-full rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-2 transition-all tracking-widest ${
                      lightMode
                        ? "bg-slate-50/80 border border-slate-200 focus:border-emerald-500 focus:ring-emerald-500/20 text-slate-900"
                        : "bg-slate-800/50 border border-slate-700/50 focus:border-emerald-500 focus:ring-emerald-500/20 text-slate-100"
                    }`}
                  />
                  <button 
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className={`absolute right-3 top-3 ${lightMode ? "text-slate-400 hover:text-emerald-500" : "text-slate-500 hover:text-emerald-400"}`}
                  >
                    <span className="material-symbols-outlined text-base">
                      {showPassword ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
              </div>
              <button
                type="submit"
                disabled={attempts >= 3} // <--- DISABLES BUTTON
                className={`w-full font-black py-3.5 px-4 rounded-xl text-xs uppercase tracking-wider shadow-md transition-all flex items-center justify-center gap-2 mt-6 ${
                  attempts >= 3 
                    ? "bg-slate-300 text-slate-500 cursor-not-allowed" 
                    : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:opacity-95 hover:shadow-lg hover:shadow-emerald-500/20 active:scale-[0.98]"
                }`}
              >
                {attempts >= 3 ? "Locked" : "Initialize Terminal Session"}
              </button>
            </form>
          </div>
        </div>

        {/* ── Developer Password Prompt (7-tap hidden trigger) ── */}
        {devScreen.showPrompt && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/90 backdrop-blur-sm">
            <div className={`${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-700/50"} border rounded-2xl p-6 max-w-sm w-full shadow-2xl flex flex-col gap-4 mx-4 backdrop-blur-sm`}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-500">
                  <span className="material-symbols-outlined text-lg">terminal</span>
                </div>
                <div>
                  <h3 className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}>Developer Access</h3>
                  <p className={`text-[11px] mt-0.5 ${lightMode ? "text-slate-400" : "text-slate-500"}`}>Enter developer password to continue.</p>
                </div>
              </div>
              {devScreen.error && (
                <div className="text-rose-500 text-[10px] font-black uppercase bg-rose-500/10 p-2 rounded-lg text-center border border-rose-500/20">
                  {devScreen.error}
                </div>
              )}
              <form onSubmit={handleDevPasswordSubmit} className="flex flex-col gap-3">
                <input
                  type="password"
                  required
                  autoFocus
                  placeholder="Developer password..."
                  value={devScreen.password}
                  onChange={(e) => setDevScreen(s => ({ ...s, password: e.target.value }))}
                  className={`w-full rounded-xl py-2.5 px-4 text-sm focus:outline-none focus:ring-2 transition-all ${
                    lightMode
                      ? "bg-slate-50 border border-slate-200 focus:border-violet-500 focus:ring-violet-500/20 text-slate-900"
                      : "bg-slate-800/50 border border-slate-700/50 focus:border-violet-500 focus:ring-violet-500/20 text-slate-100 placeholder-slate-500"
                  }`}
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDevScreen(s => ({ ...s, showPrompt: false, password: '', error: '' }))} className={`flex-1 font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition-all ${lightMode ? "bg-slate-100 text-slate-600 hover:bg-slate-200" : "bg-slate-800 text-slate-400 hover:bg-slate-700 border border-slate-700/50"}`}>
                    Cancel
                  </button>
                  <button type="submit" className="flex-1 bg-violet-600 text-white font-black py-2.5 rounded-xl text-xs uppercase tracking-wider hover:opacity-90">
                    Verify
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── Developer Config Screen ── */}
        {devScreen.showConfig && (
          <div className="fixed inset-0 z-[200] backdrop-blur-sm overflow-y-auto" style={{ backgroundColor: lightMode ? 'rgba(2,6,23,0.95)' : undefined }}>
            <div className="min-h-full flex items-start justify-center py-8 px-4">
            <div className={`${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-700/50"} border rounded-2xl max-w-lg w-full shadow-2xl flex flex-col gap-0 overflow-hidden`}>
              {/* Header */}
              <div className="bg-violet-600 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-white text-xl">settings_ethernet</span>
                  <div>
                    <h3 className="text-sm font-black uppercase tracking-wider text-white">PharmTrack Developer Settings</h3>
                    <p className="text-[11px] text-violet-200 mt-0.5">Network configuration — for developer use only</p>
                  </div>
                </div>
                <button onClick={() => setDevScreen(s => ({ ...s, showConfig: false }))} className="text-violet-200 hover:text-white">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>

              <form onSubmit={handleSaveConfig} className={`p-6 flex flex-col gap-5 ${lightMode ? "bg-white" : "bg-slate-900"}`}>

                {devScreen.isFirstTime && (
                  <div className={`rounded-xl p-3 text-[11px] font-medium ${lightMode ? "bg-amber-50 border border-amber-200 text-amber-700" : "bg-amber-500/10 border border-amber-500/20 text-amber-400"}`}>
                    First time setup — no developer password is set yet. Set one below before saving.
                  </div>
                )}

                {/* Mode selector */}
                <div>
                  <label className={`text-[10px] font-black uppercase tracking-wider ${lightMode ? "text-slate-500" : "text-slate-400"} block mb-2`}>System Role</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setConfigForm(f => ({ ...f, mode: 'server' }))}
                      className={`border rounded-xl py-3 text-xs font-black uppercase tracking-wider flex flex-col items-center gap-1.5 transition-all ${configForm.mode === 'server' ? 'border-violet-500 bg-violet-500/5 text-violet-700' : lightMode ? 'border-slate-200 text-slate-400 hover:border-slate-300' : 'border-slate-700 text-slate-500 hover:border-slate-600'}`}>
                      <span className="material-symbols-outlined text-xl">dns</span>
                      Server / Standalone
                    </button>
                    <button type="button" onClick={() => setConfigForm(f => ({ ...f, mode: 'client' }))}
                      className={`border rounded-xl py-3 text-xs font-black uppercase tracking-wider flex flex-col items-center gap-1.5 transition-all ${configForm.mode === 'client' ? 'border-violet-500 bg-violet-500/5 text-violet-700' : lightMode ? 'border-slate-200 text-slate-400 hover:border-slate-300' : 'border-slate-700 text-slate-500 hover:border-slate-600'}`}>
                      <span className="material-symbols-outlined text-xl">computer</span>
                      Client Terminal
                    </button>
                  </div>
                  <p className={`text-[10px] ${lightMode ? "text-slate-400" : "text-slate-500"} mt-1.5`}>
                    {configForm.mode === 'server' ? 'This PC holds the database and serves all clients on the network.' : 'This PC connects to the server PC over the local network.'}
                  </p>
                </div>

                {/* Server IP — only shown when client mode */}
                {configForm.mode === 'client' && (
                  <div className="flex flex-col gap-3">
                    <div>
                      <label className={`text-[10px] font-black uppercase tracking-wider ${lightMode ? "text-slate-500" : "text-slate-400"} block mb-1`}>Server IP Address</label>
                      <input type="text" placeholder="192.168.1.100" required value={configForm.serverIp}
                        onChange={(e) => setConfigForm(f => ({ ...f, serverIp: e.target.value }))}
                        className={`w-full rounded-xl py-2.5 px-3 text-sm font-mono focus:outline-none focus:ring-2 transition-all ${lightMode ? "bg-slate-50 border border-slate-200 focus:border-violet-500 focus:ring-violet-500/20 text-slate-900" : "bg-slate-800/50 border border-slate-700/50 focus:border-violet-500 focus:ring-violet-500/20 text-slate-100 placeholder-slate-500"}`} />
                      <p className={`text-[10px] ${lightMode ? "text-slate-400" : "text-slate-500"} mt-1`}>The static IP of the server PC on the pharmacy network.</p>
                    </div>
                    <div>
                      <label className={`text-[10px] font-black uppercase tracking-wider ${lightMode ? "text-slate-500" : "text-slate-400"} block mb-1`}>Port</label>
                      <input type="text" value={configForm.serverPort}
                        onChange={(e) => setConfigForm(f => ({ ...f, serverPort: e.target.value }))}
                        className={`w-full rounded-xl py-2.5 px-3 text-sm font-mono focus:outline-none focus:ring-2 transition-all ${lightMode ? "bg-slate-50 border border-slate-200 focus:border-violet-500 focus:ring-violet-500/20 text-slate-900" : "bg-slate-800/50 border border-slate-700/50 focus:border-violet-500 focus:ring-violet-500/20 text-slate-100"}`} />
                    </div>
                    {/* Test connection */}
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={handleTestConnection}
                        className={`font-bold py-2 px-4 rounded-xl text-xs uppercase tracking-wider flex items-center gap-1.5 transition-all ${lightMode ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700/50"}`}>
                        <span className="material-symbols-outlined text-sm">network_check</span>
                        Test Connection
                      </button>
                      {connectionTest.result && (
                        <span className={`text-[11px] font-bold ${connectionTest.type === 'success' ? 'text-emerald-600' : connectionTest.type === 'error' ? 'text-rose-500' : 'text-slate-500'}`}>
                          {connectionTest.result}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* API security token — must match on server + every client */}
                <div>
                  <label className={`text-[10px] font-black uppercase tracking-wider ${lightMode ? "text-slate-500" : "text-slate-400"} block mb-1`}>Network Security Token</label>
                  <div className="flex gap-2">
                    <input type="text" placeholder="Not set — API is open to the network!"
                      value={configForm.apiToken}
                      onChange={(e) => setConfigForm(f => ({ ...f, apiToken: e.target.value }))}
                      className={`flex-1 min-w-0 rounded-xl py-2.5 px-3 text-[11px] font-mono focus:outline-none focus:ring-2 transition-all ${lightMode ? "bg-slate-50 border border-slate-200 focus:border-violet-500 focus:ring-violet-500/20 text-slate-900" : "bg-slate-800/50 border border-slate-700/50 focus:border-violet-500 focus:ring-violet-500/20 text-slate-100 placeholder-slate-500"}`} />
                    <button type="button"
                      onClick={async () => {
                        const t = await window.electronAPI.generateApiToken();
                        setConfigForm(f => ({ ...f, apiToken: t }));
                      }}
                      className={`font-bold py-2 px-3 rounded-xl text-[10px] uppercase tracking-wider transition-all shrink-0 ${lightMode ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700/50"}`}>
                      Generate
                    </button>
                    <button type="button"
                      onClick={() => navigator.clipboard?.writeText(configForm.apiToken || '')}
                      disabled={!configForm.apiToken}
                      className={`font-bold py-2 px-3 rounded-xl text-[10px] uppercase tracking-wider transition-all shrink-0 disabled:opacity-40 ${lightMode ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700/50"}`}>
                      Copy
                    </button>
                  </div>
                  {configForm.apiToken ? (
                    <p className={`text-[10px] ${lightMode ? "text-slate-400" : "text-slate-500"} mt-1`}>Paste this exact token into every client machine's developer screen, or they won't be able to connect.</p>
                  ) : (
                    <p className="text-[10px] text-rose-500 mt-1 font-medium">⚠ Without a token, any device on the pharmacy WiFi can read your data and post fake sales. Generate one on the server, then copy it to each client.</p>
                  )}
                </div>

                {/* Developer password */}
                <div>
                  <label className={`text-[10px] font-black uppercase tracking-wider ${lightMode ? "text-slate-500" : "text-slate-400"} block mb-1`}>
                    {devScreen.isFirstTime ? 'Set Developer Password' : 'Change Developer Password'} (min 4 characters)
                  </label>
                  <input type="password" placeholder={devScreen.isFirstTime ? 'Set a developer password...' : 'Leave blank to keep current'}
                    value={configForm.newDevPassword}
                    onChange={(e) => setConfigForm(f => ({ ...f, newDevPassword: e.target.value }))}
                    className={`w-full rounded-xl py-2.5 px-3 text-sm focus:outline-none focus:ring-2 transition-all ${lightMode ? "bg-slate-50 border border-slate-200 focus:border-violet-500 focus:ring-violet-500/20 text-slate-900" : "bg-slate-800/50 border border-slate-700/50 focus:border-violet-500 focus:ring-violet-500/20 text-slate-100 placeholder-slate-500"}`} />
                  <p className={`text-[10px] ${lightMode ? "text-slate-400" : "text-slate-500"} mt-1`}>This password protects these developer settings. Only you should know it.</p>
                </div>

                {/* Database tools */}
                <div className={`border-t pt-4 ${lightMode ? "border-slate-100" : "border-slate-800"}`}>
                  <label className={`text-[10px] font-black uppercase tracking-wider ${lightMode ? "text-slate-500" : "text-slate-400"} block mb-2`}>Database Tools</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={handleDevExportDb}
                      className={`border font-bold py-2.5 rounded-xl text-[10px] uppercase tracking-wider flex items-center justify-center gap-1.5 transition-all ${lightMode ? "border-slate-200 text-slate-600 hover:bg-slate-50" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
                      <span className="material-symbols-outlined text-sm">download</span>
                      Export Backup
                    </button>
                    <button type="button" onClick={handleDevImportDb}
                      className={`border font-bold py-2.5 rounded-xl text-[10px] uppercase tracking-wider flex items-center justify-center gap-1.5 transition-all ${lightMode ? "border-rose-200 text-rose-600 hover:bg-rose-50" : "border-rose-500/30 text-rose-400 hover:bg-rose-950/30"}`}>
                      <span className="material-symbols-outlined text-sm">upload</span>
                      Import / Restore
                    </button>
                  </div>
                  <p className="text-[10px] text-rose-500 mt-1.5 font-medium">⚠ Import replaces ALL current data. A safety copy is made automatically first.</p>
                </div>

                {/* Printer tools */}
                <div className={`border-t pt-4 ${lightMode ? "border-slate-100" : "border-slate-800"}`}>
                  <label className={`text-[10px] font-black uppercase tracking-wider ${lightMode ? "text-slate-500" : "text-slate-400"} block mb-2`}>Printer Test</label>
                  <button type="button" onClick={handleDevReprintLast} disabled={isReprintingLast}
                    className={`w-full border font-bold py-2.5 rounded-xl text-[10px] uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-1.5 transition-all ${lightMode ? "border-slate-200 text-slate-600 hover:bg-slate-50" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
                    <span className="material-symbols-outlined text-sm">print</span>
                    {isReprintingLast ? 'Sending...' : 'Reprint Last Receipt'}
                  </button>
                  <p className={`text-[10px] ${lightMode ? "text-slate-400" : "text-slate-500"} mt-1.5`}>Reprints the most recent sale on the server's thermal printer — use this to test the printer without making a sale.</p>
                </div>

                {/* Save */}
                <button type="submit" disabled={isSavingConfig}
                  className="w-full bg-violet-600 text-white font-black py-3.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-sm">save</span>
                  {isSavingConfig ? 'Saving...' : 'Save & Restart App'}
                </button>
              </form>
            </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  return (
    <div
      className={`h-screen max-h-screen w-full flex flex-col overflow-hidden select-none font-sans antialiased ${lightMode ? "bg-slate-100 text-slate-900" : "bg-slate-950 text-slate-100"}`}
    >
      {/* GLOBAL NOTIFICATIONS */}
      {notification.isOpen && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
          <div
            className={`border p-6 rounded-2xl max-w-sm w-full shadow-2xl flex flex-col gap-4 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}
          >
            <div className="flex items-center gap-3">
              <span
                className={`material-symbols-outlined text-2xl ${notification.type === "error" ? "text-rose-500" : notification.type === "warning" ? "text-amber-500" : "text-emerald-500"}`}
              >
                {notification.type === "error"
                  ? "error"
                  : notification.type === "warning"
                    ? "warning"
                    : "check_circle"}
              </span>
              <div>
                <h3
                  className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}
                >
                  {notification.title}
                </h3>
                <p
                  className={`text-[11px] mt-0.5 font-medium leading-relaxed ${lightMode ? "text-slate-600" : "text-slate-400"}`}
                >
                  {notification.message}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={closeNotification}
              className="w-full bg-slate-800 text-white font-bold py-2 px-4 rounded-xl text-xs uppercase tracking-wider transition-colors hover:bg-slate-700"
            >
              Acknowledge
            </button>
          </div>
        </div>
      )}

      {/* GS1 COLLISION SELECTOR MODAL */}
      {pendingCollisions.length > 0 && (
        <div className="fixed inset-0 z-[200] bg-slate-950/80 flex items-center justify-center backdrop-blur-sm">
          <div
            className={`p-6 rounded-2xl max-w-lg w-full shadow-2xl ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}
          >
            <div className="flex items-center gap-2 mb-4">
              <span className="material-symbols-outlined text-emerald-500">
                barcode_scanner
              </span>
              <h2
                className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}
              >
                Select Formulation & Batch
              </h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Multiple inventory entries share this GS1 barcode sequence. Please
              select the specific physical item you scanned.
            </p>

            <div className="space-y-2 max-h-[50vh] overflow-y-auto custom-scrollbar pr-2">
              {pendingCollisions.map((prod, index) => (
  <div
    key={prod.id || `collision-${index}`}
    onClick={() => {
                    handleMagicScanSale(prod);
                    loadProductToCounter(prod);
                    setPendingCollisions([]);
                    setIsCartOpen(true);
                  }}
                  className={`border p-3 rounded-xl cursor-pointer transition-colors ${lightMode ? "bg-slate-50 border-slate-200 hover:border-emerald-500 shadow-sm" : "bg-slate-950 border-slate-800/80 hover:border-emerald-500 shadow-sm"}`}
                >
                  <div className="flex justify-between items-start">
                    <div className="font-black text-xs">{prod.name}</div>
                    <div className="font-mono text-[10px] text-emerald-500 font-bold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                      Rs. {Math.round(prod.retailPrice)}
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-1 font-bold">
                    Batch:{" "}
                    <span className="text-slate-400">
                      {prod.batch || "UNASSIGNED"}
                    </span>{" "}
                    | Stock: {prod.totalUnits} Units
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setPendingCollisions([])}
              className={`mt-4 w-full font-bold py-2.5 rounded-xl text-xs uppercase border ${lightMode ? "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"}`}
            >
              Cancel Scan
            </button>
          </div>
        </div>
      )}

      {/* TOP NAVIGATION BAR */}
      <nav
        className={`w-full z-50 flex justify-between items-center px-4 md:px-8 h-16 shrink-0 border-b ${lightMode ? "bg-white border-slate-200 shadow-sm" : "bg-slate-900/90 backdrop-blur-md border-slate-800"}`}
      >
        {/* LEFT NAV TOGGLE & LOGO */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className={`p-1.5 -ml-2 rounded-xl flex items-center justify-center transition-colors ${lightMode ? "hover:bg-slate-100 text-slate-700" : "hover:bg-slate-800 text-slate-300"}`}
          >
            <span className="material-symbols-outlined text-[24px]">menu</span>
          </button>
          <span className="text-xl font-black bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent tracking-tight uppercase">
            PharmTrack
          </span>
          <span
            className={`hidden md:inline-block text-[10px] font-mono tracking-widest uppercase border px-2 py-0.5 rounded-md font-bold ${lightMode ? "bg-slate-100 text-slate-600 border-slate-200" : "bg-slate-950 text-slate-400 border-slate-800"}`}
          >
            POS Core
          </span>
        </div>

        {/* CENTER SEARCH */}
        <div ref={searchContainerRef} className="flex-1 max-w-2xl mx-6 relative">
          <div className="relative group">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 text-lg">
              search
            </span>
            <input
              className={`w-full border rounded-xl py-2.5 pl-12 pr-4 text-sm focus:outline-none focus:ring-1 ${lightMode ? "bg-slate-50 border-slate-200 text-slate-900 focus:border-emerald-500" : "bg-slate-950/80 border-slate-800 text-slate-200 focus:border-emerald-500/60"}`}
              placeholder="Search formulations..."
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
            />
          </div>
          {searchResults.length > 0 && (
            <div
              className={`absolute top-14 left-0 w-full border rounded-xl shadow-2xl z-50 overflow-hidden divide-y ${lightMode ? "bg-white border-slate-200 divide-slate-100" : "bg-slate-900 border-slate-800 divide-slate-800/60"}`}
            >
              {searchResults.map((prod, index) => (
  <div
    key={prod.id ? `search-${prod.id}` : `search-idx-${index}`}
    onClick={() => {
                    loadProductToCounter(prod);
                    setCurrentTab("sales");
                  }}
                  className={`p-4 cursor-pointer flex justify-between items-center transition-colors ${lightMode ? "hover:bg-slate-50" : "hover:bg-slate-800/50"}`}
                >
                  <div>
                    <div
                      className={`text-sm font-black ${lightMode ? "text-slate-800" : "text-slate-200"}`}
                    >
                      {prod.name}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 flex items-center gap-2">
                      <span
                        className={`font-mono px-1.5 py-0.5 rounded border ${lightMode ? "bg-slate-100 border-slate-200" : "bg-slate-950 border-slate-800"}`}
                      >
                        Batch: {prod.batch}
                      </span>
                      <span className="truncate max-w-[200px]">
                        {prod.generic}
                      </span>
                    </div>
                  </div>
                  <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-xl">
                    Rs. {Math.round(prod.retailPrice)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT ACTION BUTTONS */}
        <div className="flex items-center gap-2 md:gap-4">
          {/* NO-PRINT TOGGLE — default OFF (receipts print normally).
              When ON, checkout still records the sale exactly as usual;
              only the print job is skipped. Session-only, resets on reload. */}
          {currentTab === "sales" && (
            <button
              type="button"
              onClick={() => setNoPrintMode((prev) => !prev)}
              title={noPrintMode ? "Receipt printing is OFF for checkouts" : "Receipt printing is ON (default)"}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                noPrintMode
                  ? (lightMode ? "bg-amber-100 border-amber-300 text-amber-700" : "bg-amber-500/10 border-amber-500/30 text-amber-400")
                  : (lightMode ? "bg-slate-50 border-slate-200 text-slate-500" : "bg-slate-800 border-slate-700 text-slate-400")
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">
                {noPrintMode ? "print_disabled" : "print"}
              </span>
              <span className="hidden md:inline uppercase tracking-wider">No Print</span>
              <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${noPrintMode ? "bg-amber-500" : lightMode ? "bg-slate-300" : "bg-slate-600"}`}>
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${noPrintMode ? "translate-x-3.5" : "translate-x-0.5"}`} />
              </span>
            </button>
          )}

          {/* CART DRAWER TOGGLE */}
          {currentTab === "sales" && (
            <button
              type="button"
              onClick={() => setIsCartOpen(!isCartOpen)}
              className={`relative p-2 rounded-xl border flex items-center justify-center transition-colors ${lightMode ? "bg-slate-50 border-slate-200 text-emerald-600 hover:bg-emerald-50" : "bg-slate-800 border-slate-700 text-emerald-400 hover:bg-slate-700"}`}
            >
              <span className="material-symbols-outlined text-[20px] font-bold">
                shopping_cart
              </span>
              {cart.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-black text-white shadow-sm">
                  {cart.length}
                </span>
              )}
            </button>
          )}

          {/* Server status indicator — only visible on client machines.
              Green = server reachable, Amber = server busy (checkout in progress),
              Red = server offline. Hidden on standalone/server machines since
              serverStatus is always 'online' there and the dot would be misleading. */}
          {serverStatus !== 'online' && (
            <div className={`flex items-center gap-2 border px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider ${
              serverStatus === 'busy'
                ? lightMode ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                : lightMode ? 'bg-rose-50 border-rose-200 text-rose-600' : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
            }`}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                serverStatus === 'busy' ? 'bg-amber-400 animate-pulse' : 'bg-rose-500 animate-pulse'
              }`} />
              {serverStatus === 'busy' ? 'Server Busy' : 'Server Offline'}
            </div>
          )}
          {serverStatus === 'online' && (
            <div title="Server connected" className={`flex items-center gap-1.5 border px-2.5 py-1.5 rounded-xl ${lightMode ? 'border-emerald-200 bg-emerald-50' : 'border-emerald-500/20 bg-emerald-500/10'}`}>
              <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
              <span className={`text-[10px] font-black uppercase tracking-wider ${lightMode ? 'text-emerald-700' : 'text-emerald-400'}`}>Online</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => setLightMode(!lightMode)}
            className={`p-2 rounded-xl border flex items-center justify-center transition-colors ${lightMode ? "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200" : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"}`}
          >
            <span className="material-symbols-outlined text-[20px] font-bold">
              {lightMode ? "dark_mode" : "light_mode"}
            </span>
          </button>
          <div
            onClick={() => {
              setIsAuthenticated(false);
              setIsEarningAuthenticated(false);
              setAuthForm({ username: "", password: "" });
              setEarningPinInput("");
            }}
            className={`cursor-pointer flex items-center gap-2 border px-3 py-1.5 rounded-xl transition-colors duration-200 ${lightMode ? "bg-slate-50 border-slate-200 text-slate-700 hover:border-rose-300" : "bg-slate-900 border-slate-800 text-slate-300 hover:border-rose-500/30"}`}
          >
            <div className="w-7 h-7 rounded-lg bg-slate-200 border border-slate-300 flex items-center justify-center font-black text-xs text-emerald-600">
              FR
            </div>
            <span className="hidden md:block text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold">
              Lock
            </span>
          </div>
        </div>
      </nav>

      {/* MAIN CONTENT AREA */}
      <div className="flex flex-1 h-[calc(100vh-64px)] w-full overflow-hidden min-h-0 relative">
        {/* INVISIBLE SPACER */}
        <div className={`shrink-0 transition-[width] duration-300 h-full ${isSidebarOpen ? "w-[84px] xl:w-[260px]" : "w-[84px]"}`} />

        {/* ACTUAL SIDEBAR */}
        <aside className={`absolute left-0 top-0 h-full z-[100] border-r shrink-0 transition-[all] duration-300 overflow-hidden ${
          isSidebarOpen ? "w-[260px] shadow-[20px_0_40px_rgba(0,0,0,0.1)] xl:shadow-none" : "w-[84px] shadow-none"
        } ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-900/95 backdrop-blur-2xl border-slate-800/80"}`}>
          
          <div className="flex flex-col gap-6 justify-between h-full p-4 md:p-5 w-full">
            <div className="space-y-6">
              
              {/* Header */}
              <div className={`flex items-center transition-all ${
                isSidebarOpen 
                  ? `gap-3.5 p-4 rounded-2xl border shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800/80"}` 
                  : "justify-center p-0 border-transparent bg-transparent shadow-none"
              }`}>
                <div className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center border text-emerald-500 shadow-inner ${lightMode ? "bg-slate-100 border-slate-200" : "bg-slate-800 border-slate-700"}`}>
                  <img src={receiptLogo} alt="Nouman Pharmacy" className="w-7 h-7 object-contain" />             
                </div>
                {isSidebarOpen && (
                  <div className="min-w-0 animate-in fade-in duration-300">
                    <h2 className="text-xs font-black text-slate-500 uppercase tracking-wider truncate">Main Register</h2>
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">Terminal ID 01</p>
                  </div>
                )}
              </div>

              {/* Navigation Links */}
              <nav className="space-y-2">
                <button onClick={() => { setCurrentTab("sales"); setIsEarningAuthenticated(false); setEarningPinInput(""); }} title={!isSidebarOpen ? "Sales Counter" : ""} className={`w-full flex items-center ${isSidebarOpen ? "gap-3.5 px-4" : "justify-center px-0"} py-3.5 rounded-xl font-bold text-left text-xs transition-all relative ${currentTab === "sales" ? "text-slate-950 bg-gradient-to-r from-emerald-400 to-teal-400 font-black shadow-lg shadow-emerald-500/10" : lightMode ? "text-slate-600 hover:bg-slate-200/60" : "text-slate-400 hover:bg-slate-900/40"}`}>
                  <span className="material-symbols-outlined text-lg shrink-0">point_of_sale</span>
                  {isSidebarOpen && <span className="truncate animate-in fade-in duration-300">Sales Counter</span>}
                </button>
                
                <button onClick={() => { setCurrentTab("inventory"); setIsEarningAuthenticated(false); setEarningPinInput(""); }} title={!isSidebarOpen ? "Stock Management" : ""} className={`w-full flex items-center ${isSidebarOpen ? "gap-3.5 px-4" : "justify-center px-0"} py-3.5 rounded-xl font-bold text-left text-xs transition-all relative ${currentTab === "inventory" ? "text-slate-950 bg-gradient-to-r from-emerald-400 to-teal-400 font-black shadow-md shadow-emerald-500/10" : lightMode ? "text-slate-600 hover:bg-slate-200/60" : "text-slate-400 hover:bg-slate-900/40"}`}>
                  <span className="material-symbols-outlined text-lg shrink-0">inventory_2</span>
                  {isSidebarOpen && <span className="truncate animate-in fade-in duration-300">Stock Management</span>}
                </button>
                
                <button onClick={() => { setCurrentTab("history"); setIsEarningAuthenticated(false); setEarningPinInput(""); }} title={!isSidebarOpen ? "Sales History" : ""} className={`w-full flex items-center ${isSidebarOpen ? "gap-3.5 px-4" : "justify-center px-0"} py-3.5 rounded-xl font-bold text-left text-xs transition-all relative ${currentTab === "history" ? "text-slate-950 bg-gradient-to-r from-emerald-400 to-teal-400 font-black shadow-lg shadow-emerald-500/10" : lightMode ? "text-slate-600 hover:bg-slate-200/60" : "text-slate-400 hover:bg-slate-900/40"}`}>
                  <span className="material-symbols-outlined text-lg shrink-0">analytics</span>
                  {isSidebarOpen && <span className="truncate animate-in fade-in duration-300">Sales History</span>}
                </button>
                
                <button onClick={() => setCurrentTab("earnings")} title={!isSidebarOpen ? "Manager Vault" : ""} className={`w-full flex items-center ${isSidebarOpen ? "gap-3.5 px-4" : "justify-center px-0"} py-3.5 rounded-xl font-bold text-left text-xs transition-all relative ${currentTab === "earnings" ? "text-slate-950 bg-gradient-to-r from-amber-400 to-orange-400 font-black shadow-lg" : lightMode ? "text-slate-600 hover:bg-slate-200/60" : "text-slate-400 hover:bg-slate-900/40"}`}>
                  <span className="material-symbols-outlined text-lg shrink-0">admin_panel_settings</span>
                  {isSidebarOpen && <span className="truncate animate-in fade-in duration-300">Manager Vault</span>}
                </button>
              </nav>
            </div>
            
            {/* Footer */}
            {isSidebarOpen && (
              <div className="text-[10px] text-slate-400 font-mono text-center border-t pt-4 border-slate-200/40 truncate animate-in fade-in duration-300">PharmTrack Stable App</div>
            )}
          </div>
        </aside>
        
        {/* DYNAMIC CENTER SCREEN */}
        <div className="flex-1 flex overflow-hidden min-h-0 w-full h-full relative z-0">
          {currentTab === "sales" ? (
            <div className="flex-1 flex overflow-hidden min-h-0 w-full h-full">
              {/* CENTER PRODUCT CARDS */}
              <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar h-full min-h-0">
                {activeProducts.length > 0 ? (
                  <div className="flex flex-col gap-4 w-full h-fit max-w-4xl mx-auto">
                    {activeProducts.map((product, index) => (
                      <SalesCounter
                        key={product.id || `active-card-${index}`}
                        activeProduct={product}
                        onAddItem={(prod, type, tabletQty) =>
                          handleAddItemToCart(prod, type, tabletQty)
                        }
                        onDismiss={() => handleDismissProduct(product.id)}
                        lightMode={lightMode}
                        cart={cart}
                      />
                    ))}
                  </div>
                ) : (
                  <div
                    className={`h-full flex flex-col items-center justify-center gap-4 border-2 border-dashed m-2 rounded-2xl ${lightMode ? "border-slate-300 bg-slate-50 text-slate-400" : "border-slate-900 bg-slate-900/5 text-slate-600"}`}
                  >
                    <span className="material-symbols-outlined text-5xl animate-pulse text-emerald-500/50">
                      barcode_scanner
                    </span>
                    <p className="text-xs font-bold tracking-widest uppercase">
                      Hardware Scanner Active
                    </p>
                    <p className="text-[10px] font-medium text-slate-500 text-center max-w-xs mt-2">
                      Scan a product to automatically add it to the cart, or use
                      the search bar above to look up products manually.
                    </p>
                  </div>
                )}
              </div>

              {/* COLLAPSIBLE RIGHT CART DRAWER */}
              <section
                className={`${isCartOpen ? "w-[320px] xl:w-[400px] border-l" : "w-0 border-l-0"} shrink-0 h-full shadow-[0_0_40px_rgba(0,0,0,0.1)] z-10 transition-[width,border] duration-300 overflow-hidden ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/40 backdrop-blur-md border-slate-800"}`}
              >
                <div className="w-[320px] xl:w-[400px] h-full flex flex-col">
                  <div
                    className={`p-4 border-b flex justify-between items-center shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-900/80 border-slate-800/80"}`}
                  >
                    <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest">
                      Current Sale Basket
                    </h2>
                    {cart.length > 0 && (
                      <button
                        onClick={handleClearCart}
                        className="text-slate-500 hover:text-rose-400 flex items-center gap-1 text-xs font-bold transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  <div
                    className={`flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar min-h-0 ${lightMode ? "bg-slate-50/50" : "bg-slate-950/20"}`}
                  >
                    {cart.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-2">
                        <span className="material-symbols-outlined text-4xl mb-1 opacity-50">
                          shopping_basket
                        </span>
                        <p className="text-xs font-bold tracking-wide uppercase">
                          Basket is empty
                        </p>
                      </div>
                    ) : (
                      cart.map((item, index) => (
                        <div
                          key={item.id || `cart-item-${index}`}
                          className={`border rounded-xl p-3 flex flex-col gap-2 shadow-sm transition-all ${lightMode ? "bg-white border-slate-200 hover:border-slate-300" : "bg-slate-900/80 border-slate-800 hover:border-slate-700"}`}
                        >
                          <div className="flex justify-between items-start">
                            <div className="flex-1 min-w-0 pr-2">
                              <h3
                                className={`text-xs font-black truncate ${lightMode ? "text-slate-800" : "text-slate-100"}`}
                              >
                                {item.name}
                              </h3>
                              <div className="flex items-center gap-2 mt-1">
                                <span
                                  className={`font-mono text-[9px] px-1.5 py-0.5 border rounded ${lightMode ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-slate-950 border-slate-800/60 text-slate-500"}`}
                                >
                                  Batch: {item.batch}
                                </span>
                                <span className="text-slate-500 font-mono text-[9px]">
                                  @ Rs. {Math.round(item.price)}
                                </span>
                              </div>
                            </div>
                            <span className="font-mono text-sm font-black text-emerald-500 shrink-0">
                              Rs. {Math.round(item.price * item.qty)}
                            </span>
                          </div>

                          <div
                            className={`flex items-center justify-between border-t pt-2 ${lightMode ? "border-slate-100" : "border-slate-800/60"}`}
                          >
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setCart((prevCart) => {
                                    const target = prevCart.find(
                                      (i) => i.id === item.id,
                                    );
                                    if (!target) return prevCart;
                                    if (target.qty <= 1)
                                      return prevCart.filter(
                                        (i) => i.id !== item.id,
                                      );
                                    return prevCart.map((i) =>
                                      i.id === item.id
                                        ? { ...i, qty: i.qty - 1 }
                                        : i,
                                    );
                                  });
                                }}
                                className={`w-6 h-6 border rounded-md flex items-center justify-center text-slate-400 hover:text-rose-400 ${lightMode ? "bg-slate-100 border-slate-200" : "bg-slate-950 border-slate-800"}`}
                              >
                                <span className="material-symbols-outlined text-[14px] font-black">
                                  remove
                                </span>
                              </button>

                              <div
                                className={`flex flex-col items-center min-w-[36px] px-1 py-0.5 border rounded-md ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800/80"}`}
                              >
                                <span className="font-black text-emerald-500 font-mono text-xs leading-none">
                                  {item.qty}
                                </span>
                                <span className="text-[7px] text-slate-500 font-black uppercase tracking-wider">
                                  {item.type}
                                </span>
                              </div>

                              <button
                                type="button"
                                onClick={() => {
                                  const dbMatch = inventory.find((p) => p.id.toString() === item.productId);
                                  const activeMatch = activeProducts.find((p) => p.id === item.productId);
                                  const maxTotalUnits = dbMatch ? dbMatch.totalUnits : (activeMatch ? activeMatch.totalUnitsAvailable : 0);
                                  const tabletsPerStripForItem = parseInt((dbMatch && dbMatch.tabletsPerStrip) || (activeMatch && activeMatch.tabletsPerStrip)) || 0;

                                  if (tabletsPerStripForItem > 0) {
                                    // Tablet-aware check — same math as the initial Add
                                    // click. Converts every cart line for this product
                                    // (Box/Strip/Tablet) into tablets and checks against
                                    // real available tablets, which accounts for
                                    // whatever's already been sold off a currently-open
                                    // strip. This is what stops "+" from silently pushing
                                    // past real stock before an error ever shows up.
                                    const openStripTablets = parseInt((dbMatch && dbMatch.openStripTablets) || (activeMatch && activeMatch.openStripTablets)) || 0;
                                    let tabletsInCart = 0;
                                    cart.forEach((cItem) => {
                                      if (cItem.productId === item.productId) {
                                        tabletsInCart += cItem.type === "Tablet"
                                          ? cItem.qty
                                          : cItem.rawUnits * cItem.qty * tabletsPerStripForItem;
                                      }
                                    });
                                    const availableTablets = (maxTotalUnits * tabletsPerStripForItem) - openStripTablets;
                                    const tabletsNeededForOneMore = item.type === "Tablet" ? 1 : item.rawUnits * tabletsPerStripForItem;

                                    if (tabletsInCart + tabletsNeededForOneMore > availableTablets) {
                                      showNotification(
                                        "Limit Exceeded",
                                        "Insufficient inventory stock to add more.",
                                        "warning",
                                      );
                                      return;
                                    }
                                  } else {
                                    let currentUnitsInCart = 0;
                                    cart.forEach((cItem) => {
                                      if (cItem.productId === item.productId)
                                        currentUnitsInCart +=
                                          cItem.rawUnits * cItem.qty;
                                    });

                                    if (currentUnitsInCart + item.rawUnits > maxTotalUnits) {
                                      showNotification(
                                        "Limit Exceeded",
                                        "Insufficient inventory stock to add more.",
                                        "warning",
                                      );
                                      return;
                                    }
                                  }
                                  setCart((prevCart) =>
                                    prevCart.map((i) =>
                                      i.id === item.id
                                        ? { ...i, qty: i.qty + 1 }
                                        : i,
                                    ),
                                  );
                                }}
                                className={`w-6 h-6 border rounded-md flex items-center justify-center text-slate-400 hover:text-emerald-400 ${lightMode ? "bg-slate-100 border-slate-200" : "bg-slate-950 border-slate-800"}`}
                              >
                                <span className="material-symbols-outlined text-[14px] font-black">
                                  add
                                </span>
                              </button>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider">
                                Disc
                              </span>
                              <div className="relative w-16">
                                <input
                                  type="number"
                                  min="0"
                                  max="50"
                                  step="1"
                                  placeholder="0"
                                  value={item.itemDiscountPercent || ""}
                                  onChange={(e) =>
                                    handleItemDiscountChange(
                                      item.id,
                                      e.target.value,
                                    )
                                  }
                                  className={`w-full bg-transparent border rounded-md py-1 pr-4 pl-1 focus:outline-none text-right font-mono font-bold text-xs ${lightMode ? "border-slate-300 text-slate-800 focus:border-emerald-500" : "border-slate-700 text-emerald-400 focus:border-emerald-500"}`}
                                />
                                <span className="absolute right-1 top-1/2 -translate-y-1/2 font-mono text-[9px] text-slate-500 font-black">
                                  %
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div
                    className={`border-t p-5 flex flex-col gap-3.5 shrink-0 ${lightMode ? "bg-slate-50 border-slate-200 shadow-inner" : "bg-slate-950 border-slate-800 shadow-2xl"}`}
                  >
                    <div
                      className={`flex justify-between items-center gap-4 border p-3 rounded-xl ${lightMode ? "bg-white border-slate-200 shadow-sm" : "bg-gradient-to-r from-slate-900 to-slate-900 border-slate-800"}`}
                    >
                      <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider">
                        <span className="material-symbols-outlined text-slate-500 text-sm">
                          percent
                        </span>
                        <span>Whole Bill Discount</span>
                      </div>
                      <div className="relative w-24">
                        <input
                          type="number"
                          min="0"
                          max="50"
                          disabled={cart.length === 0}
                          placeholder="0"
                          value={discountPercent}
                          onChange={(e) => {
                            let val = Math.round(parseFloat(e.target.value));
                            if (val > 50) val = 50;
                            else if (val < 0 || isNaN(val)) val = "";
                            setDiscountPercent(val);
                          }}
                          className={`w-full border rounded-lg py-1 px-3 text-right font-mono text-sm font-bold focus:outline-none disabled:opacity-40 shadow-inner transition-colors ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-emerald-400 focus:border-emerald-500"}`}
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-500 font-bold pointer-events-none">
                          %
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2 border-b pb-3 text-xs font-bold uppercase tracking-wider text-slate-500 border-slate-200/20">
                      <div className="flex justify-between items-center">
                        <span>Gross Total</span>
                        <span
                          className={`font-mono font-bold ${lightMode ? "text-slate-700" : "text-slate-300"}`}
                        >
                          Rs. {baseSubTotal}
                        </span>
                      </div>
                      {totalDiscountDeduction > 0 && (
                        <div className="flex justify-between items-center text-rose-500 font-bold text-xs mt-1">
                          <span className="uppercase tracking-wider font-bold">
                            Total Discount Deducted
                          </span>
                          <span className="font-mono">
                            - Rs. {Math.round(totalDiscountDeduction)}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-500 font-bold uppercase tracking-widest border-b pb-3 border-slate-200/20">
                      <div className="flex justify-between items-center pr-2 border-r border-slate-200/20">
                        <span>Distinct Rows</span>
                        <span
                          className={`font-mono text-xs font-black ${lightMode ? "text-slate-700" : "text-slate-300"}`}
                        >
                          {cart.length}
                        </span>
                      </div>
                      <div className="flex justify-between items-center pl-1">
                        <span>Total Items</span>
                        <span
                          className={`font-mono text-xs font-black ${lightMode ? "text-slate-700" : "text-slate-300"}`}
                        >
                          {totalItemPacksCount}
                        </span>
                      </div>
                    </div>

                    <div className="flex justify-between items-end mt-1">
                      <span className="text-xs text-slate-400 font-bold mb-0.5 uppercase tracking-wider">
                        Grand Total Due
                      </span>
                      <span className="text-3xl font-black text-emerald-500 font-mono tracking-tighter">
                        Rs. {grandTotalDue}
                      </span>
                    </div>
                    <button
                      disabled={cart.length === 0 || isProcessingSale}
                      onClick={handleCheckoutSale}
                      className={`w-full font-black py-4 rounded-xl text-xs flex justify-center items-center gap-2 mt-2 shadow-xl tracking-wide uppercase transition-all ${cart.length === 0 || isProcessingSale ? "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/20" : "bg-gradient-to-r from-emerald-400 to-teal-400 text-slate-950 hover:opacity-90 active:scale-[0.99]"}`}
                    >
                      <span className="material-symbols-outlined font-bold text-sm">
                        receipt_long
                      </span>
                      {isProcessingSale ? "Processing..." : "Complete Sale"}
                    </button>
                  </div>
                </div>
              </section>
            </div>
          ) : currentTab === "inventory" ? (
            <div className="flex-1 flex overflow-hidden w-full h-full bg-slate-950 min-h-0">
              <StockManagement
                inventory={inventory}
                onAddNewStock={handleSaveStockToDB}
                onQuickRestock={handleQuickRestock}
                onDeleteStock={handleDeleteStockFromDB}
                lightMode={lightMode}
                scannedData={scannedInventoryData}
                clearScannedData={() => setScannedInventoryData(null)}
              />
            </div>
          ) : currentTab === "history" ? (
            <div className="flex-1 flex overflow-hidden w-full h-full bg-slate-950 min-h-0">
              <SalesHistory
                salesHistory={salesHistory}
                lightMode={lightMode}
                onTriggerRefresh={() => {
                  refreshStockLedger();
                  refreshSalesHistory();
                }}
                onNotify={showNotification}
                scannedInvoiceId={scannedInvoiceId}
                clearScannedInvoice={() => setScannedInvoiceId(null)}
              />
            </div>
          ) : (
            <div className="flex-1 flex overflow-hidden w-full h-full min-h-0">
              {!isEarningAuthenticated ? (
                <div
                  className={`flex-1 flex items-center justify-center p-6 ${lightMode ? "bg-slate-100" : "bg-slate-950"}`}
                >
                  <div
                    className={`border p-8 rounded-3xl max-w-sm w-full shadow-2xl flex flex-col gap-5 text-center relative ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}
                  >
                    <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500">
                      <span className="material-symbols-outlined text-2xl">
                        admin_panel_settings
                      </span>
                    </div>
                    <div className="space-y-1">
                      <h3
                        className={`text-base font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}
                      >
                        Manager Vault
                      </h3>
                      <p
                        className={`text-xs ${lightMode ? "text-slate-500" : "text-slate-400"}`}
                      >
                        Credentials authorization required to view sensitive
                        cash parameters.
                      </p>
                    </div>
                    <form
                      onSubmit={handleVerifyEarningSecureAccess}
                      className="space-y-4"
                    >
                      <input
                        type="password"
                        required
                        placeholder="Enter master security pin..."
                        value={earningPinInput}
                        onChange={(e) => setEarningPinInput(e.target.value)}
                        className={`w-full text-center tracking-widest font-mono text-sm border rounded-xl py-2.5 px-4 focus:outline-none focus:border-amber-500 ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800" : "bg-slate-950 border-slate-800 text-slate-200 focus:bg-slate-900"}`}
                      />
                      <button
                        type="submit"
                        className="w-full bg-gradient-to-r from-amber-400 to-orange-400 text-slate-950 font-black py-3 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-95 transition-all"
                      >
                        Authorize Access
                      </button>
                    </form>
                  </div>
                </div>
              ) : (
                <OwnerEarnings
                  inventory={inventory}
                  salesHistory={salesHistory}
                  lightMode={lightMode}
                  onDeleteReturnTranscript={handleDeleteReturnTranscript}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;