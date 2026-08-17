import React, { useState, useEffect } from "react";

// Translates raw technical error text (SQL errors, network failures, etc.)
// into plain language before it's ever shown to a non-technical user. Same
// approach as App.jsx's friendlyErrorMessage — kept local here since this
// component doesn't have access to App.jsx's closures.
const friendlyErrorText = (err, fallback) => {
  const raw = (err && err.message ? err.message : "").toString();
  if (!raw) return fallback;
  const patterns = [
    [/sqlite_constraint.*unique/i, "This record already exists."],
    [/sqlite|database is locked|no such table|no such column/i, "There was a problem saving to the database. Please try again."],
    [/econnrefused|failed to fetch|networkerror|network error|fetch failed/i, "Couldn't reach the main computer. Please check the network connection."],
    [/etimedout|timeout/i, "The request took too long. Please check the connection and try again."],
    [/unexpected token|json/i, "Received an unexpected response. Please try again."],
  ];
  for (const [pattern, friendly] of patterns) {
    if (pattern.test(raw)) return friendly;
  }
  return fallback || "Something went wrong. Please try again.";
};

function SalesHistory({
  salesHistory = [],
  onTriggerRefresh,
  lightMode,
  scannedInvoiceId,
  clearScannedInvoice,
  onNotify,
}) {
  const [historyQuery, setHistoryQuery] = useState("");
  const [displayHistory, setDisplayHistory] = useState(salesHistory);
  const [isReprinting, setIsReprinting] = useState(false);
  const [isReturning, setIsReturning] = useState(false);

  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedInvoice, setSelectedInvoice] = useState(null);

  const [returnModal, setReturnModal] = useState({
    isOpen: false,
    sale: null,
    item: null,
    quantity: 1,
    maxQty: 1,
  });

  useEffect(() => {
    // The 5s poll hands us a brand-new array every time. Blindly adopting it
    // used to wipe an active search (showing ALL invoices under a search box
    // still reading "INV-4471") and snap the user back to page 1 mid-paging —
    // which meant clicking "the row my result was on" opened the return modal
    // on the WRONG invoice. Only sync when the user isn't searching.
    if (historyQuery.trim() === "") {
      setDisplayHistory(salesHistory);
    }

    // Keep the open inspector/return modal pointed at fresh data, so a return
    // is never computed from a snapshot another till has already changed.
    if (selectedInvoice) {
      const updatedInvoice = salesHistory.find((s) => s.id === selectedInvoice.id);
      setSelectedInvoice(updatedInvoice || null);
      setReturnModal((prev) => {
        if (!prev.isOpen || !prev.sale) return prev;
        const freshSale = salesHistory.find((s) => s.id === prev.sale.id);
        if (!freshSale) return prev;
        return { ...prev, sale: freshSale };
      });
    }
  }, [salesHistory]);

  useEffect(() => {
    if (scannedInvoiceId && salesHistory.length > 0) {
      const targetInvoice = salesHistory.find((s) => s.id === scannedInvoiceId);
      if (targetInvoice) {
        setSelectedInvoice(targetInvoice);
        if (clearScannedInvoice) clearScannedInvoice();
      }
    }
  }, [scannedInvoiceId, salesHistory, clearScannedInvoice]);

  useEffect(() => {
    const handleReturnDialogKeys = (e) => {
      if (returnModal.isOpen && e.key === "Escape") {
        e.preventDefault();
        handleCloseReturnModal();
      }
    };
    window.addEventListener("keydown", handleReturnDialogKeys);
    return () => window.removeEventListener("keydown", handleReturnDialogKeys);
  }, [returnModal.isOpen]);

  const handleLiveHistorySearch = async (e) => {
    const val = e.target.value;
    setHistoryQuery(val);
    setCurrentPage(1);
    if (window.electronAPI && window.electronAPI.searchSalesHistory) {
      const liveHistoryRows = await window.electronAPI.searchSalesHistory(val);
      setDisplayHistory(liveHistoryRows);
    }
  };

  // Reprint the selected invoice. Printing always happens on the server PC
  // (that's where the thermal printer is), so a client just asks the server.
  const handleReprintInvoice = async () => {
    if (!selectedInvoice || isReprinting) return;
    if (!window.electronAPI || !window.electronAPI.reprintReceipt) return;

    setIsReprinting(true);
    try {
      const res = await window.electronAPI.reprintReceipt(selectedInvoice.id);
      if (res && res.success) {
        if (onNotify) onNotify("Receipt Sent", `Invoice INV-${res.saleId} was sent to the printer.`, "success");
      } else {
if (onNotify) onNotify("Reprint Failed", (res && res.message) || "Could not reprint this receipt.", "error");
    }
  } catch (err) {
    if (onNotify) onNotify("Reprint Failed", friendlyErrorText(err, "Could not reach the printer. Please check the main computer."), "error");
  } finally {
      setIsReprinting(false);
    }
  };

  const handleOpenItemReturnModal = (sale, itemToReturn) => {
    setReturnModal({ isOpen: true, sale, item: itemToReturn, quantity: 1, maxQty: itemToReturn.qty });
  };

  const handleOpenFullBillReturnModal = (sale) => {
    setReturnModal({ isOpen: true, sale, item: null, quantity: 1, maxQty: 1 });
  };

  const handleCloseReturnModal = () => {
    setReturnModal({ isOpen: false, sale: null, item: null, quantity: 1, maxQty: 1 });
  };

  // ============================================================================
  // UNIFIED REFUND CALCULATOR (Fixes the "Discount Averaging" bug)
  // ============================================================================
  const calculateRefundValue = (sale, item, qtyToReturn) => {
    if (!sale || !item || qtyToReturn <= 0) return 0;

    // 1. Separate the item-level discounts from the total bill discount
    let totalItemDiscounts = 0;
    try {
      const itemsArray = JSON.parse(sale.itemsJson) || [];
      totalItemDiscounts = itemsArray.reduce((sum, i) => sum + (i.itemDiscountAmount || 0), 0);
    } catch (err) {}

    const originalSubtotal = parseFloat(sale.subtotal) || 0;
    const originalDiscountDeduction = parseFloat(sale.discountDeduction) || 0;
    
    // The remaining discount MUST be the "Whole Bill Discount"
    const trueGlobalDiscountAmount = Math.max(0, originalDiscountDeduction - totalItemDiscounts);

    // 2. Deduct this specific item's individual discount first
    const preDiscountValue = item.price * qtyToReturn;
    const lineDiscountShare = (item.itemDiscountAmount || 0) / (item.qty || 1);
    const itemLevelDeduction = lineDiscountShare * qtyToReturn;
    
    const valueAfterItemDiscount = preDiscountValue - itemLevelDeduction;

    // 3. Now deduct its share of the "Whole Bill Discount" (if there is one)
    let globalDiscountShare = 0;
    const globalPercent = parseFloat(sale.discountPercent) || 0;
    
    if (globalPercent > 0) {
      globalDiscountShare = valueAfterItemDiscount * (globalPercent / 100);
    } else if (trueGlobalDiscountAmount > 0) {
      const subtotalAfterItemDiscounts = originalSubtotal - totalItemDiscounts;
      const weight = subtotalAfterItemDiscounts > 0 ? (valueAfterItemDiscount / subtotalAfterItemDiscounts) : 0;
      globalDiscountShare = weight * trueGlobalDiscountAmount;
    }

    return Math.round(valueAfterItemDiscount - globalDiscountShare);
  };

  const handleConfirmReturnSubmit = async (e) => {
    e.preventDefault();
    const { sale, item, quantity } = returnModal;
    if (!window.electronAPI || !window.electronAPI.returnSaleItem) return;

    // The backend restock is relative (totalUnits + ?) and mints a fresh RET-
    // row per call, so a double-click refunded and restocked twice. Pressing
    // Enter in the quantity field submits too, which made this trivial to hit.
    if (isReturning) return;
    setIsReturning(true);

    try {
      if (item === null) {
        // FULL INVOICE BULK RETURN
        let itemsArray = [];
        try { itemsArray = JSON.parse(sale.itemsJson) || []; } catch (err) { return; }

        const bulkItemsToRestock = itemsArray.map(cartItem => ({
            productId: cartItem.productId || cartItem.id,
            type: cartItem.type,
            // unitsToReturn (strip-equivalent) is used for Box/Strip lines
            // and for any non-tablet product — unchanged from before.
            unitsToReturn: (cartItem.rawUnits || 1) * cartItem.qty,
            // For Tablet lines, qty IS the tablet count (see App.jsx cart
            // logic) — sent separately so the backend can restock through
            // the tablet accumulator instead of adding a fractional
            // strip-equivalent value straight into totalUnits.
            tabletQty: cartItem.type === "Tablet" ? cartItem.qty : undefined,
        }));

        await window.electronAPI.returnSaleItem({
          saleId: sale.id,
          returnItems: bulkItemsToRestock, 
          remainingItemsJson: "[]", 
          returnedItemsJson: sale.itemsJson, 
          newSubtotal: 0,
          newDiscountDeduction: 0,
          newGrandTotal: 0,
          deleteEntireSale: true, 
          refundAmount: sale.grandTotal 
        });
        
        setSelectedInvoice(null);
        handleCloseReturnModal();
        if (typeof onTriggerRefresh === "function") onTriggerRefresh();

      } else {
        // SINGLE ITEM PARTIAL RETURN
        const qtyToReturn = parseInt(quantity);
        if (isNaN(qtyToReturn) || qtyToReturn <= 0 || qtyToReturn > item.qty) return;

        let currentCartItems = [];
        try { currentCartItems = JSON.parse(sale.itemsJson) || []; } catch (err) { return; }

        const originalGrandTotal = Math.round(parseFloat(sale.grandTotal) || 0);
        const originalDiscountDeduction = parseFloat(sale.discountDeduction) || 0;
        
        const lineDiscountShare = (item.itemDiscountAmount || 0) / (item.qty || 1);
        const underlyingUnitsReturned = (item.rawUnits || 1) * qtyToReturn;

        let updatedCartItems = currentCartItems
          .map((cartItem) => {
            if (cartItem.id === item.id) {
              return {
                ...cartItem,
                qty: cartItem.qty - qtyToReturn,
                itemDiscountAmount: Math.round(Math.max(0, cartItem.itemDiscountAmount - lineDiscountShare * qtyToReturn)),
              };
            }
            return cartItem;
          })
          .filter((cartItem) => cartItem.qty > 0);

        const deleteEntireSale = updatedCartItems.length === 0;

        // =========================================================================
        // THE PENNY-DRIFT FAILSAFE
        // If this is the last item on the bill, refund the exact remaining Grand Total.
        // Otherwise, calculate its proportional refund value.
        // =========================================================================
        const valueDeducted = deleteEntireSale 
            ? originalGrandTotal 
            : calculateRefundValue(sale, item, qtyToReturn);

        const newGrandTotal = deleteEntireSale ? 0 : Math.round(Math.max(0, originalGrandTotal - valueDeducted));
        const newSubtotal = Math.round(updatedCartItems.reduce((acc, i) => acc + i.price * i.qty, 0));
        
        // Subtract the chunk of discount that we just refunded from the bill's total discount ledger
        const discountDeductedFromThisReturn = (item.price * qtyToReturn) - valueDeducted;
        const newDiscountDeduction = deleteEntireSale ? 0 : Math.round(Math.max(0, originalDiscountDeduction - discountDeductedFromThisReturn));

        const restockTargetId = item.productId || item.id;

        await window.electronAPI.returnSaleItem({
          saleId: sale.id,
          returnItems: [{
            productId: restockTargetId,
            type: item.type,
            unitsToReturn: underlyingUnitsReturned,
            tabletQty: item.type === "Tablet" ? qtyToReturn : undefined,
          }],
          remainingItemsJson: JSON.stringify(updatedCartItems),
          returnedItemsJson: JSON.stringify([{ ...item, qty: qtyToReturn }]), 
          newSubtotal,
          newDiscountDeduction,
          newGrandTotal,
          deleteEntireSale,
          refundAmount: valueDeducted 
        });

        if (deleteEntireSale) setSelectedInvoice(null);
        handleCloseReturnModal();
        if (typeof onTriggerRefresh === "function") onTriggerRefresh();
      }
    } catch (err) {
      console.error("Return failed:", err);
      const friendly = friendlyErrorText(err, "This return couldn't be processed. Please try again.");
      if (onNotify) {
        onNotify("Return Failed", friendly, "error");
      } else {
        alert(`This return couldn't be processed.\n${friendly}`);
      }
    } finally {
      setIsReturning(false);
    }
  };

  const cashierVisibleHistory = displayHistory.filter(sale => !sale.id.startsWith("RET-"));
  const totalFilteredRows = cashierVisibleHistory.length;
  const totalPagesCount = Math.ceil(totalFilteredRows / rowsPerPage) || 1;
  // The poll no longer forces us back to page 1, so clamp instead: if rows
  // disappear (a return deleted an invoice) the current page could otherwise
  // fall past the end and render an empty table.
  const safePage = Math.min(currentPage, totalPagesCount);
  const indexLastRow = safePage * rowsPerPage;
  const indexFirstRow = indexLastRow - rowsPerPage;
  const paginatedSalesSlice = cashierVisibleHistory.slice(indexFirstRow, indexLastRow);

  const handlePageChange = (direction) => {
    if (direction === "next" && safePage < totalPagesCount) setCurrentPage(safePage + 1);
    else if (direction === "prev" && safePage > 1) setCurrentPage(safePage - 1);
  };

  const extractItems = (jsonStr) => {
    try { return JSON.parse(jsonStr) || []; } catch (e) { return []; }
  };

  const calculateLiveRefund = () => {
    return calculateRefundValue(returnModal.sale, returnModal.item, Number(returnModal.quantity) || 0);
  };

  return (
    <div className={`flex-1 flex overflow-hidden h-full w-full min-h-0 ${lightMode ? "bg-slate-100" : "bg-slate-950"}`}>
      
      {/* REFUND MODAL */}
      {returnModal.isOpen && (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
          <form
            onSubmit={handleConfirmReturnSubmit}
            className={`border p-6 rounded-2xl max-w-sm w-full shadow-2xl flex flex-col gap-4 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}
          >
            <div className="flex items-center gap-3 border-b pb-3 border-slate-200/20">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${returnModal.item === null ? "bg-rose-500/10 border-rose-500/20 text-rose-500" : "bg-amber-500/10 border-amber-500/20 text-amber-500"}`}>
                <span className="material-symbols-outlined">{returnModal.item === null ? "delete_sweep" : "assignment_return"}</span>
              </div>
              <div>
                <h3 className={`text-sm font-black uppercase tracking-wider ${lightMode ? "text-slate-800" : "text-slate-200"}`}>
                  {returnModal.item === null ? "Refund Total Bill" : "Return Item"}
                </h3>
                <p className="text-xs text-slate-400 font-medium mt-0.5 truncate">
                  {returnModal.item === null ? `Invoice: ${returnModal.sale.id.replace("sale-", "")}` : `Item: ${returnModal.item.name}`}
                </p>
              </div>
            </div>

            {returnModal.item !== null ? (
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex justify-between">
                  <span>Quantity to Return</span>
                  <span className="text-slate-500 font-mono">Max: {returnModal.maxQty}</span>
                </div>
                <input
                  type="number"
                  min="1"
                  max={returnModal.maxQty}
                  required
                  value={returnModal.quantity}
                  onChange={(e) => {
                    let val = parseInt(e.target.value);
                    if (val > returnModal.maxQty) val = returnModal.maxQty;
                    if (val < 1 || isNaN(val)) val = 1;
                    setReturnModal((prev) => ({ ...prev, quantity: val }));
                  }}
                  className={`w-full border rounded-xl py-2 px-3 text-center font-mono text-base font-bold focus:outline-none shadow-inner transition-colors ${lightMode ? "bg-slate-50 border-slate-200 text-slate-800 focus:border-amber-500" : "bg-slate-950 border-slate-800 text-amber-400 focus:border-amber-500"}`}
                />
                
                <div className="flex justify-between items-center text-xs font-black text-rose-500 pt-3 border-t border-slate-200/20">
                    <span>Live Refund Value:</span>
                    <span className="font-mono text-sm">
                      Rs. {calculateLiveRefund()}
                    </span>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className={`text-xs font-medium leading-relaxed p-3 rounded-xl border shadow-inner ${lightMode ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-slate-950/40 border-slate-800/60 text-slate-400"}`}>
                  Are you sure you want to completely refund this entire invoice transaction sheet? All items inside will be re-credited to inventory stock rows.
                </p>
                <div className="flex justify-between items-center text-xs font-black text-rose-500 pt-1">
                    <span>Total Bill Refund:</span>
                    <span className="font-mono text-sm">Rs. {Math.round(returnModal.sale.grandTotal)}</span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button type="button" onClick={handleCloseReturnModal} disabled={isReturning} className={`w-full font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition-colors border disabled:opacity-40 disabled:pointer-events-none ${lightMode ? "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200" : "bg-slate-800 hover:bg-slate-700 text-white border-slate-700"}`}>
                Cancel
              </button>
              <button type="submit" disabled={isReturning} className={`w-full text-slate-950 font-black py-2.5 rounded-xl text-xs uppercase tracking-wider shadow-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:pointer-events-none ${returnModal.item === null ? "bg-gradient-to-r from-rose-500 to-red-500" : "bg-gradient-to-r from-amber-400 to-orange-400"}`}>
                {isReturning ? "Processing..." : "Confirm Return"}
              </button>
            </div>
          </form>
        </div>
      )}

      <section className="flex-1 flex flex-col overflow-hidden h-full min-h-0">
        <div className={`p-4 border-b flex flex-col sm:flex-row gap-4 justify-between sm:items-center shrink-0 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}>
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Archived Historical Invoices</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Logs of daily counter transactions</p>
          </div>
          <div className="relative w-full sm:w-80">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 text-base">search</span>
            <input
              type="text"
              placeholder="Search Invoice ID or Product..."
              value={historyQuery}
              onChange={handleLiveHistorySearch}
              className={`w-full border rounded-xl py-2 pl-10 pr-4 text-xs focus:outline-none transition-all ${lightMode ? "bg-white border-slate-200 text-slate-900 focus:border-emerald-500" : "bg-slate-950 border-slate-800 text-slate-200 focus:border-emerald-500/60"}`}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0 bg-transparent">
          {totalFilteredRows === 0 ? (
            <div className={`h-[calc(100%-2rem)] flex flex-col items-center justify-center text-slate-500 gap-3 border border-dashed m-4 rounded-2xl ${lightMode ? "border-slate-200" : "border-slate-800"}`}>
              <span className="material-symbols-outlined text-4xl">history_toggle_off</span>
              <p className="text-xs font-bold tracking-widest uppercase">No invoice transactions found</p>
            </div>
          ) : (
            <table className="w-full text-left border-separate border-spacing-0 text-xs">
              <thead className={`sticky top-0 z-10 border-b text-[10px] font-black uppercase tracking-widest text-slate-400 select-none ${lightMode ? "bg-slate-50 border-slate-200 shadow-sm" : "bg-slate-950 border-slate-800"}`}>
                <tr>
                  <th className="py-4 px-6 border-b border-slate-800/20">Invoice ID</th>
                  <th className="py-4 px-4 border-b border-slate-800/20">Timestamp</th>
                  <th className="py-4 px-4 border-b border-slate-800/20 text-center">Items Count</th>
                  <th className="py-4 px-6 border-b border-slate-800/20 text-right">Gross Total</th>
                  <th className="py-4 px-6 border-b border-slate-800/20 text-right text-emerald-500">Net paid</th>
                </tr>
              </thead>
              <tbody className={`font-medium divide-y ${lightMode ? "divide-slate-100" : "divide-slate-800/40"}`}>
                {paginatedSalesSlice.map((sale) => {
                  const items = extractItems(sale.itemsJson);
                  const rawNumStr = sale.id.replace("sale-", "");
                  const cleanInvoiceDisplayId = `INV-${rawNumStr}`;
                  
                  const isSelected = selectedInvoice && selectedInvoice.id === sale.id;

                  let rowClasses = `transition-colors duration-150 cursor-pointer ${
                    isSelected
                      ? lightMode ? "bg-emerald-500/10 hover:bg-emerald-500/15" : "bg-emerald-500/5 hover:bg-emerald-500/10"
                      : lightMode ? "hover:bg-slate-50" : "hover:bg-slate-800/30"
                  }`;

                  return (
                    <tr key={sale.id} onClick={() => setSelectedInvoice(sale)} className={rowClasses}>
                      <td className="py-4 px-6 font-mono font-black text-emerald-600 dark:text-emerald-400">
                        {cleanInvoiceDisplayId}
                      </td>
                      <td className="py-4 px-4 font-mono text-slate-400">
                        {new Date(sale.timestamp).toLocaleString("en-PK", {
                          day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
                        })}
                      </td>
                      <td className="py-4 px-4 text-center font-bold">
                        {items.reduce((sum, i) => sum + i.qty, 0)}
                      </td>
                      <td className="py-4 px-6 text-right font-mono text-slate-400 font-semibold">
                        Rs. {Math.round(sale.subtotal)}
                      </td>
                      <td className="py-4 px-6 text-right font-mono font-black text-sm text-emerald-500">
                        Rs. {Math.round(sale.grandTotal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className={`p-4 border-t flex items-center justify-between font-medium text-xs select-none shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800"}`}>
          <div className="flex items-center gap-2 text-slate-400">
            <span>Rows per page:</span>
            <select value={rowsPerPage} onChange={(e) => { setRowsPerPage(parseInt(e.target.value)); setCurrentPage(1); }} className={`py-1 px-2 border rounded-lg focus:outline-none font-bold ${lightMode ? "bg-white border-slate-200 text-slate-700" : "bg-slate-900 border-slate-800 text-slate-300"}`}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={150}>150</option>
            </select>
          </div>
          <div className="text-slate-400 font-mono">
            Showing <span className="font-bold text-slate-500">{totalFilteredRows === 0 ? 0 : indexFirstRow + 1}</span> - <span className="font-bold text-slate-500">{Math.min(indexLastRow, totalFilteredRows)}</span> of <span className="font-bold text-slate-500">{totalFilteredRows}</span> invoices
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={safePage === 1} onClick={() => handlePageChange("prev")} className={`w-8 h-8 rounded-xl flex items-center justify-center border font-black transition-all disabled:opacity-20 disabled:pointer-events-none ${lightMode ? "bg-white border-slate-200 hover:bg-slate-100" : "bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
              <span className="material-symbols-outlined text-base">chevron_left</span>
            </button>
            <span className="font-mono font-bold px-2 text-slate-400">Page {safePage} / {totalPagesCount}</span>
            <button type="button" disabled={safePage === totalPagesCount} onClick={() => handlePageChange("next")} className={`w-8 h-8 rounded-xl flex items-center justify-center border font-black transition-all disabled:opacity-20 disabled:pointer-events-none ${lightMode ? "bg-white border-slate-200 hover:bg-slate-100" : "bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
              <span className="material-symbols-outlined text-base">chevron_right</span>
            </button>
          </div>
        </div>
      </section>

      <section className={`w-[400px] border-l flex flex-col shrink-0 h-full overflow-hidden shadow-2xl transition-all ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 backdrop-blur-md border-slate-800"}`}>
        <div className={`p-4 border-b flex justify-between items-center shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-900/80 border-slate-800/80"}`}>
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">receipt_long</span>
            <span>Invoice Inspection</span>
          </h2>
          {selectedInvoice && (
            <button onClick={() => setSelectedInvoice(null)} className="text-slate-400 hover:text-slate-600 flex items-center text-xs font-bold transition-colors">Close Inspector</button>
          )}
        </div>

        <div className={`flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar min-h-0 ${lightMode ? "bg-slate-50/50" : "bg-slate-950/20"}`}>
          {!selectedInvoice ? (
            <div className={`h-full flex flex-col items-center justify-center text-slate-400 gap-2 border-2 border-dashed rounded-2xl m-1 ${lightMode ? "border-slate-200/60" : "border-slate-800/60"}`}>
              <span className="material-symbols-outlined text-4xl mb-1 animate-bounce">toc</span>
              <p className="text-xs font-bold tracking-wide uppercase text-center px-6 leading-relaxed">Click any row record to inspect itemization sheets</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-center border-b border-dashed pb-3 border-slate-200/20">
                <div className="text-xs font-mono font-black text-emerald-500">
                  {selectedInvoice.id.startsWith("sale-") ? `INV-${selectedInvoice.id.replace("sale-", "")}` : selectedInvoice.id}
                </div>
                <div className="text-[10px] text-slate-400 font-mono mt-1">
                  {new Date(selectedInvoice.timestamp).toLocaleString("en-PK")}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-[10px] font-black uppercase text-slate-400 tracking-wider px-1">
                  Purchased Line Items:
                </div>
                {extractItems(selectedInvoice.itemsJson).map((item) => (
                  <div
                    key={item.id}
                    onClick={() => handleOpenItemReturnModal(selectedInvoice, item)}
                    title="Click item row to process target refund values"
                    className={`border rounded-xl p-3 flex justify-between items-center group transition-all shadow-sm cursor-pointer ${lightMode ? "bg-white border-slate-200 hover:border-amber-400" : "bg-slate-900 border-slate-800 hover:border-amber-500/60"}`}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <h4 className="text-xs font-black truncate transition-colors group-hover:text-amber-500">
                        {item.name}
                      </h4>
                      <p className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
                        <span>Batch: {item.batch}</span>
                        <span>•</span>
                        <span>Rs. {Math.round(item.price)} ({item.type?.toLowerCase() || 'unit'})</span>
                      </p>
                    </div>
                    <div className="text-right shrink-0 flex items-center gap-3">
                      <div className="flex flex-col items-end">
                        <span className="font-mono text-xs font-black">
                          Rs. {Math.round(item.price * item.qty)}
                        </span>
                        <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded-md font-black mt-0.5 ${lightMode ? "bg-slate-100 text-slate-500" : "bg-slate-800 text-slate-400"}`}>
                          QTY: {item.qty}
                        </span>
                      </div>
                      <span className="material-symbols-outlined text-sm text-slate-500 group-hover:text-amber-500 transition-colors">keyboard_return</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {selectedInvoice && (
          <div className={`border-t p-5 flex flex-col gap-3 shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800"}`}>
            <div className="space-y-2 text-xs font-bold uppercase">
              <div className="flex justify-between items-center">
                <span>Invoice Subtotal:</span>
                <span className="font-mono">Rs. {Math.round(selectedInvoice.subtotal)}</span>
              </div>
              {selectedInvoice.discountDeduction > 0 && (
                <div className="flex justify-between items-center text-rose-500">
                  <span>Discount Deducted:</span>
                  <span className="font-mono">- Rs. {Math.round(selectedInvoice.discountDeduction)}</span>
                </div>
              )}
              <div className="flex justify-between items-center border-t pt-2 text-sm text-emerald-400 border-slate-800/40">
                <span><b>NET REVENUE:</b></span>
                <span className="font-mono text-base font-black">Rs. {Math.round(selectedInvoice.grandTotal)}</span>
              </div>
            </div>
            
            <button
              type="button"
              onClick={handleReprintInvoice}
              disabled={isReprinting}
              className={`w-full font-black py-3 rounded-xl text-xs uppercase tracking-wider shadow-sm mt-2 flex items-center justify-center gap-2 border transition-all disabled:opacity-50 disabled:pointer-events-none ${
                lightMode
                  ? "bg-white border-slate-200 text-slate-700 hover:border-emerald-500 hover:text-emerald-600"
                  : "bg-slate-900 border-slate-700 text-slate-300 hover:border-emerald-500 hover:text-emerald-400"
              }`}
            >
              <span className="material-symbols-outlined text-base font-black">print</span>
              <span>{isReprinting ? "Sending to printer..." : "Reprint This Receipt"}</span>
            </button>

            <button
              type="button"
              onClick={() => handleOpenFullBillReturnModal(selectedInvoice)}
              className="w-full bg-gradient-to-r from-rose-500 to-red-500 text-slate-950 font-black py-3.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90 flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-base font-black">delete_sweep</span>
              <span>Return Whole Invoice Bill</span>
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default SalesHistory;