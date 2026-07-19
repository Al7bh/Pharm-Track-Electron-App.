import React, { useState, useEffect, useRef } from "react";

function StockManagement({ inventory, onAddNewStock, onQuickRestock, onDeleteStock, lightMode, scannedData, clearScannedData }) {
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
    retailPrice: ""
  });

  const [isEditMode, setIsEditMode] = useState(false);
  const [targetEditId, setTargetEditId] = useState(null);
  // In-flight guards: without these a double-click created duplicate rows /
  // double restocks, because every write here is non-idempotent.
  const [isSavingStock, setIsSavingStock] = useState(false);
  const [isRestocking, setIsRestocking] = useState(false);
  // Timestamp of the last keydown, used to tell scanner bursts from real keys.
  const lastKeyTimeRef = useRef(0);

  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [stockSearchQuery, setStockSearchQuery] = useState("");
  const [stockFilterMode, setStockFilterMode] = useState("all");

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

      const matchesByBarcode = inventory.filter((item) => item.barcode === scannedData.gtin);

      if (matchesByBarcode.length > 0) {
        // 1. IF GS1 BARCODE (Contains embedded Batch info)
        if (scannedData.batch) {
          const exactMatch = matchesByBarcode.find(item => item.batch === scannedData.batch);
          
          if (exactMatch) {
            // We have this exact Batch already -> Quick Restock
            setQuickAddDialog({ isOpen: true, targetItem: exactMatch, addBoxes: "", addStrips: "" });
          } else {
            // WE KNOW THE PRODUCT, BUT THIS IS A NEW BATCH!
            // Auto-fill the form with existing product details to save typing
            const template = matchesByBarcode[0];
            setFormData((prev) => {
              // Double scan shield
              if (prev.barcode === scannedData.gtin && prev.batch === scannedData.batch) return prev;

              setTimeout(() => {
                // Focus the boxes input instantly because Name & Price are already filled!
                const boxesInput = document.getElementsByName("boxes")[0];
                if (boxesInput) boxesInput.focus();
              }, 10);

              return {
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
              };
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
    };
    window.addEventListener("keydown", handleStockDialogKeys);
    return () => window.removeEventListener("keydown", handleStockDialogKeys);
  }, [deleteDialog.isOpen, validationDialog.isOpen, pendingStockCollisions.length, quickAddDialog.isOpen, onDeleteStock]);

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
      value = formatTitleCase(value);
    }
    setFormData((prev) => ({ ...prev, [name]: value }));
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
        message: "Please enter a valid quantity of boxes or strips to restock.",
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
      retailPrice: Math.round(med.retailPrice) || ""
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
      retailPrice: ""
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSavingStock) return;
    if (!formData.name || !formData.batch || !formData.retailPrice || !formData.buyingPrice) {
      setValidationDialog({
        isOpen: true,
        message: "Please complete Name, Batch, Buying Price, and Retail Price before continuing.",
      });
      return;
    }

    const buyPriceRounded = Math.round(parseFloat(formData.buyingPrice)) || 0;
    const retailPriceRounded = Math.round(parseFloat(formData.retailPrice)) || 0;

    if (retailPriceRounded < buyPriceRounded) {
      setValidationDialog({
        isOpen: true,
        message: "Retail Price cannot be lower than Buying Price. Please verify your margins.",
      });
      return;
    }

    // ==============================================================
    // THE SILENT DUPLICATE SHIELD
    // Prevent the user from manually typing a barcode and batch that already exists!
    // ==============================================================
    if (!isEditMode && formData.barcode) {
      const isDuplicate = inventory.some(item => 
        item.barcode === formData.barcode.trim() && 
        item.batch === formData.batch.trim().toUpperCase()
      );
      
      if (isDuplicate) {
        setValidationDialog({
          isOpen: true,
          message: "This specific Barcode and Batch already exists in the system. Please scan it to use the Quick Restock popup instead.",
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
      retailPrice: retailPriceRounded
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

  const filteredInventory = inventory.filter((med) => {
    if (stockFilterMode === "low" && med.totalUnits <= (med.factor * 2)) {
      // Keep low stock items
    } else if (stockFilterMode === "low") {
      return false;
    }
    
    if (stockFilterMode === "expiryAlert" && !isExpiringWithinCustomThreshold(med.expiry)) return false;

    const query = stockSearchQuery.toLowerCase();
    return (
      (med.name || '').toLowerCase().includes(query) ||
      (med.generic || '').toLowerCase().includes(query) ||
      (med.batch || '').toLowerCase().includes(query) ||
      (med.barcode && med.barcode.toLowerCase().includes(query))
    );
  });

  const totalFilteredRows = filteredInventory.length;
  const totalPagesCount = Math.ceil(totalFilteredRows / rowsPerPage) || 1;
  const indexLastRow = currentPage * rowsPerPage;
  const indexFirstRow = indexLastRow - rowsPerPage;
  const paginatedInventorySlice = filteredInventory.slice(indexFirstRow, indexLastRow);

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
              <input id="stock-name-input" type="text" name="name" required maxLength={50} value={formData.name} onChange={handleInputChange} placeholder="e.g. Panadol Extra" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-slate-400">Generic Formula</label>
              <input type="text" name="generic" maxLength={50} value={formData.generic} onChange={handleInputChange} placeholder="e.g. Paracetamol" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Batch No.</label>
                <input type="text" name="batch" required maxLength={20} value={formData.batch} onChange={handleInputChange} placeholder="Enter batch" className={`w-full border rounded-xl py-2 px-3 text-xs uppercase focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Expiry Date</label>
                <input type="month" name="expiry" value={formData.expiry} onChange={handleInputChange} min={minExpiryDateString} className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Boxes</label>
                <input type="number" name="boxes" min="0" value={formData.boxes} onChange={handleInputChange} placeholder="0" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Strips</label>
                <input type="number" name="strips" min="0" value={formData.strips} onChange={handleInputChange} placeholder="0" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-400">Pack/Factor</label>
                <input type="number" name="factor" min="1" value={formData.factor} onChange={handleInputChange} placeholder="2" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
              </div>
            </div>

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
              <button type="button" onClick={() => setFormData({ barcode: "", name: "", generic: "", batch: "", expiry: "", boxes: "", strips: "", factor: 2, buyingPrice: "", retailPrice: "" })} className={`font-bold py-3 rounded-xl text-xs uppercase transition-colors border ${lightMode ? "bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200" : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"}`}>Clear Form</button>
            )}
            <button type="submit" disabled={isSavingStock} className={`font-black py-3 rounded-xl text-xs uppercase shadow-md transition-all disabled:opacity-50 disabled:pointer-events-none ${isEditMode ? "bg-gradient-to-r from-amber-400 to-orange-400 text-slate-900" : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white"}`}>
              {isSavingStock ? "Saving..." : isEditMode ? "Save Edits" : "Log Stock"}
            </button>
          </div>
        </form>
      </div>

      {/* RIGHT-HAND TABLE WORKSPACE */}
      <div className={`flex-1 flex flex-col overflow-hidden border rounded-2xl shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
        {/* HEADER WITH SEARCH AND FILTER DROPDOWN */}
        <div className={`p-4 border-b flex flex-col sm:flex-row gap-3 justify-between sm:items-center shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-900/40 border-slate-800"}`}>
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Warehouse Ledger</h3>
            <select value={stockFilterMode} onChange={(e) => { setStockFilterMode(e.target.value); setCurrentPage(1); }} className={`border rounded-lg py-1.5 px-3 text-xs font-bold focus:outline-none cursor-pointer ${lightMode ? "bg-white border-slate-200 text-slate-700 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-300 focus:border-emerald-500"}`}>
              <option value="all">Total Stock</option>
              <option value="expiryAlert">Expiry Warnings</option>
              <option value="low">Low Stock Alerts</option>
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
                  <th className="py-4 px-6 border-b border-slate-800/20">Product ID & Profile</th>
                  <th className="py-4 px-4 border-b border-slate-800/20">Batch & Expiry</th>
                  <th className="py-4 px-4 border-b border-slate-800/20">Stock Balance</th>
                  <th className="py-4 px-5 border-b border-slate-800/20">Intake Time</th>
                  <th className="py-4 px-4 border-b border-slate-800/20">Buy Price</th>
                  <th className="py-4 px-4 border-b border-slate-800/20">Retail Price</th>
                  <th className="py-4 px-5 border-b border-slate-800/20 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className={`font-medium divide-y ${lightMode ? "divide-slate-100" : "divide-slate-800/40"}`}>
                {paginatedInventorySlice.map((med) => {
                  const boxes = Math.floor(med.totalUnits / med.factor);
                  const strips = med.totalUnits % med.factor;
                  const isExpiring = isExpiringWithinCustomThreshold(med.expiry);
                  const isLow = med.totalUnits <= (med.factor * 2);

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
                            isLow 
                              ? (lightMode ? "bg-amber-100 border-amber-200 text-amber-700" : "bg-amber-500/10 border-amber-500/20 text-amber-400") 
                              : (lightMode ? "bg-white border-slate-200 text-slate-700" : "bg-slate-950 border-slate-800 text-slate-300")
                          }`}>
                            <span className="font-black text-sm">{boxes}</span>
                            <span className="text-[9px] uppercase font-bold tracking-wider opacity-70">Box</span>
                          </div>
                          <span className="text-slate-400 font-bold text-xs">+</span>
                          <div className={`flex items-baseline gap-1 px-2 py-0.5 rounded-lg border ${
                            isLow 
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
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
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