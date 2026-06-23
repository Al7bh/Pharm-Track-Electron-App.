import React from 'react';

function SalesCounter({ activeProduct, onAddItem, onDismiss, lightMode, cart = [] }) {
  if (!activeProduct) return null;

  const packFactor = activeProduct.factor || 2;
  
  // ==========================================
  // REAL-TIME STOCK CALCULATION
  // ==========================================
  // 1. Calculate how many raw units of this specific product are currently sitting in the cart
  const unitsInCart = cart.reduce((total, item) => {
    if (item.productId === activeProduct.id?.toString()) {
      return total + (item.rawUnits * item.qty);
    }
    return total;
  }, 0);

  // 2. Subtract the cart units from the database units to get the LIVE shelf availability
  const originalUnits = activeProduct.totalUnitsAvailable !== undefined ? activeProduct.totalUnitsAvailable : (activeProduct.totalUnits || 0);
  const totalUnits = Math.max(0, originalUnits - unitsInCart); 
  
  // ==========================================
  // PRICING & REMAINDERS
  // ==========================================
  // STRICT ROUNDING: Guarantees flat prices with absolutely no fractional cents
  const retailBoxPrice = Math.round(parseFloat(activeProduct.retailPricePerBox) || parseFloat(activeProduct.retailPrice) || 0);
  const retailStripPrice = Math.round(retailBoxPrice / packFactor);

  const boxesLeft = Math.floor(totalUnits / packFactor);
  const stripsLeft = totalUnits % packFactor;
  const isOutOfStock = totalUnits <= 0;
  const isLowStock = !isOutOfStock && totalUnits <= (packFactor * 2);

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

      <div className="grid grid-cols-2 gap-4 mt-1 text-xs">
        <button 
          type="button"
          // THE FIX: Explicitly send both the product and "Box"
          onClick={() => onAddItem(activeProduct, 'Box')}
          disabled={isOutOfStock || boxesLeft <= 0}
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
          disabled={isOutOfStock}
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
      </div>

    </div>
  );
}

export default SalesCounter;