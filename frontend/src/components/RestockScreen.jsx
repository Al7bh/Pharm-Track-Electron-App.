import React, { useState, useEffect, useMemo, useRef } from "react";
import { ALL_CATEGORIES, categorizeProduct } from "../utils/categorize";

// ==========================================================================
// RESTOCK SCREEN
// ==========================================================================
// A dedicated, barcode-first restocking flow. Unlike the Add New Product
// form (which can fall through into creating a new row if a scanned batch
// doesn't exactly match one on file), this screen ALWAYS looks a scan up by
// barcode alone, shows every existing batch for that product, and only ever
// creates a new batch row when the user explicitly says so via the
// "Add as a New Batch" action below the existing-batches list — never
// silently, and never as a side effect of a mismatched scan.
// ==========================================================================

function RestockScreen({ inventory, onQuickRestock, onAddNewStock, lightMode, scannedData, clearScannedData }) {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = String(currentDate.getMonth() + 1).padStart(2, "0");
  const minExpiryDateString = `${currentYear}-${currentMonth}`;

  // Scanning only ever works for items that have a barcode, but plenty of
  // real inventory doesn't (see below) — those still need to be restockable
  // here, just via search/category instead of a scan. This key groups
  // batches of the same product whether or not a barcode exists: real
  // barcode when there is one, otherwise the product name.
  const NO_BARCODE_PREFIX = "name:";
  const getProductKey = (item) => (item.barcode ? item.barcode : `${NO_BARCODE_PREFIX}${(item.name || "").trim().toLowerCase()}`);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeProductKey, setActiveProductKey] = useState(null);
  const [notFoundBarcode, setNotFoundBarcode] = useState(null);
  // Right-side category browser — an alternative way to land on a product
  // without knowing its exact name, and what fills out the panel on wide
  // screens instead of leaving dead space next to a single narrow card.
  const [browseCategory, setBrowseCategory] = useState(null);

  // Per-row "add boxes / add strips" inputs, keyed by inventory item id.
  const [rowInputs, setRowInputs] = useState({});
  const [restockingId, setRestockingId] = useState(null);

  const [showNewBatchForm, setShowNewBatchForm] = useState(false);
  const [newBatch, setNewBatch] = useState({
    batch: "",
    expiryMonth: "",
    expiryYear: "",
    boxes: "",
    strips: "",
    buyingPrice: "",
    retailPrice: "",
  });
  const [isSavingNewBatch, setIsSavingNewBatch] = useState(false);
  const [inlineError, setInlineError] = useState("");

  const searchInputRef = useRef(null);
  const newBatchNumberRef = useRef(null);

  // ==========================================
  // SCAN HANDLING — barcode-only lookup, always
  // ==========================================
  useEffect(() => {
    if (scannedData && scannedData.gtin) {
      setSearchQuery("");
      const matches = inventory.filter(
        (item) => item.barcode === scannedData.gtin && item.is_active !== 0
      );

      if (matches.length > 0) {
        setActiveProductKey(scannedData.gtin);
        setNotFoundBarcode(null);
        setInlineError("");

        // If the scan carried a batch that doesn't match anything on file,
        // pre-fill the "New Batch" form so nothing has to be re-typed — but
        // it still takes an explicit Save click. It never auto-saves.
        const exactBatchMatch = scannedData.batch && matches.some((m) => m.batch === scannedData.batch);
        if (scannedData.batch && !exactBatchMatch) {
          const template = matches[0];
          let month = "", year = "";
          if (scannedData.expiry && /^\d{4}-\d{2}$/.test(scannedData.expiry)) {
            [year, month] = scannedData.expiry.split("-");
          }
          setNewBatch({
            batch: scannedData.batch,
            expiryMonth: month,
            expiryYear: year,
            boxes: "",
            strips: "",
            buyingPrice: template.buyingPrice || "",
            retailPrice: template.retailPrice || "",
          });
          setShowNewBatchForm(true);
        } else {
          setShowNewBatchForm(false);
        }
      } else {
        setActiveProductKey(null);
        setNotFoundBarcode(scannedData.gtin);
      }

      if (clearScannedData) clearScannedData();
    }
  }, [scannedData, clearScannedData, inventory]);

  // ==========================================
  // SEARCH (manual, by name/generic/barcode)
  // ==========================================
  // One entry per product (grouped by the unified key), whether or not it
  // has a barcode — search is how a barcode-less product gets found here.
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const seen = new Map();
    inventory.forEach((item) => {
      if (item.is_active === 0) return;
      const haystack = `${item.name || ""} ${item.generic || ""} ${item.barcode || ""}`.toLowerCase();
      if (!haystack.includes(q)) return;
      const key = getProductKey(item);
      if (!seen.has(key)) {
        seen.set(key, { key, barcode: item.barcode || "", name: item.name, generic: item.generic, batchCount: 1 });
      } else {
        seen.get(key).batchCount += 1;
      }
    });
    return Array.from(seen.values()).slice(0, 20);
  }, [searchQuery, inventory]);

  const activeGroup = useMemo(() => {
    if (!activeProductKey) return [];
    return inventory
      .filter((item) => getProductKey(item) === activeProductKey && item.is_active !== 0)
      .sort((a, b) => (a.expiry || "").localeCompare(b.expiry || ""));
  }, [activeProductKey, inventory]);

  const activeTemplate = activeGroup[0] || null;

  // Category counts for the right-side browser panel. Counts distinct
  // products (by the unified key — barcode when there is one, name when
  // there isn't), so the number here always matches exactly what you see
  // after clicking into it, same as the product list below.
  const categoryCounts = useMemo(() => {
    const seenByCategory = {};
    inventory.forEach((item) => {
      if (item.is_active === 0) return;
      const cat = categorizeProduct(item.name).id;
      if (!seenByCategory[cat]) seenByCategory[cat] = new Set();
      seenByCategory[cat].add(getProductKey(item));
    });
    const counts = {};
    Object.keys(seenByCategory).forEach((cat) => { counts[cat] = seenByCategory[cat].size; });
    return counts;
  }, [inventory]);

  // One row per product (grouped by the unified key) within the browsed category.
  const categoryProducts = useMemo(() => {
    if (!browseCategory) return [];
    const seen = new Map();
    inventory.forEach((item) => {
      if (item.is_active === 0) return;
      if (categorizeProduct(item.name).id !== browseCategory) return;
      const key = getProductKey(item);
      if (!seen.has(key)) {
        seen.set(key, { key, barcode: item.barcode || "", name: item.name, generic: item.generic, batchCount: 1 });
      } else {
        seen.get(key).batchCount += 1;
      }
    });
    return Array.from(seen.values()).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [browseCategory, inventory]);

  const resetToSearch = () => {
    setActiveProductKey(null);
    setNotFoundBarcode(null);
    setShowNewBatchForm(false);
    setInlineError("");
    setNewBatch({ batch: "", expiryMonth: "", expiryYear: "", boxes: "", strips: "", buyingPrice: "", retailPrice: "" });
    setTimeout(() => searchInputRef.current && searchInputRef.current.focus(), 10);
  };

  // ==========================================
  // RESTOCK AN EXISTING BATCH
  // ==========================================
  const handleRestockRow = async (item) => {
    const inputs = rowInputs[item.id] || {};
    const packFactor = parseInt(item.factor) || 2;
    const boxesToAdd = parseInt(inputs.addBoxes) || 0;
    const stripsToAdd = parseInt(inputs.addStrips) || 0;
    const unitsToAdd = boxesToAdd * packFactor + stripsToAdd;

    if (unitsToAdd <= 0) {
      setInlineError("Enter boxes or strips to add.");
      return;
    }
    if (restockingId) return;
    setInlineError("");
    setRestockingId(item.id);
    const ok = await onQuickRestock(item.id, unitsToAdd);
    setRestockingId(null);
    if (ok) {
      setRowInputs((prev) => ({ ...prev, [item.id]: { addBoxes: "", addStrips: "" } }));
    }
  };

  // ==========================================
  // ADD AS A NEW BATCH — always explicit, never automatic
  // ==========================================
  useEffect(() => {
    if (showNewBatchForm && newBatchNumberRef.current) {
      newBatchNumberRef.current.focus();
    }
  }, [showNewBatchForm]);

  const handleSaveNewBatch = async () => {
    if (!activeTemplate) return;
    if (!newBatch.batch.trim()) {
      setInlineError("Enter a batch number.");
      return;
    }

    const monthNum = parseInt(newBatch.expiryMonth, 10);
    const isValidMonth = /^\d{1,2}$/.test(newBatch.expiryMonth) && monthNum >= 1 && monthNum <= 12;
    const isValidYear = /^\d{4}$/.test(newBatch.expiryYear);
    let expiry = "";
    if (newBatch.expiryMonth || newBatch.expiryYear) {
      if (!isValidMonth || !isValidYear) {
        setInlineError("Enter a valid expiry: month (1-12) and 4-digit year.");
        return;
      }
      expiry = `${newBatch.expiryYear}-${String(monthNum).padStart(2, "0")}`;
      if (expiry < minExpiryDateString) {
        setInlineError("Expiry date is in the past.");
        return;
      }
    }

    const packFactor = parseInt(activeTemplate.factor) || 2;
    const totalUnits = (parseInt(newBatch.boxes) || 0) * packFactor + (parseInt(newBatch.strips) || 0);
    if (totalUnits <= 0) {
      setInlineError("Enter boxes or strips for this batch.");
      return;
    }
    const buyingPrice = parseFloat(newBatch.buyingPrice);
    const retailPrice = parseFloat(newBatch.retailPrice);
    if (!buyingPrice || !retailPrice) {
      setInlineError("Enter buying and retail price.");
      return;
    }

    // Duplicate guard, mirrored from the Add New Product form: refuse an
    // exact barcode+batch match here too, in case the same batch was typed
    // by mistake instead of using the row above.
    const exactMatch = activeGroup.find((item) => item.batch === newBatch.batch.trim().toUpperCase());
    if (exactMatch) {
      setInlineError("Already listed above — restock it there instead.");
      return;
    }

    if (isSavingNewBatch) return;
    setInlineError("");
    setIsSavingNewBatch(true);
    const payload = {
      id: Date.now().toString(),
      barcode: activeTemplate.barcode,
      name: activeTemplate.name,
      generic: activeTemplate.generic,
      batch: newBatch.batch.trim().toUpperCase(),
      expiry: expiry || "N/A",
      totalUnits,
      factor: packFactor,
      buyingPrice,
      retailPrice,
      tabletsPerStrip: parseInt(activeTemplate.tabletsPerStrip) || 0,
    };
    const ok = await onAddNewStock(payload, false);
    setIsSavingNewBatch(false);
    if (ok) {
      setShowNewBatchForm(false);
      setNewBatch({ batch: "", expiryMonth: "", expiryYear: "", boxes: "", strips: "", buyingPrice: "", retailPrice: "" });
    }
  };

  return (
    <div className={`flex-1 flex flex-col p-4 sm:p-6 gap-4 sm:gap-6 overflow-hidden h-full w-full min-h-0 ${lightMode ? "bg-slate-100" : "bg-slate-950"}`}>

      {/* HEADER */}
      <div className="flex flex-col gap-1 shrink-0">
        <h1 className={`text-lg sm:text-xl font-black tracking-tight ${lightMode ? "text-slate-800" : "text-slate-100"}`}>Restock</h1>
        <p className="text-xs text-slate-400 font-medium">
          Scan or search to see a product's existing batches before restocking.
        </p>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 sm:gap-6 min-h-0 overflow-y-auto lg:overflow-hidden">

      {/* LEFT COLUMN — search, results, active product */}
      <div className="flex-1 flex flex-col gap-4 min-h-0 min-w-0 lg:overflow-y-auto custom-scrollbar lg:pr-1">

      {/* SEARCH BAR */}
      <div className="relative shrink-0 w-full">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">search</span>
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setActiveProductKey(null); setNotFoundBarcode(null); }}
          placeholder="Scan a barcode, or search by product name..."
          className={`w-full border rounded-xl py-2.5 pl-9 pr-3 text-sm focus:outline-none transition-all ${lightMode ? "bg-white border-slate-200 text-slate-900 focus:border-emerald-500" : "bg-slate-900 border-slate-800 text-slate-200 focus:border-emerald-500/60"}`}
        />
      </div>

      {/* SEARCH RESULTS LIST */}
      {searchQuery && !activeProductKey && (
        <div className={`rounded-2xl border w-full divide-y shrink-0 ${lightMode ? "bg-white border-slate-200 divide-slate-100" : "bg-slate-900/60 border-slate-800 divide-slate-800"}`}>
          {searchResults.length === 0 ? (
            <div className="p-4 text-xs text-slate-400 font-medium">No matching products found.</div>
          ) : (
            searchResults.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => { setActiveProductKey(r.key); setSearchQuery(""); setNotFoundBarcode(null); }}
                className={`w-full text-left px-4 py-3 flex items-center justify-between gap-3 transition-colors ${lightMode ? "hover:bg-slate-50" : "hover:bg-slate-800/40"}`}
              >
                <div className="min-w-0">
                  <p className={`text-sm font-bold truncate ${lightMode ? "text-slate-800" : "text-slate-200"}`}>{r.name}</p>
                  <p className="text-[11px] text-slate-400 truncate">{r.generic}{r.barcode ? ` · ${r.barcode}` : " · No barcode"}</p>
                </div>
                <span className={`shrink-0 text-[10px] font-black uppercase px-2 py-0.5 rounded-lg border ${lightMode ? "bg-slate-100 border-slate-200 text-slate-500" : "bg-slate-950 border-slate-800 text-slate-400"}`}>
                  {r.batchCount} batch{r.batchCount !== 1 ? "es" : ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {/* NOT FOUND STATE */}
      {notFoundBarcode && (
        <div className={`rounded-2xl border p-5 sm:p-6 w-full flex flex-col gap-2 shrink-0 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
          <div className="flex items-center gap-2 text-amber-500">
            <span className="material-symbols-outlined text-lg">search_off</span>
            <span className="text-xs font-black uppercase tracking-wider">No product found for this barcode</span>
          </div>
          <p className="text-xs text-slate-400 font-medium leading-relaxed">
            Barcode <span className="font-mono font-bold">{notFoundBarcode}</span> isn't registered. Add it first in Stock Management → Add New Product.
          </p>
          <button type="button" onClick={resetToSearch} className={`self-start mt-1 text-xs font-bold px-3 py-1.5 rounded-lg border ${lightMode ? "border-slate-200 text-slate-600 hover:bg-slate-50" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
            Search again
          </button>
        </div>
      )}

      {/* ACTIVE PRODUCT — existing batches + add-new-batch */}
      {activeProductKey && activeTemplate && (
        <div className={`rounded-2xl border flex-1 flex flex-col min-h-0 w-full ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
          <div className={`p-4 sm:p-5 border-b flex flex-col sm:flex-row gap-3 justify-between sm:items-center shrink-0 ${lightMode ? "border-slate-200 bg-slate-50" : "border-slate-800 bg-slate-900/40"}`}>
            <div className="min-w-0">
              <h2 className={`text-sm sm:text-base font-black truncate ${lightMode ? "text-slate-800" : "text-slate-100"}`}>{activeTemplate.name}</h2>
              <p className="text-[11px] text-slate-400 font-medium truncate">{activeTemplate.generic}{activeTemplate.barcode ? ` · ${activeTemplate.barcode}` : " · No barcode"}</p>
            </div>
            <button type="button" onClick={resetToSearch} className={`shrink-0 self-start sm:self-auto text-xs font-bold px-3 py-1.5 rounded-lg border ${lightMode ? "border-slate-200 text-slate-600 hover:bg-white" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
              Search Again
            </button>
          </div>

          {inlineError && (
            <div className="mx-4 sm:mx-5 mt-4 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs font-bold shrink-0">
              {inlineError}
            </div>
          )}

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4 sm:p-5 flex flex-col gap-3 min-h-0">
            {activeGroup.map((item) => {
              const packFactor = parseInt(item.factor) || 2;
              const boxesLeft = Math.floor((item.totalUnits || 0) / packFactor);
              const stripsLeft = (item.totalUnits || 0) % packFactor;
              const inputs = rowInputs[item.id] || { addBoxes: "", addStrips: "" };
              const isThisRestocking = restockingId === item.id;

              return (
                <div key={item.id} className={`rounded-xl border p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 ${lightMode ? "border-slate-200 bg-slate-50/50" : "border-slate-800 bg-slate-950/30"}`}>
                  <div className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3 text-xs">
                    <div>
                      <p className="text-[10px] font-bold uppercase text-slate-400">Batch</p>
                      <p className={`font-mono font-bold ${lightMode ? "text-slate-700" : "text-slate-300"}`}>{item.batch || "N/A"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase text-slate-400">Expiry</p>
                      <p className={`font-mono font-bold ${lightMode ? "text-slate-700" : "text-slate-300"}`}>{item.expiry || "N/A"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase text-slate-400">Current Stock</p>
                      <p className={`font-mono font-bold ${lightMode ? "text-slate-700" : "text-slate-300"}`}>{boxesLeft} Box + {stripsLeft} Str</p>
                    </div>
                  </div>

                  <div className="flex items-end gap-2 shrink-0">
                    <div className="w-16 sm:w-20">
                      <label className="text-[9px] font-bold uppercase text-slate-400 block mb-0.5">+Boxes</label>
                      <input
                        type="number" min="0" placeholder="0"
                        value={inputs.addBoxes}
                        onChange={(e) => setRowInputs((prev) => ({ ...prev, [item.id]: { ...inputs, addBoxes: e.target.value } }))}
                        className={`w-full border rounded-lg py-1.5 px-2 text-xs font-mono text-center focus:outline-none ${lightMode ? "bg-white border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`}
                      />
                    </div>
                    <div className="w-16 sm:w-20">
                      <label className="text-[9px] font-bold uppercase text-slate-400 block mb-0.5">+Strips</label>
                      <input
                        type="number" min="0" placeholder="0"
                        value={inputs.addStrips}
                        onChange={(e) => setRowInputs((prev) => ({ ...prev, [item.id]: { ...inputs, addStrips: e.target.value } }))}
                        className={`w-full border rounded-lg py-1.5 px-2 text-xs font-mono text-center focus:outline-none ${lightMode ? "bg-white border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={isThisRestocking}
                      onClick={() => handleRestockRow(item)}
                      className="shrink-0 bg-gradient-to-r from-emerald-400 to-teal-400 text-slate-950 font-black py-2 px-3 rounded-lg text-[11px] uppercase tracking-wider hover:opacity-95 transition-all disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap"
                    >
                      {isThisRestocking ? "..." : "Add Stock"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ADD AS NEW BATCH — always a separate, explicit action */}
          <div className={`border-t p-4 sm:p-5 shrink-0 ${lightMode ? "border-slate-200" : "border-slate-800"}`}>
            {!showNewBatchForm ? (
              <button
                type="button"
                onClick={() => { setShowNewBatchForm(true); setInlineError(""); }}
                className={`w-full sm:w-auto flex items-center justify-center gap-2 text-xs font-bold px-4 py-2.5 rounded-xl border transition-colors ${lightMode ? "border-slate-200 text-slate-600 hover:bg-slate-50" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
              >
                <span className="material-symbols-outlined text-base">add</span>
                None of these — add as a new batch
              </button>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">New Batch — Not a Restock of the Above</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="space-y-1 col-span-2 sm:col-span-1">
                    <label className="text-[10px] font-bold uppercase text-slate-400">Batch No.</label>
                    <input ref={newBatchNumberRef} type="text" value={newBatch.batch} onChange={(e) => setNewBatch((p) => ({ ...p, batch: e.target.value }))} placeholder="Enter batch" className={`w-full border rounded-xl py-2 px-3 text-xs uppercase focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase text-slate-400">Expiry (MM/YYYY)</label>
                    <div className="flex gap-1.5">
                      <input type="text" inputMode="numeric" maxLength={2} placeholder="MM" value={newBatch.expiryMonth} onChange={(e) => setNewBatch((p) => ({ ...p, expiryMonth: e.target.value.replace(/\D/g, "").slice(0, 2) }))} className={`w-1/2 border rounded-xl py-2 px-2 text-xs text-center focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                      <input type="text" inputMode="numeric" maxLength={4} placeholder="YYYY" value={newBatch.expiryYear} onChange={(e) => setNewBatch((p) => ({ ...p, expiryYear: e.target.value.replace(/\D/g, "").slice(0, 4) }))} className={`w-1/2 border rounded-xl py-2 px-2 text-xs text-center focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase text-slate-400">Boxes</label>
                    <input type="number" min="0" value={newBatch.boxes} onChange={(e) => setNewBatch((p) => ({ ...p, boxes: e.target.value }))} placeholder="0" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase text-slate-400">Strips</label>
                    <input type="number" min="0" value={newBatch.strips} onChange={(e) => setNewBatch((p) => ({ ...p, strips: e.target.value }))} placeholder="0" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase text-slate-400">Buy Price</label>
                    <input type="number" min="0" value={newBatch.buyingPrice} onChange={(e) => setNewBatch((p) => ({ ...p, buyingPrice: e.target.value }))} placeholder="0" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase text-slate-400">Retail Price</label>
                    <input type="number" min="0" value={newBatch.retailPrice} onChange={(e) => setNewBatch((p) => ({ ...p, retailPrice: e.target.value }))} placeholder="0" className={`w-full border rounded-xl py-2 px-3 text-xs focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500"}`} />
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowNewBatchForm(false); setInlineError(""); }}
                    className={`flex-1 font-bold py-2.5 rounded-xl text-xs uppercase transition-colors border ${lightMode ? "bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200" : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"}`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isSavingNewBatch}
                    onClick={handleSaveNewBatch}
                    className="flex-1 bg-gradient-to-r from-sky-400 to-blue-400 text-slate-950 font-black py-2.5 rounded-xl text-xs uppercase tracking-wider shadow-md transition-all disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {isSavingNewBatch ? "Saving..." : "Save New Batch"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* EMPTY STATE — nothing searched yet */}
      {!activeProductKey && !notFoundBarcode && !searchQuery && (
        <div className={`rounded-2xl border p-8 sm:p-10 flex-1 flex flex-col items-center justify-center text-center gap-2 min-h-0 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
          <span className="material-symbols-outlined text-3xl text-slate-400">qr_code_scanner</span>
          <p className={`text-sm font-bold ${lightMode ? "text-slate-600" : "text-slate-300"}`}>Scan a product to begin</p>
          <p className="text-xs text-slate-400 max-w-sm">Its existing batches show up first, so restocking never gets mixed up with adding a new one.</p>
        </div>
      )}

      </div>

      {/* RIGHT COLUMN — browse by category instead of typing a search term */}
      <div className={`w-full lg:w-80 shrink-0 flex flex-col min-h-0 rounded-2xl border ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
        <div className={`p-4 border-b shrink-0 ${lightMode ? "border-slate-200" : "border-slate-800"}`}>
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Browse by Category</h3>
          <p className="text-[11px] text-slate-400 font-medium mt-1">Pick a category to browse its products.</p>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0">
          {!browseCategory ? (
            <div className="py-1">
              {ALL_CATEGORIES.filter((cat) => categoryCounts[cat.id]).map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setBrowseCategory(cat.id)}
                  className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 text-xs font-bold text-left transition-colors ${lightMode ? "text-slate-600 hover:bg-slate-50" : "text-slate-300 hover:bg-slate-800/40"}`}
                >
                  <span className="flex items-center gap-2 truncate min-w-0">
                    <span className="material-symbols-outlined text-base shrink-0 text-emerald-500">{cat.icon}</span>
                    <span className="truncate">{cat.label}</span>
                  </span>
                  <span className="text-[10px] font-mono opacity-60 shrink-0">{categoryCounts[cat.id]}</span>
                </button>
              ))}
            </div>
          ) : (
            <div>
              <button
                type="button"
                onClick={() => setBrowseCategory(null)}
                className={`w-full flex items-center gap-1.5 px-4 py-3 text-xs font-bold border-b transition-colors ${lightMode ? "border-slate-200 text-slate-500 hover:bg-slate-50" : "border-slate-800 text-slate-400 hover:bg-slate-800/40"}`}
              >
                <span className="material-symbols-outlined text-base">arrow_back</span>
                {ALL_CATEGORIES.find((c) => c.id === browseCategory)?.label}
              </button>
              {categoryProducts.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => { setActiveProductKey(p.key); setSearchQuery(""); setNotFoundBarcode(null); }}
                  className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-2 border-b transition-colors ${lightMode ? "border-slate-100 hover:bg-slate-50" : "border-slate-800/60 hover:bg-slate-800/40"} ${activeProductKey === p.key ? (lightMode ? "bg-emerald-50" : "bg-emerald-500/10") : ""}`}
                >
                  <div className="min-w-0">
                    <p className={`text-xs font-bold truncate ${lightMode ? "text-slate-800" : "text-slate-200"}`}>{p.name}</p>
                    <p className="text-[10px] text-slate-400 truncate">{p.generic}</p>
                  </div>
                  <span className={`shrink-0 text-[9px] font-black uppercase px-1.5 py-0.5 rounded border ${lightMode ? "bg-slate-100 border-slate-200 text-slate-500" : "bg-slate-950 border-slate-800 text-slate-400"}`}>
                    {p.batchCount}
                  </span>
                </button>
              ))}
              {categoryProducts.length === 0 && (
                <p className="px-4 py-4 text-xs text-slate-400">No products in this category.</p>
              )}
            </div>
          )}
        </div>
      </div>

      </div>
    </div>
  );
}

export default RestockScreen;