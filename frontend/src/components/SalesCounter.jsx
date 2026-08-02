import React, { useState } from 'react';

function SalesCounter({ activeProduct, onAddItem, onDismiss, lightMode, cart = [] }) {
  // Hooks must run unconditionally on every render — declared before the
  // early "no active product" return below, not after it.
  const [isTabletPromptOpen, setIsTabletPromptOpen] = useState(false);
  const [tabletQtyInput, setTabletQtyInput] = useState("");

  if (!activeProduct) return null;

  const packFactor = activeProduct.factor || 2;
  // Feature 2/3: only products with a tabletsPerStrip value configured show
  // the tablet-sale option. Everything else keeps exactly the two options
  // it has today (Add 1 Full Box / Add Loose Strip) — nothing else changes.
  const tabletsPerStrip = parseInt(activeProduct.tabletsPerStrip) || 0;
  const isTabletSellable = tabletsPerStrip > 0;

  // ==========================================
  // REAL-TIME STOCK CALCULATION
  // ==========================================
  const originalUnits = activeProduct.totalUnitsAvailable !== undefined ? activeProduct.totalUnitsAvailable : (activeProduct.totalUnits || 0);
  const openStripTablets = isTabletSellable ? (parseInt(activeProduct.openStripTablets) || 0) : 0;

  let totalUnits;
  let availableTablets = 0;

  if (isTabletSellable) {
    // Tablet-enabled products: totalUnits alone can overstate what's truly
    // sellable, since one of those "strips" might actually be sitting
    // opened with only a few tablets left in it. Real availability is
    // tracked in tablets — accounting for the open-strip accumulator and
    // EVERY reservation already in the cart for this product, whether it
    // was added as a Box, Strip, or Tablet — and only converted back to
    // whole boxes/strips for this display. This is what stops a strip at,
    // say, 3 tablets left from showing (or being sold) as a full one.
    let tabletsInCart = 0;
    cart.forEach((item) => {
      if (item.productId === activeProduct.id?.toString()) {
        tabletsInCart += item.type === "Tablet"
          ? item.qty
          : item.rawUnits * item.qty * tabletsPerStrip;
      }
    });
    const rawAvailable = (Math.max(0, originalUnits) * tabletsPerStrip) - openStripTablets;
    availableTablets = Math.max(0, rawAvailable - tabletsInCart);
    totalUnits = Math.floor(availableTablets / tabletsPerStrip);
  } else {
    // Unchanged path for non-tablet products.
    const unitsInCart = cart.reduce((total, item) => {
      if (item.productId === activeProduct.id?.toString()) {
        return total + (item.rawUnits * item.qty);
      }
      return total;
    }, 0);
    totalUnits = Math.max(0, originalUnits - unitsInCart);
  }

  // ==========================================
  // PRICING & REMAINDERS
  // ==========================================
  // STRICT ROUNDING: Guarantees flat prices with absolutely no fractional cents
  const retailBoxPrice = Math.round(parseFloat(activeProduct.retailPricePerBox) || parseFloat(activeProduct.retailPrice) || 0);
  const retailStripPrice = Math.round(retailBoxPrice / packFactor);
  const retailTabletPrice = isTabletSellable ? (retailStripPrice / tabletsPerStrip) : 0;

  const boxesLeft = Math.floor(totalUnits / packFactor);
  const stripsLeft = totalUnits % packFactor;
  const isOutOfStock = isTabletSellable ? availableTablets <= 0 : totalUnits <= 0;
  const isLowStock = !isOutOfStock && (
    isTabletSellable
      ? availableTablets <= (packFactor * tabletsPerStrip * 2)
      : totalUnits <= (packFactor * 2)
  );
  // Whether a full Strip/Box sale is actually possible right now — separate
  // from isOutOfStock, since a tablet-enabled product can have tablets
  // available (e.g. 3 left in an open strip) while genuinely having zero
  // WHOLE strips/boxes available to sell as such.
  const canSellFullStrip = isTabletSellable ? availableTablets >= tabletsPerStrip : !isOutOfStock;
  const canSellFullBox = isTabletSellable ? availableTablets >= (tabletsPerStrip * packFactor) : boxesLeft > 0;

  const handleConfirmTabletAdd = () => {
    const qty = parseInt(tabletQtyInput) || 0;
    if (qty <= 0) return;
    onAddItem(activeProduct, 'Tablet', qty);
    setTabletQtyInput("");
    setIsTabletPromptOpen(false);
  };

  return (
    <div className={`rounded-2xl border p-5 flex flex-col gap-4 shadow-xl relative w-full transition-all group animate-in fade-in slide-in-from-top-3 duration-200 ${
      lightMode ? "bg-white border-slate-200 hover:border-slate-300 shadow-slate-100" : "bg-slate-900/60 backdrop-blur-md border-slate-800 hover:border-slate-700/50"
    }`}>
      
      <div className={`flex justify-between items-start border-b pb-3 ${lightMode ? "border-slate-100" : "border-slate-800/80"}`}>
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h2 className={`text-base font-black tracking-wide transition-colors group-hover:text-emerald-500 ${lightMode ? "text-slate-800" : "text-slate-100"}`}>
              {activeProduct.name || "Unknown Medication"}
            </h2>
            <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border uppercase tracking-wider ${
              lightMode ? "bg-slate-100 border-slate-200 text-slate-600" : "bg-slate-950 border-slate-800 text-slate-400"
            }`}>
              {activeProduct.batch || "N/A"}
            </span>
          </div>
          <p className="text-xs text-slate-500 font-medium">
            Formulation: <span className={`italic ${lightMode ? "text-slate-600" : "text-slate-400"}`}>{activeProduct.generic || activeProduct.formula || "Generic Not Listed"}</span>
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          {isOutOfStock ? (
            <span className="bg-rose-500/10 text-rose-500 border border-rose-500/20 px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider">
              Out of Stock
            </span>
          ) : isLowStock ? (
            <span className="bg-amber-500/10 text-amber-500 border border-amber-500/20 px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider animate-pulse">
              Low Stock Alert
            </span>
          ) : (
            <span className="bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider">
              Stock Available
            </span>
          )}
          
          <button 
            type="button"
            onClick={onDismiss} 
            className={`transition-all p-1.5 rounded-xl flex items-center justify-center border text-slate-400 hover:text-rose-500 ${
              lightMode ? "bg-slate-50 border-slate-200 hover:bg-slate-100" : "hover:bg-slate-800/80 border-transparent hover:border-slate-700/40"
            }`}
          >
            <span className="material-symbols-outlined text-sm font-bold">close</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 text-xs">
        <div className={`p-3 rounded-xl border flex flex-col gap-1 shadow-inner ${lightMode ? "bg-slate-50/50 border-slate-150" : "bg-slate-950/40 border-slate-800/60"}`}>
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Expiration Threshold</span>
          <span className={`font-mono font-bold tracking-wide mt-0.5 ${lightMode ? "text-slate-700" : "text-slate-300"}`}>
            {activeProduct.expiry || "N/A"}
          </span>
        </div>
        
        <div className={`p-3 rounded-xl border flex flex-col gap-1 shadow-inner ${lightMode ? "bg-slate-50/50 border-slate-150" : "bg-slate-950/40 border-slate-800/60"}`}>
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Conversion Multiplier</span>
          <span className="font-mono text-emerald-500 font-extrabold mt-0.5">
            {packFactor} <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Strips / Box</span>
          </span>
        </div>

        <div className={`p-3 rounded-xl border flex flex-col gap-1 shadow-inner ${lightMode ? "bg-slate-50/50 border-slate-150" : "bg-slate-950/40 border-slate-800/60"}`}>
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Warehouse Sub-Units Balance</span>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className={`text-base font-black font-mono ${isOutOfStock ? "text-slate-400" : lightMode ? "text-slate-800" : "text-slate-100"}`}>{boxesLeft}</span>
            <span className="text-[9px] text-slate-400 font-black uppercase tracking-wider mr-1.5">Boxes</span>
            <span className={`text-base font-black font-mono ${isOutOfStock ? "text-slate-400" : lightMode ? "text-slate-800" : "text-slate-100"}`}>{stripsLeft}</span>
            <span className="text-[9px] text-slate-400 font-black uppercase tracking-wider">Strips</span>
          </div>
        </div>
      </div>

      <div className={`grid ${isTabletSellable ? "grid-cols-3" : "grid-cols-2"} gap-4 mt-1 text-xs`}>
        <button 
          type="button"
          // THE FIX: Explicitly send both the product and "Box"
          onClick={() => onAddItem(activeProduct, 'Box')}
          disabled={isOutOfStock || !canSellFullBox}
          className={`font-black py-3 px-4 rounded-xl transition-all flex items-center justify-between group/btn disabled:opacity-20 disabled:pointer-events-none shadow-sm border ${
            lightMode 
              ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-500 hover:text-slate-900" 
              : "bg-emerald-500/5 text-emerald-400 border-emerald-500/20 hover:bg-gradient-to-r hover:from-emerald-400 hover:to-teal-400 hover:text-slate-950"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-lg">layers</span>
            <span className="uppercase tracking-wider">Add 1 Full Box</span>
          </div>
          <span className={`font-mono text-xs font-black px-3 py-1 rounded-lg border ${
            lightMode ? "bg-white border-emerald-300" : "bg-slate-950/40 border-slate-800/60 group-hover/btn:bg-slate-950/10 group-hover/btn:border-transparent"
          }`}>
            Rs. {retailBoxPrice}
          </span>
        </button>

        <button 
          type="button"
          // THE FIX: Explicitly send both the product and "Strip"
          onClick={() => onAddItem(activeProduct, 'Strip')}
          disabled={isOutOfStock || !canSellFullStrip}
          className={`font-black py-3 px-4 rounded-xl transition-all flex items-center justify-between group/btn disabled:opacity-20 disabled:pointer-events-none shadow-sm border ${
            lightMode 
              ? "bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-200 hover:text-slate-900" 
              : "bg-slate-950/40 text-slate-300 border border-slate-800 hover:bg-slate-800 hover:text-white"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-lg">pill</span>
            <span className="uppercase tracking-wider">Add Loose Strip</span>
          </div>
          <span className={`font-mono text-xs font-black px-3 py-1 rounded-lg border text-emerald-500 ${
            lightMode ? "bg-white border-slate-200" : "bg-slate-950 border-slate-800/60"
          }`}>
            Rs. {retailStripPrice}
          </span>
        </button>

        {isTabletSellable && (
          <button
            type="button"
            onClick={() => setIsTabletPromptOpen(true)}
            disabled={isOutOfStock || availableTablets <= 0}
            className={`font-black py-3 px-4 rounded-xl transition-all flex items-center justify-between group/btn disabled:opacity-20 disabled:pointer-events-none shadow-sm border ${
              lightMode
                ? "bg-sky-50 border-sky-200 text-sky-700 hover:bg-sky-500 hover:text-slate-900"
                : "bg-sky-500/5 text-sky-400 border-sky-500/20 hover:bg-sky-500/20"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-lg">medication</span>
              <span className="uppercase tracking-wider">Add Tablet(s)</span>
            </div>
            <span className={`font-mono text-xs font-black px-3 py-1 rounded-lg border text-sky-500 ${
              lightMode ? "bg-white border-slate-200" : "bg-slate-950 border-slate-800/60"
            }`}>
              Rs. {retailTabletPrice.toFixed(1)}/ea
            </span>
          </button>
        )}
      </div>

      {isTabletSellable && isTabletPromptOpen && (
        <div className={`rounded-xl border p-4 flex items-center gap-3 ${lightMode ? "bg-sky-50/50 border-sky-200" : "bg-sky-950/20 border-sky-500/20"}`}>
          <span className="material-symbols-outlined text-sky-500 text-lg shrink-0">medication</span>
          <div className="flex-1">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
              How many tablets? ({availableTablets} available)
            </label>
            <input
              type="number"
              min="1"
              max={availableTablets}
              autoFocus
              value={tabletQtyInput}
              onChange={(e) => setTabletQtyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleConfirmTabletAdd(); if (e.key === "Escape") setIsTabletPromptOpen(false); }}
              placeholder="e.g. 2"
              className={`w-full border rounded-lg py-2 px-3 text-sm font-mono focus:outline-none ${lightMode ? "bg-white border-sky-200 text-slate-800 focus:border-sky-500" : "bg-slate-950 border-sky-500/30 text-slate-200 focus:border-sky-500"}`}
            />
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <button
              type="button"
              onClick={handleConfirmTabletAdd}
              disabled={!tabletQtyInput || parseInt(tabletQtyInput) <= 0 || parseInt(tabletQtyInput) > availableTablets}
              className="px-4 py-2 rounded-lg text-xs font-black uppercase bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-40 disabled:pointer-events-none"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => { setIsTabletPromptOpen(false); setTabletQtyInput(""); }}
              className={`px-4 py-2 rounded-lg text-xs font-black uppercase border ${lightMode ? "border-slate-200 text-slate-500 hover:bg-slate-100" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

export default SalesCounter;