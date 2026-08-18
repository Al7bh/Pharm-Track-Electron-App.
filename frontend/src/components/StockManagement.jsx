import React, { useState, useEffect, useRef } from "react";
import { ALL_CATEGORIES, categorizeProduct } from "../utils/categorize";

function StockManagement({ inventory, onAddNewStock, onQuickRestock, onDeleteStock, lightMode, scannedData, clearScannedData, onGoToRestock, isActiveTab }) {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = String(currentDate.getMonth() + 1).padStart(2, "0");
  const minExpiryDateString = `${currentYear}-${currentMonth}`;

  const [formData, setFormData] = useState({
    barcode: "",
    name: "",
    generic: "",
    batch: "",
    expiry: "",
    boxes: "",
    strips: "",
    factor: 2,
    buyingPrice: "",
    retailPrice: "",
    // Feature: tablet-level sales. 0/blank = this product is not sellable
    // by the tablet — the sales screen shows only the existing Box/Strip
    // options for it, unchanged. Does NOT affect totalUnits tracking.
    tabletsPerStrip: ""
  });

  const [isEditMode, setIsEditMode] = useState(false);
  const [targetEditId, setTargetEditId] = useState(null);
  // In-flight guards: without these a double-click created duplicate rows /
  // double restocks, because every write here is non-idempotent.
  const [isSavingStock, setIsSavingStock] = useState(false);
  const [isRestocking, setIsRestocking] = useState(false);
  // Timestamp of the last keydown, used to tell scanner bursts from real keys.
  const lastKeyTimeRef = useRef(0);
  // Refs used to restore cursor position after auto-capitalizing the
  // name/generic fields (see handleInputChange) — without this, inserting
  // a word before existing text bounces the cursor to the end.
  const nameInputRef = useRef(null);
  const genericInputRef = useRef(null);
  // Separate month/year entry for expiry (see ExpiryDateFields below) so
  // typing a date never fights a native browser widget mid-entry.
  const [expiryMonth, setExpiryMonth] = useState("");
  const [expiryYear, setExpiryYear] = useState("");

  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [stockSearchQuery, setStockSearchQuery] = useState("");
  // null = "All categories". Categories are inferred from the product name
  // (see utils/categorize.js) — nothing is stored in the database for this.
  const [categoryFilter, setCategoryFilter] = useState(null);
  const [stockFilterMode, setStockFilterMode] = useState("all");
  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState("asc");

  // ==========================================
  // QUICK-RESTOCK STATES
  // ==========================================
  const [pendingStockCollisions, setPendingStockCollisions] = useState([]);
  const [quickAddDialog, setQuickAddDialog] = useState({
    isOpen: false,
    targetItem: null,
    addBoxes: "",
    addStrips: ""
  });

  const [deleteDialog, setDeleteDialog] = useState({
    isOpen: false,
    itemId: null,
    itemName: "",
  });

  const [validationDialog, setValidationDialog] = useState({
    isOpen: false,
    message: "",
  });

  // Shown whenever a barcode matches an EXISTING product but under a
  // different batch than any already on file — instead of silently
  // assuming "this must be a new batch" (which is what let a mis-scanned
  // or manually-corrected batch code create a duplicate row), this makes
  // the user explicitly choose. Triggered from both the scan interceptor
  // and the manual Add form submit.
  const [batchMismatchDialog, setBatchMismatchDialog] = useState({
    isOpen: false,
    barcode: "",
    productName: "",
    existingBatches: [], // [{ batch, expiry }]
    // What to do if the user confirms "yes, this really is a new batch".
    // For the scan path this fills the form; for manual submit it re-runs
    // handleSubmit with the check bypassed.
    onConfirmNewBatch: null,
  });

  const ackButtonRef = useRef(null);
  const quickAddInputRef = useRef(null);

  // ==========================================
  // SMART BARCODE INTERCEPTOR
  // ==========================================
  // ==========================================
  // SMART BARCODE INTERCEPTOR
  // ==========================================
  useEffect(() => {
    if (scannedData && scannedData.gtin) {
      setStockSearchQuery("");

      // Match against every candidate form of this scan, not just the
      // clean GTIN — an older row may still have the raw/unparsed scan
      // stored as its barcode from before the parser recognized this
      // format. See gs1Parser.js's "LEGACY-DATA LOOKUP COMPATIBILITY"
      // section for why this list has more than one entry.
      const scanCandidates = scannedData.lookupCandidates && scannedData.lookupCandidates.length
        ? scannedData.lookupCandidates
        : [scannedData.gtin];
      const matchesByBarcode = inventory.filter((item) => scanCandidates.includes(item.barcode));

      if (matchesByBarcode.length > 0) {
        // 1. IF GS1 BARCODE (Contains embedded Batch info)
        if (scannedData.batch) {
          const exactMatch = matchesByBarcode.find(item => item.batch === scannedData.batch);
          
          if (exactMatch) {
            // We have this exact Batch already -> Quick Restock
            setQuickAddDialog({ isOpen: true, targetItem: exactMatch, addBoxes: "", addStrips: "" });
          } else {
            // Barcode matches, but no batch on file matches this scan. This
            // used to silently assume "must be a new batch" and pre-fill the
            // Add form — which is exactly how a mis-scanned or manually-
            // corrected batch code created duplicate rows. Ask instead.
            const template = matchesByBarcode[0];
            setBatchMismatchDialog({
              isOpen: true,
              barcode: scannedData.gtin,
              productName: template.name,
              existingBatches: matchesByBarcode.map((it) => ({ batch: it.batch, expiry: it.expiry })),
              onConfirmNewBatch: () => {
                setFormData((prev) => ({
                  ...prev,
                  barcode: scannedData.gtin,
                  batch: scannedData.batch,
                  expiry: scannedData.expiry || "",
                  name: template.name,
                  generic: template.generic,
                  factor: template.factor,
                  buyingPrice: template.buyingPrice,
                  retailPrice: template.retailPrice,
                  boxes: "",
                  strips: ""
                }));
                setTimeout(() => {
                  const boxesInput = document.getElementsByName("boxes")[0];
                  if (boxesInput) boxesInput.focus();
                }, 10);
              },
            });
          }
        } else {
          // 2. IF STANDARD 1D BARCODE (No Batch info embedded in the scan)
          if (matchesByBarcode.length === 1) {
            setQuickAddDialog({ isOpen: true, targetItem: matchesByBarcode[0], addBoxes: "", addStrips: "" });
          } else {
            setPendingStockCollisions(matchesByBarcode);
          }
        }
      } else {
        // 3. NO MATCH AT ALL -> Populate form for a brand new product
        setFormData((prev) => {
          if (prev.barcode !== "" && prev.barcode === scannedData.gtin && prev.batch === (scannedData.batch || "")) {
            return prev; 
          }

          setTimeout(() => {
            const nameInput = document.getElementById("stock-name-input");
            if (nameInput) nameInput.focus();
          }, 10);

          return {
            ...prev,
            barcode: scannedData.gtin || "",
            batch: scannedData.batch || "",
            expiry: scannedData.expiry || "",
            name: formatTitleCase(scannedData.name || ""),
            retailPrice: scannedData.retailPrice || "",
            boxes: "",
            strips: "",
            buyingPrice: ""
          };
        });
      }
      
      if (clearScannedData) clearScannedData();
    }
  }, [scannedData, clearScannedData, inventory]);
  
  // Focus the quick add input automatically when the modal opens
  useEffect(() => {
    if (quickAddDialog.isOpen && quickAddInputRef.current) {
      quickAddInputRef.current.focus();
    }
  }, [quickAddDialog.isOpen]);

  useEffect(() => {
    // This component stays mounted (just visually hidden) when the user
    // switches to another tab, so its state — including any dialog left
    // open — persists in the background. Without this guard, that meant
    // a plain Enter/Escape pressed anywhere ELSE in the app (typing on
    // Sales, scanning on Restock) would silently act on a dialog the user
    // can't even see — e.g. confirming a delete they never looked at
    // again. Gating on isActiveTab keeps the "state persists across tabs"
    // behavior while making sure only keys pressed WHILE this screen is
    // actually the one on-screen can do anything.
    if (!isActiveTab) return;

    const handleStockDialogKeys = (e) => {
      // A barcode scanner types its payload and then sends Enter, all within a
      // few milliseconds. A stray scan with the delete dialog open used to
      // silently confirm the deletion, so ignore an Enter that arrives hot on
      // the heels of another key — a human confirming has a much larger gap.
      const now = Date.now();
      const gapSinceLastKey = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      if (deleteDialog.isOpen) {
        if (e.key === "Enter") {
          e.preventDefault();
          if (gapSinceLastKey < 150) return; // scanner burst, not a confirmation
          if (deleteDialog.itemId) onDeleteStock(deleteDialog.itemId);
          setDeleteDialog({ isOpen: false, itemId: null, itemName: "" });
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDeleteDialog({ isOpen: false, itemId: null, itemName: "" });
        }
      }

      if (validationDialog.isOpen) {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          setValidationDialog({ isOpen: false, message: "" });
        }
      }

      if (pendingStockCollisions.length > 0 && e.key === "Escape") {
        e.preventDefault();
        setPendingStockCollisions([]);
      }

      if (quickAddDialog.isOpen && e.key === "Escape") {
        e.preventDefault();
        setQuickAddDialog({ isOpen: false, targetItem: null, addBoxes: "", addStrips: "" });
      }

      if (batchMismatchDialog.isOpen && e.key === "Escape") {
        e.preventDefault();
        setBatchMismatchDialog({ isOpen: false, barcode: "", productName: "", existingBatches: [], onConfirmNewBatch: null });
      }
    };
    window.addEventListener("keydown", handleStockDialogKeys);
    return () => window.removeEventListener("keydown", handleStockDialogKeys);
  }, [isActiveTab, deleteDialog.isOpen, validationDialog.isOpen, pendingStockCollisions.length, quickAddDialog.isOpen, onDeleteStock]);


  useEffect(() => {
    if (validationDialog.isOpen && ackButtonRef.current) {
      ackButtonRef.current.focus();
    }
  }, [validationDialog.isOpen]);

  const isExpiringWithinCustomThreshold = (expiryString) => {
    if (!expiryString || expiryString === "N/A" || !expiryString.includes("-")) return false;
    const [year, month] = expiryString.split("-").map(num => parseInt(num, 10));
    const expiryDateObj = new Date(year, month, 0);
    const thresholdDateBoundary = new Date();
    thresholdDateBoundary.setMonth(thresholdDateBoundary.getMonth() + 6);
    thresholdDateBoundary.setDate(thresholdDateBoundary.getDate() + 10);
    return expiryDateObj <= thresholdDateBoundary;
  };

  const formatTitleCase = (str) => {
    if (!str) return "";
    return str.split(' ').map(word => {
      if (word.length === 0) return "";
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
  };

  const handleInputChange = (e) => {
    let { name, value } = e.target;
    if (name === "name" || name === "generic") {
      // formatTitleCase only ever changes casing, never length, so the
      // caret's character offset stays valid after the transform — we
      // just have to tell the browser to put it back there, since setting
      // a controlled input's value collapses the selection to the end by
      // default.
      const inputEl = e.target;
      const caret = inputEl.selectionStart;
      value = formatTitleCase(value);
      setFormData((prev) => ({ ...prev, [name]: value }));
      requestAnimationFrame(() => {
        if (document.activeElement === inputEl) {
          inputEl.setSelectionRange(caret, caret);
        }
      });
      return;
    }
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  // ==========================================
  // EXPIRY DATE — separate Month/Year fields
  // ==========================================
  // Keeps Month/Year in sync whenever expiry is set from elsewhere (a
  // barcode scan, loading an item to edit, or Clear Form).
  useEffect(() => {
    if (formData.expiry && /^\d{4}-\d{2}$/.test(formData.expiry)) {
      const [y, m] = formData.expiry.split("-");
      setExpiryYear(y);
      setExpiryMonth(m);
    } else if (!formData.expiry) {
      setExpiryYear("");
      setExpiryMonth("");
    }
  }, [formData.expiry]);

  // Only commits into formData.expiry once both Month and Year are
  // complete — this is what lets the user type at their own pace instead
  // of the field being force-cleared on an incomplete intermediate value.
  const commitExpiry = (month, year) => {
    const monthNum = parseInt(month, 10);
    const isValidMonth = /^\d{1,2}$/.test(month) && monthNum >= 1 && monthNum <= 12;
    if (isValidMonth && /^\d{4}$/.test(year)) {
      const paddedMonth = String(monthNum).padStart(2, "0");
      setFormData((prev) => ({ ...prev, expiry: `${year}-${paddedMonth}` }));
    } else if (!month && !year) {
      setFormData((prev) => ({ ...prev, expiry: "" }));
    }
  };

  const handleExpiryMonthChange = (e) => {
    const month = e.target.value.replace(/\D/g, "").slice(0, 2);
    setExpiryMonth(month);
    commitExpiry(month, expiryYear);
  };

  const handleExpiryYearChange = (e) => {
    const year = e.target.value.replace(/\D/g, "").slice(0, 4);
    setExpiryYear(year);
    commitExpiry(expiryMonth, year);
  };

  // ==========================================
  // QUICK-RESTOCK SUBMISSION
  // ==========================================
  const handleQuickAddSubmit = async (e) => {
    e.preventDefault();
    const item = quickAddDialog.targetItem;
    if (!item) return;

    const packFactor = parseInt(item.factor) || 2;
    const bToAdd = parseInt(quickAddDialog.addBoxes) || 0;
    const sToAdd = parseInt(quickAddDialog.addStrips) || 0;
    const unitsToAdd = (bToAdd * packFactor) + sToAdd;

    if (unitsToAdd <= 0) {
setValidationDialog({
        isOpen: true,
        message: "Enter boxes or strips to add.",
      });
      return;
    }

    // Send a DELTA, never `snapshot + delta`. targetItem was frozen when the
    // dialog opened; recomputing an absolute total from it wiped out any sale
    // another till made in the meantime.
    if (isRestocking) return;
    setIsRestocking(true);
    const ok = await onQuickRestock(item.id, unitsToAdd);
    setIsRestocking(false);
    if (ok) {
      setQuickAddDialog({ isOpen: false, targetItem: null, addBoxes: "", addStrips: "" });
    }
  };

  const handleTriggerEdit = (med) => {
    setIsEditMode(true);
    setTargetEditId(med.id);
    const currentBoxes = Math.floor((med.totalUnits || 0) / (med.factor || 2));
    const currentStrips = (med.totalUnits || 0) % (med.factor || 2);
    
    setFormData({
      barcode: med.barcode || "",
      name: med.name || "",
      generic: med.generic === "N/A" ? "" : med.generic,
      batch: med.batch || "",
      expiry: med.expiry === "N/A" ? "" : med.expiry,
      boxes: currentBoxes || "",
      strips: currentStrips || "",
      factor: med.factor || 2,
      buyingPrice: Math.round(med.buyingPrice) || "",
      retailPrice: Math.round(med.retailPrice) || "",
      tabletsPerStrip: med.tabletsPerStrip || ""
    });
  };

  const handleCancelEdit = () => {
    setIsEditMode(false);
    setTargetEditId(null);
    setFormData({
      barcode: "",
      name: "",
      generic: "",
      batch: "",
      expiry: "",
      boxes: "",
      strips: "",
      factor: 2,
      buyingPrice: "",
      retailPrice: "",
      tabletsPerStrip: ""
    });
  };

  const handleSubmit = async (e, bypassBatchMismatchCheck = false) => {
    e.preventDefault();
    if (isSavingStock) return;
    if (!formData.name || !formData.batch || !formData.retailPrice || !formData.buyingPrice) {
setValidationDialog({
        isOpen: true,
        message: "Name, Batch, Buying Price, and Retail Price are required.",
      });
      return;
    }

    if (formData.tabletsPerStrip && (parseInt(formData.tabletsPerStrip) <= 0 || !/^\d+$/.test(formData.tabletsPerStrip))) {
      setValidationDialog({
        isOpen: true,
        message: "Tablets per strip must be a whole number above 0, or left blank.",
      });
      return;
    }

    const buyPriceRounded = Math.round(parseFloat(formData.buyingPrice)) || 0;
    const retailPriceRounded = Math.round(parseFloat(formData.retailPrice)) || 0;

    if (retailPriceRounded < buyPriceRounded) {
setValidationDialog({
        isOpen: true,
        message: "Retail price can't be lower than buying price.",
      });
      return;
    }

    if ((expiryMonth || expiryYear) && !formData.expiry) {
      setValidationDialog({
        isOpen: true,
        message: "Enter a valid expiry: month (1-12) and 4-digit year.",
      });
      return;
    }

    if (formData.expiry && formData.expiry < minExpiryDateString) {
      setValidationDialog({
        isOpen: true,
        message: "Expiry date is in the past.",
      });
      return;
    }

    // ==============================================================
    // THE SILENT DUPLICATE SHIELD
    // Prevent the user from manually typing a barcode and batch that already exists!
    // ==============================================================
    if (!isEditMode && formData.barcode) {
      const typedBatch = formData.batch.trim().toUpperCase();
      const matchesByBarcode = inventory.filter(item => item.barcode === formData.barcode.trim());
      const exactMatch = matchesByBarcode.find(item => item.batch === typedBatch);

      if (exactMatch) {
        setValidationDialog({
          isOpen: true,
          message: "Already exists — use Restock instead.",
        });
        return;
      }

      // Barcode matches an existing product, but under a different batch —
      // this is exactly the scenario that used to sail through silently and
      // create a duplicate row. Ask, rather than assume.
      if (!bypassBatchMismatchCheck && matchesByBarcode.length > 0) {
        setBatchMismatchDialog({
          isOpen: true,
          barcode: formData.barcode.trim(),
          productName: matchesByBarcode[0].name,
          existingBatches: matchesByBarcode.map((it) => ({ batch: it.batch, expiry: it.expiry })),
          onConfirmNewBatch: () => handleSubmit(e, true),
        });
        return;
      }
    }

    const packFactor = parseInt(formData.factor) || 2;
    const totalUnitsCalculated = (parseInt(formData.boxes) || 0) * packFactor + (parseInt(formData.strips) || 0);

    const stockItemPayload = {
      id: isEditMode ? targetEditId : Date.now().toString(),
      barcode: formData.barcode.trim(),
      name: formData.name.trim(),
      generic: formData.generic.trim() || "N/A",
      batch: formData.batch.trim().toUpperCase(),
      expiry: formData.expiry || "N/A",
      totalUnits: totalUnitsCalculated,
      factor: packFactor,
      buyingPrice: buyPriceRounded,
      retailPrice: retailPriceRounded,
      tabletsPerStrip: parseInt(formData.tabletsPerStrip) || 0
    };

    // Only clear the form once the write is confirmed — it used to wipe
    // immediately, so a failed save forced the user to retype everything.
    setIsSavingStock(true);
    try {
      const ok = await onAddNewStock(stockItemPayload, isEditMode);
      if (ok !== false) handleCancelEdit();
    } finally {
      setIsSavingStock(false);
    }
  };

  // Per-category counts (active stock only) for the category rail badges.
  const categoryCounts = {};
  inventory.forEach((med) => {
    if (med.is_active === 0) return;
    const cat = categorizeProduct(med.name).id;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });

  const filteredInventory = inventory.filter((med) => {
    if (stockFilterMode === "low" && med.totalUnits <= (med.factor * 2)) {
      // Keep low stock items
    } else if (stockFilterMode === "low") {
      return false;
    }
    
    if (stockFilterMode === "expiryAlert" && !isExpiringWithinCustomThreshold(med.expiry)) return false;
    if (stockFilterMode === "outOfStock" && med.totalUnits !== 0) return false;
    if (categoryFilter && categorizeProduct(med.name).id !== categoryFilter) return false;

    const query = stockSearchQuery.toLowerCase();
    return (
      (med.name || '').toLowerCase().includes(query) ||
      (med.generic || '').toLowerCase().includes(query) ||
      (med.batch || '').toLowerCase().includes(query) ||
      (med.barcode && med.barcode.toLowerCase().includes(query))
    );
  });

  // ==========================================
  // SORTING
  // ==========================================
  const SORT_ACCESSORS = {
    name: (med) => (med.name || "").toLowerCase(),
    batch: (med) => (med.batch || "").toLowerCase(),
    expiry: (med) => med.expiry || "",
    totalUnits: (med) => med.totalUnits || 0,
    intake_time: (med) => med.intake_time || "",
    buyingPrice: (med) => med.buyingPrice || 0,
    retailPrice: (med) => med.retailPrice || 0,
  };

  const sortedInventory = React.useMemo(() => {
    if (!sortColumn || !SORT_ACCESSORS[sortColumn]) return filteredInventory;
    const accessor = SORT_ACCESSORS[sortColumn];
    const sorted = [...filteredInventory].sort((a, b) => {
      const valA = accessor(a);
      const valB = accessor(b);
      if (valA < valB) return sortDirection === "asc" ? -1 : 1;
      if (valA > valB) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filteredInventory, sortColumn, sortDirection]);

  const handleSortClick = (column) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
    setCurrentPage(1);
  };

  const sortIndicator = (column) => {
    if (sortColumn !== column) return null;
    return <span className="ml-1">{sortDirection === "asc" ? "▲" : "▼"}</span>;
  };

  const totalFilteredRows = sortedInventory.length;
  const totalPagesCount = Math.ceil(totalFilteredRows / rowsPerPage) || 1;
  const indexLastRow = currentPage * rowsPerPage;
  const indexFirstRow = indexLastRow - rowsPerPage;
  const paginatedInventorySlice = sortedInventory.slice(indexFirstRow, indexLastRow);

  const handlePageChange = (direction) => {
    if (direction === "next" && currentPage < totalPagesCount) setCurrentPage((prev) => prev + 1);
    else if (direction === "prev" && currentPage > 1) setCurrentPage((prev) => prev - 1);
  };

  return (
    <div className={`flex-1 flex p-6 gap-6 overflow-hidden h-full w-full min-h-0 ${lightMode ? "bg-slate-100" : "bg-slate-950"}`}>
      
      {/* GS1 BATCH COLLISION SELECTOR MODAL (INVENTORY MODE) */}
      {pendingStockCollisions.length > 0 && (
        <div className="fixed inset-0 z-[200] bg-slate-950/80 flex items-center justify-center backdrop-blur-sm">
          <div className={`p-6 rounded-2xl max-w-lg w-full shadow-2xl ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}>
            <div className="flex items-center gap-2 mb-4">
              <span className="material-symbols-outlined text-emerald-500">inventory_2</span>
              <h2 className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}>Select Batch to Restock</h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">Multiple batches share this barcode. Select the correct batch you are adding stock to.</p>
            
            <div className="space-y-2 max-h-[50vh] overflow-y-auto custom-scrollbar pr-2">
              {pendingStockCollisions.map((prod) => (
                <div key={prod.id} onClick={() => {
                  setPendingStockCollisions([]);
                  setQuickAddDialog({
                    isOpen: true,
                    targetItem: prod,
                    addBoxes: "",
                    addStrips: ""
                  });
                }} className={`border p-3 rounded-xl cursor-pointer transition-colors ${lightMode ? "bg-slate-50 border-slate-200 hover:border-emerald-500 shadow-sm" : "bg-slate-950 border-slate-800/80 hover:border-emerald-500 shadow-sm"}`}>
                  <div className="flex justify-between items-start">
                    <div className="font-black text-xs">{prod.name}</div>
                    <div className="font-mono text-[10px] text-emerald-500 font-bold border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 rounded">
                      Batch: {prod.batch}
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-1 font-bold">
                    Exp: <span className="text-slate-400">{prod.expiry}</span> | Stock: {Math.floor(prod.totalUnits / prod.factor)} Box, {prod.totalUnits % prod.factor} Strip
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => setPendingStockCollisions([])} className={`mt-4 w-full font-bold py-2.5 rounded-xl text-xs uppercase border ${lightMode ? "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"}`}>
              Cancel Scan
            </button>
          </div>
        </div>
      )}

      {/* QUICK ADD STOCK DIALOG */}
      {quickAddDialog.isOpen && quickAddDialog.targetItem && (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
          <form onSubmit={handleQuickAddSubmit} className={`p-6 rounded-2xl max-w-sm w-full shadow-2xl flex flex-col gap-4 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}>
            <div className="flex items-center gap-3 border-b pb-3 border-slate-200/20">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500">
                <span className="material-symbols-outlined text-xl">add_box</span>
              </div>
              <div>
                <h3 className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}>Quick Restock</h3>
                <p className="text-xs text-emerald-500 font-bold mt-0.5">{quickAddDialog.targetItem.name}</p>
              </div>
            </div>

            <div className={`p-3 rounded-xl border flex justify-between items-center ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800/80"}`}>
              <div className="space-y-0.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Batch Number</p>
                <p className={`font-mono text-xs font-black ${lightMode ? "text-slate-800" : "text-slate-200"}`}>{quickAddDialog.targetItem.batch}</p>
              </div>
              <div className="space-y-0.5 text-right">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Current Stock</p>
                <p className={`font-mono text-xs font-black ${lightMode ? "text-slate-800" : "text-slate-200"}`}>
                  {Math.floor(quickAddDialog.targetItem.totalUnits / quickAddDialog.targetItem.factor)} Box, {quickAddDialog.targetItem.totalUnits % quickAddDialog.targetItem.factor} Strip
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-2">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Add Boxes</label>
                <input ref={quickAddInputRef} type="number" min="0" placeholder="0" value={quickAddDialog.addBoxes} onChange={(e) => setQuickAddDialog(prev => ({ ...prev, addBoxes: e.target.value }))} className={`w-full border rounded-xl py-2.5 px-3 text-sm font-mono text-center focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Add Loose Strips</label>
                <input type="number" min="0" placeholder="0" value={quickAddDialog.addStrips} onChange={(e) => setQuickAddDialog(prev => ({ ...prev, addStrips: e.target.value }))} className={`w-full border rounded-xl py-2.5 px-3 text-sm font-mono text-center focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-3">
              <button type="button" disabled={isRestocking} onClick={() => setQuickAddDialog({ isOpen: false, targetItem: null, addBoxes: "", addStrips: "" })} className={`py-3 px-4 rounded-xl text-xs uppercase font-bold border disabled:opacity-40 disabled:pointer-events-none ${lightMode ? "bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200" : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"}`}>Cancel</button>
              <button type="submit" disabled={isRestocking} className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-black py-3 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90 transition-opacity disabled:opacity-50 disabled:pointer-events-none">{isRestocking ? "Adding..." : "Confirm Stock"}</button>
            </div>
          </form>
        </div>
      )}

      {/* DELETE CONFIRMATION MONITOR */}
      {deleteDialog.isOpen && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-slate-950/75 backdrop-blur-sm">
          <div className={`border p-6 rounded-2xl max-w-sm w-full shadow-2xl flex flex-col gap-4 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-500">
                <span className="material-symbols-outlined text-xl">delete_forever</span>
              </div>
              <div>
                <h3 className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}>Confirm Deletion</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">Medication: <span className="text-rose-500 font-bold">{deleteDialog.itemName}</span></p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-1.5">
              <button type="button" onClick={() => setDeleteDialog({ isOpen: false, itemId: null, itemName: "" })} className={`py-2 px-4 rounded-xl text-xs uppercase font-bold border ${lightMode ? "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200" : "bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700"}`}>Cancel</button>
              <button type="button" onClick={() => { if (deleteDialog.itemId) onDeleteStock(deleteDialog.itemId); setDeleteDialog({ isOpen: false, itemId: null, itemName: "" }); }} className="w-full bg-gradient-to-r from-rose-500 to-red-500 text-white font-black py-2.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90 transition-opacity">Delete Entry</button>
            </div>
          </div>
        </div>
      )}

      {/* VALIDATION ALERT */}
      {validationDialog.isOpen && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-slate-950/75 backdrop-blur-sm">
          <div className={`border p-6 rounded-2xl max-w-sm w-full shadow-2xl flex flex-col gap-4 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500">
                <span className="material-symbols-outlined text-xl">warning</span>
              </div>
              <div>
                <h3 className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}>Validation Alert</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">Operation Blocked</p>
              </div>
            </div>
            <p className={`text-xs font-medium leading-relaxed ${lightMode ? "text-slate-600" : "text-slate-400"}`}>{validationDialog.message}</p>
            <button
              ref={ackButtonRef}
              type="button"
              onClick={() => setValidationDialog({ isOpen: false, message: "" })}
              className="w-full bg-slate-800 focus:ring-2 focus:ring-amber-500 text-white font-bold py-2 rounded-xl text-xs uppercase tracking-wider transition-colors outline-none hover:bg-slate-700"
            >
              Acknowledge (Press Enter)
            </button>
          </div>
        </div>
      )}

      {batchMismatchDialog.isOpen && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4">
          <div className={`border p-5 sm:p-6 rounded-2xl max-w-md w-full shadow-2xl flex flex-col gap-4 max-h-[90vh] overflow-y-auto ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 shrink-0 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-500">
                <span className="material-symbols-outlined text-xl">help</span>
              </div>
              <div>
                <h3 className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}>Is This a New Batch?</h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5">Barcode already on file</p>
              </div>
            </div>

            <p className={`text-xs font-medium leading-relaxed ${lightMode ? "text-slate-600" : "text-slate-400"}`}>
              <span className="font-bold">{batchMismatchDialog.productName}</span> already exists under {batchMismatchDialog.existingBatches.length > 1 ? "these batches" : "this batch"}:
            </p>

            <div className={`rounded-xl border divide-y max-h-32 overflow-y-auto text-xs ${lightMode ? "border-slate-200 divide-slate-100" : "border-slate-800 divide-slate-800"}`}>
              {batchMismatchDialog.existingBatches.map((b, idx) => (
                <div key={idx} className="flex justify-between items-center px-3 py-2">
                  <span className={`font-mono font-bold ${lightMode ? "text-slate-700" : "text-slate-300"}`}>{b.batch || "N/A"}</span>
                  <span className="text-slate-400">Exp: {b.expiry || "N/A"}</span>
                </div>
              ))}
            </div>

            <p className={`text-xs font-medium leading-relaxed ${lightMode ? "text-slate-600" : "text-slate-400"}`}>
              Restocking one of these? Use Restock. Otherwise, confirm this is a genuinely new batch.
            </p>


            <div className="flex flex-col sm:flex-row gap-2">
              {onGoToRestock && (
                <button
                  type="button"
                  onClick={() => {
                    setBatchMismatchDialog({ isOpen: false, barcode: "", productName: "", existingBatches: [], onConfirmNewBatch: null });
                    onGoToRestock();
                  }}
                  className="flex-1 bg-gradient-to-r from-emerald-400 to-teal-400 text-slate-950 font-black py-2.5 rounded-xl text-xs uppercase tracking-wider hover:opacity-95 transition-all"
                >
                  Go to Restock
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const confirmFn = batchMismatchDialog.onConfirmNewBatch;
                  setBatchMismatchDialog({ isOpen: false, barcode: "", productName: "", existingBatches: [], onConfirmNewBatch: null });
                  if (confirmFn) confirmFn();
                }}
                className={`flex-1 font-black py-2.5 rounded-xl text-xs uppercase tracking-wider border transition-colors ${lightMode ? "bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200" : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"}`}
              >
                This Is a New Batch
              </button>
            </div>
          </div>
        </div>
      )}


      {/* LEFT-HAND FORM WORKSPACE */}
      <div className="w-[360px] flex flex-col shrink-0 h-full">
        <form onSubmit={handleSubmit} className={`flex-1 border rounded-2xl p-5 flex flex-col justify-between shadow-sm overflow-hidden ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
          <div className="space-y-4 overflow-y-auto custom-scrollbar pr-1 flex-1">
            <h2 className="text-sm font-black uppercase tracking-wider text-slate-500 mb-2 border-b pb-2 border-slate-200/20">
              {isEditMode ? "Modify Product" : "Register New Product"}
            </h2>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-slate-400">GS1 Barcode (Optional)</label>
              <input type="text" name="barcode" value={formData.barcode} onChange={handleInputChange} placeholder="Scan or type barcode" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-slate-400">Medication Name</label>
              <input ref={nameInputRef} id="stock-name-input" type="text" name="name" required maxLength={50} value={formData.name} onChange={handleInputChange} placeholder="e.g. Panadol Extra" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-slate-400">Generic Formula</label>
              <input ref={genericInputRef} type="text" name="generic" maxLength={50} value={formData.generic} onChange={handleInputChange} placeholder="e.g. Paracetamol" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Batch No.</label>
                <input type="text" name="batch" required maxLength={20} value={formData.batch} onChange={handleInputChange} placeholder="Enter batch" className={`w-full border rounded-xl py-2 px-3 text-xs uppercase focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Expiry Date (MM / YYYY)</label>
                {/* Two plain controlled inputs instead of the native
                    type="month" widget — the browser's segmented month/year
                    picker was clearing the whole field if you typed slower
                    than it expected. Validation against the minimum date
                    now happens on submit (see handleSubmit), not per
                    keystroke, so partial input is never force-cleared. */}
                <div className="flex gap-2">
                  <input type="text" inputMode="numeric" name="expiryMonth" maxLength={2} placeholder="MM" value={expiryMonth} onChange={handleExpiryMonthChange} className={`w-1/2 border rounded-xl py-2 px-3 text-xs text-center focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                  <input type="text" inputMode="numeric" name="expiryYear" maxLength={4} placeholder="YYYY" value={expiryYear} onChange={handleExpiryYearChange} className={`w-1/2 border rounded-xl py-2 px-3 text-xs text-center focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Boxes</label>
                <input type="number" name="boxes" min="0" value={formData.boxes} onChange={handleInputChange} placeholder="0" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
              {isEditMode ? (
                // Edit mode keeps "Strips" here — this is how existing stock
                // gets corrected during an edit, unrelated to the tablets
                // feature and unchanged from before.
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-slate-400">Strips</label>
                  <input type="number" name="strips" min="0" value={formData.strips} onChange={handleInputChange} placeholder="0" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                </div>
              ) : (
                // Add New Product mode: the rarely-used loose-Strips entry is
                // replaced with Tablets/Strip — a product attribute (how many
                // tablets make up one strip), not an initial-stock quantity.
                // Leave blank for products that aren't sold by the tablet.
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-slate-400">Tablets / Strip</label>
                  <input type="number" name="tabletsPerStrip" min="0" value={formData.tabletsPerStrip} onChange={handleInputChange} placeholder="Optional" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                </div>
              )}
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Pack/Factor</label>
                <input type="number" name="factor" min="1" value={formData.factor} onChange={handleInputChange} placeholder="2" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
            </div>

            {isEditMode && (
              // Editing an existing product can still set/change Tablets/Strip
              // here — this is the one place it's available in Edit mode,
              // since a product added before this feature existed may want
              // it turned on later.
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Tablets / Strip <span className="normal-case font-medium text-slate-400">(leave blank if not sold by the tablet)</span></label>
                <input type="number" name="tabletsPerStrip" min="0" value={formData.tabletsPerStrip} onChange={handleInputChange} placeholder="Optional" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Buy Price (Rs)</label>
                <input type="number" name="buyingPrice" required min="0" value={formData.buyingPrice} onChange={handleInputChange} placeholder="Cost" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Retail Price (Rs)</label>
                <input type="number" name="retailPrice" required min="0" value={formData.retailPrice} onChange={handleInputChange} placeholder="Sell" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
            </div>

          </div>

          <div className="grid grid-cols-2 gap-3 pt-4 border-t mt-2 border-slate-200/20 shrink-0">
            {isEditMode ? (
              <button type="button" onClick={handleCancelEdit} className={`font-bold py-3 rounded-xl text-xs uppercase transition-colors border ${lightMode ? "bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200" : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"}`}>Cancel</button>
            ) : (
              <button type="button" onClick={() => setFormData({ barcode: "", name: "", generic: "", batch: "", expiry: "", boxes: "", strips: "", factor: 2, buyingPrice: "", retailPrice: "", tabletsPerStrip: "" })} className={`font-bold py-3 rounded-xl text-xs uppercase transition-colors border ${lightMode ? "bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200" : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"}`}>Clear Form</button>
            )}
            <button type="submit" disabled={isSavingStock} className={`font-black py-3 rounded-xl text-xs uppercase shadow-md transition-all disabled:opacity-50 disabled:pointer-events-none ${isEditMode ? "bg-gradient-to-r from-amber-400 to-orange-400 text-slate-900" : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white"}`}>
              {isSavingStock ? "Saving..." : isEditMode ? "Save Edits" : "Log Stock"}
            </button>
          </div>
        </form>
      </div>

      {/* RIGHT-HAND TABLE WORKSPACE */}
      <div className={`flex-1 flex flex-col overflow-hidden border rounded-2xl shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
        {/* HEADER WITH SEARCH AND FILTER DROPDOWNS */}
        <div className={`p-4 border-b flex flex-col sm:flex-row gap-3 justify-between sm:items-center shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-900/40 border-slate-800"}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Warehouse Ledger</h3>
            <select value={stockFilterMode} onChange={(e) => { setStockFilterMode(e.target.value); setCurrentPage(1); }} className={`border rounded-lg py-1.5 px-3 text-xs font-bold focus:outline-none cursor-pointer ${lightMode ? "bg-white border-slate-200 text-slate-700 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-300 focus:border-emerald-500"}`}>
              <option value="all">Total Stock</option>
              <option value="expiryAlert">Expiry Warnings</option>
              <option value="low">Low Stock Alerts</option>
              <option value="outOfStock">Out of Stock</option>
            </select>
            <select value={categoryFilter || "all"} onChange={(e) => { setCategoryFilter(e.target.value === "all" ? null : e.target.value); setCurrentPage(1); }} className={`border rounded-lg py-1.5 px-3 text-xs font-bold focus:outline-none cursor-pointer ${lightMode ? "bg-white border-slate-200 text-slate-700 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-300 focus:border-emerald-500"}`}>
              <option value="all">All Categories</option>
              {ALL_CATEGORIES.filter((cat) => categoryCounts[cat.id]).map((cat) => (
                <option key={cat.id} value={cat.id}>{cat.label} ({categoryCounts[cat.id]})</option>
              ))}
            </select>
          </div>
          <div className="relative w-full sm:w-64">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">search</span>
            <input type="text" placeholder="Search ledger items..." value={stockSearchQuery} onChange={(e) => { setStockSearchQuery(e.target.value); setCurrentPage(1); }} className={`w-full border rounded-xl py-1.5 pl-9 pr-3 text-xs focus:outline-none transition-all ${lightMode ? "bg-white border-slate-200 text-slate-900 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500/60"}`} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0 bg-transparent">
          {totalFilteredRows === 0 ? (
            <div className={`h-[calc(100%-2rem)] flex flex-col items-center justify-center gap-3 border border-dashed m-4 rounded-2xl ${lightMode ? "text-slate-400 border-slate-200" : "text-slate-600 border-slate-800"}`}>
              <span className="material-symbols-outlined text-4xl">inventory_2</span>
              <p className="text-xs font-bold tracking-widest uppercase">No inventory entries found</p>
            </div>
          ) : (
            <table className="w-full text-left border-separate border-spacing-0 text-xs">
              <thead className={`sticky top-0 z-10 border-b text-[10px] font-black uppercase tracking-widest text-slate-400 select-none ${lightMode ? "bg-slate-50 border-slate-200 shadow-sm" : "bg-slate-950 border-slate-800"}`}>
                <tr>
                  <th className="py-4 px-6 border-b border-slate-800/20 cursor-pointer select-none" onClick={() => handleSortClick("name")}>Product ID & Profile{sortIndicator("name")}</th>
                  <th className="py-4 px-4 border-b border-slate-800/20 cursor-pointer select-none" onClick={() => handleSortClick("batch")}>Batch & Expiry{sortIndicator("batch")}</th>
                  <th className="py-4 px-4 border-b border-slate-800/20 cursor-pointer select-none" onClick={() => handleSortClick("totalUnits")}>Stock Balance{sortIndicator("totalUnits")}</th>
                  <th className="py-4 px-5 border-b border-slate-800/20 cursor-pointer select-none" onClick={() => handleSortClick("intake_time")}>Intake Time{sortIndicator("intake_time")}</th>
                  <th className="py-4 px-4 border-b border-slate-800/20 cursor-pointer select-none" onClick={() => handleSortClick("buyingPrice")}>Buy Price{sortIndicator("buyingPrice")}</th>
                  <th className="py-4 px-4 border-b border-slate-800/20 cursor-pointer select-none" onClick={() => handleSortClick("retailPrice")}>Retail Price{sortIndicator("retailPrice")}</th>
                  <th className="py-4 px-5 border-b border-slate-800/20 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className={`font-medium divide-y ${lightMode ? "divide-slate-100" : "divide-slate-800/40"}`}>
                {paginatedInventorySlice.map((med) => {
                  const boxes = Math.floor(med.totalUnits / med.factor);
                  const strips = med.totalUnits % med.factor;
                  const isExpiring = isExpiringWithinCustomThreshold(med.expiry);
                  const isLow = med.totalUnits <= (med.factor * 2);
                  const isOutOfStock = med.totalUnits === 0;

                  let readableIntakeTime = "N/A";
                  if (med.intake_time) {
                    try {
                      readableIntakeTime = new Date(med.intake_time).toLocaleString('en-PK', {
                        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
                      });
                    } catch (e) {
                      readableIntakeTime = "Initial Stock";
                    }
                  }

                  // Determine dynamic row highlighting
                  let dynamicRowClass = lightMode ? "hover:bg-slate-50" : "hover:bg-slate-800/30";
                  if (isExpiring) {
                    dynamicRowClass = lightMode ? "bg-rose-50/50 hover:bg-rose-100/50" : "bg-rose-950/20 hover:bg-rose-900/30";
                  } else if (isOutOfStock) {
                    dynamicRowClass = lightMode ? "bg-blue-50/50 hover:bg-blue-100/50" : "bg-blue-950/20 hover:bg-blue-900/30";
                  } else if (isLow) {
                    dynamicRowClass = lightMode ? "bg-amber-50/50 hover:bg-amber-100/50" : "bg-amber-950/20 hover:bg-amber-900/30";
                  }

                  return (
                    <tr key={med.id} className={`transition-colors duration-150 ${dynamicRowClass}`}>
                      <td className="py-4 px-6">
                        <div className={`font-black text-sm ${lightMode ? "text-slate-800" : "text-slate-100"}`}>{med.name}</div>
                        <div className="text-[10px] text-slate-400 mt-1 max-w-[200px] truncate">{med.generic}</div>
                      </td>
                      <td className="py-4 px-4">
                        <div className={`font-mono font-bold px-2 py-0.5 rounded border inline-block ${lightMode ? "bg-slate-100 border-slate-200 text-slate-700" : "bg-slate-950 border-slate-800 text-slate-300"}`}>{med.batch}</div>
                        <div className={`text-[10px] font-bold mt-1.5 ${isExpiring ? "text-rose-500" : "text-slate-400"}`}>
                          Exp: {med.expiry}
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-1.5">
                          <div className={`flex items-baseline gap-1 px-2 py-0.5 rounded-lg border ${
                            isOutOfStock
                              ? (lightMode ? "bg-blue-100 border-blue-200 text-blue-700" : "bg-blue-500/10 border-blue-500/20 text-blue-400")
                              : isLow
                                ? (lightMode ? "bg-amber-100 border-amber-200 text-amber-700" : "bg-amber-500/10 border-amber-500/20 text-amber-400")
                                : (lightMode ? "bg-white border-slate-200 text-slate-700" : "bg-slate-950 border-slate-800 text-slate-300")
                          }`}>
                            <span className="font-black text-sm">{boxes}</span>
                            <span className="text-[9px] uppercase font-bold tracking-wider opacity-70">Box</span>
                          </div>
                          <span className="text-slate-400 font-bold text-xs">+</span>
                          <div className={`flex items-baseline gap-1 px-2 py-0.5 rounded-lg border ${
                            isOutOfStock
                              ? (lightMode ? "bg-blue-100 border-blue-200 text-blue-700" : "bg-blue-500/10 border-blue-500/20 text-blue-400")
                              : isLow
                                ? (lightMode ? "bg-amber-100 border-amber-200 text-amber-700" : "bg-amber-500/10 border-amber-500/20 text-amber-400")
                                : (lightMode ? "bg-white border-slate-200 text-slate-700" : "bg-slate-950 border-slate-800 text-slate-300")
                          }`}>
                            <span className="font-black text-sm">{strips}</span>
                            <span className="text-[9px] uppercase font-bold tracking-wider opacity-70">Str</span>
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4 font-mono text-[10px] text-slate-500">
                        {readableIntakeTime}
                      </td>
                      <td className="py-4 px-4 font-mono font-bold text-slate-500">
                        Rs. {Math.round(med.buyingPrice)}
                      </td>
                      <td className="py-4 px-4 font-mono font-black text-emerald-500">
                        Rs. {Math.round(med.retailPrice)}
                      </td>
                      <td className="py-4 px-5 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button type="button" onClick={() => handleTriggerEdit(med)} className={`p-2 rounded-xl transition-all flex items-center border ${lightMode ? "text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 border-slate-200 bg-white" : "text-slate-500 hover:text-emerald-400 hover:bg-slate-800 border-slate-800 bg-slate-950"}`}>
                            <span className="material-symbols-outlined text-[18px]">edit_square</span>
                          </button>
                          <button type="button" onClick={() => setDeleteDialog({ isOpen: true, itemId: med.id, itemName: med.name })} className={`p-2 rounded-xl transition-all flex items-center border ${lightMode ? "text-slate-400 hover:text-rose-500 hover:bg-rose-50 border-slate-200 bg-white" : "text-slate-500 hover:text-rose-400 hover:bg-slate-800 border-slate-800 bg-slate-950"}`}>
                            <span className="material-symbols-outlined text-[18px]">delete</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* PAGINATION */}
        <div className={`p-4 border-t flex items-center justify-between font-medium text-xs select-none shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800"}`}>
          <div className="flex items-center gap-2 text-slate-400">
            <span>Rows per page:</span>
            <select value={rowsPerPage} onChange={(e) => { setRowsPerPage(parseInt(e.target.value)); setCurrentPage(1); }} className={`py-1 px-2 border rounded-lg focus:outline-none font-bold ${lightMode ? "bg-white border-slate-200 text-slate-700" : "bg-slate-900 border-slate-800 text-slate-300"}`}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
          </div>
          <div className="text-slate-400 font-mono">
            Showing <span className="font-bold text-slate-500">{totalFilteredRows === 0 ? 0 : indexFirstRow + 1}</span> - <span className="font-bold text-slate-500">{Math.min(indexLastRow, totalFilteredRows)}</span> of <span className="font-bold text-slate-500">{totalFilteredRows}</span> records
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={currentPage === 1} onClick={() => handlePageChange("prev")} className={`w-8 h-8 rounded-xl flex items-center justify-center border font-black transition-all disabled:opacity-20 disabled:pointer-events-none ${lightMode ? "bg-white border-slate-200 hover:bg-slate-100" : "bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
              <span className="material-symbols-outlined text-base">chevron_left</span>
            </button>
            <span className="font-mono font-bold px-2 text-slate-400">Page {currentPage} / {totalPagesCount}</span>
            <button type="button" disabled={currentPage === totalPagesCount} onClick={() => handlePageChange("next")} className={`w-8 h-8 rounded-xl flex items-center justify-center border font-black transition-all disabled:opacity-20 disabled:pointer-events-none ${lightMode ? "bg-white border-slate-200 hover:bg-slate-100" : "bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
              <span className="material-symbols-outlined text-base">chevron_right</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StockManagement;