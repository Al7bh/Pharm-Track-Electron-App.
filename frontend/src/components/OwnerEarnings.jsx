import React, { useState } from "react";

function OwnerEarnings({ inventory, salesHistory, lightMode, onDeleteReturnTranscript }) {
  const [vaultView, setVaultView] = useState("overview"); 
  const [timeFilter, setTimeFilter] = useState("all"); 
  const [graphView, setGraphView] = useState("monthly"); 

  const [passwords, setPasswords] = useState({ oldPin: "", newPin: "", confirmPin: "" });
  const [passMessage, setPassMessage] = useState({ text: "", type: "" });
  const [selectedReturnInvoice, setSelectedReturnInvoice] = useState(null);
  const [returnDeleteConfirm, setReturnDeleteConfirm] = useState(false);
  const [isDeletingReturn, setIsDeletingReturn] = useState(false);

  const [newUsername, setNewUsername] = useState("");
  const [userMessage, setUserMessage] = useState({ text: "", type: "" });

  const totalAssetsValue = Math.round(inventory.reduce((sum, item) => {
    const safeFactor = item.factor > 0 ? item.factor : 1; // <--- The Infinity Guard
    const boxesCount = Math.floor(item.totalUnits / safeFactor);
    const extraStripsCount = item.totalUnits % safeFactor;
    const individualStripCost = (item.buyingPrice || 0) / safeFactor;
    return sum + (boxesCount * (item.buyingPrice || 0)) + (extraStripsCount * individualStripCost);
  }, 0));

  const totalExpectedProfit = Math.round(inventory.reduce((sum, item) => {
    const safeFactor = item.factor > 0 ? item.factor : 1; // <--- The Infinity Guard
    const boxesCount = Math.floor(item.totalUnits / safeFactor);
    const extraStripsCount = item.totalUnits % safeFactor;
    const individualStripCost = (item.buyingPrice || 0) / safeFactor;
    const totalItemWholesaleCost = (boxesCount * (item.buyingPrice || 0)) + (extraStripsCount * individualStripCost);
    const individualStripRetail = (item.retailPrice || 0) / safeFactor;
    const totalItemExpectedRetailValue = (boxesCount * (item.retailPrice || 0)) + (extraStripsCount * individualStripRetail);
    return sum + (totalItemExpectedRetailValue - totalItemWholesaleCost);
  }, 0));

  const filteredSales = salesHistory.filter((record) => {
    if (timeFilter === "all") return true;
    const recordDate = new Date(record.timestamp);
    const currentDate = new Date();
    
    if (timeFilter === "thisMonth") {
      return (recordDate.getMonth() === currentDate.getMonth() && recordDate.getFullYear() === currentDate.getFullYear());
    }
    if (timeFilter === "prevMonth") {
      const targetMonth = currentDate.getMonth() === 0 ? 11 : currentDate.getMonth() - 1;
      const targetYear = currentDate.getMonth() === 0 ? currentDate.getFullYear() - 1 : currentDate.getFullYear();
      return (recordDate.getMonth() === targetMonth && recordDate.getFullYear() === targetYear);
    }
    return true;
  });

  const returnInvoices = salesHistory.filter((record) => record.id.startsWith("RET-"));

  // Switched from grandTotal to subtotal so Gross Sales reflects true shelf movement
  // Now uses grandTotal so it perfectly matches the Net Profit baseline
  const totalGrossSales = Math.round(filteredSales.reduce((sum, record) => !record.id.startsWith("RET-") ? sum + (record.grandTotal || 0) : sum, 0));
  const totalRefunds = Math.round(filteredSales.reduce((sum, record) => record.id.startsWith("RET-") ? sum + Math.abs(record.grandTotal || 0) : sum, 0));
  const totalDiscounts = Math.round(filteredSales.reduce((sum, record) => !record.id.startsWith("RET-") ? sum + (record.discountDeduction || 0) : sum, 0));

  // Shared per-sale profit calculation — used both for the top-line Net
  // Profit figure and for the daily/weekly/monthly profit bars in the graph
  // below, so the two numbers can never drift apart. Returns/refunds
  // contribute 0 (their effect already nets out of revenue elsewhere).
  const calculateSaleProfit = (record) => {
    if (record.id.startsWith("RET-")) return 0;

    let itemsArray = [];
    try { itemsArray = JSON.parse(record.itemsJson) || []; } catch (e) {}

    const actualRevenue = record.grandTotal || 0;
    let totalCostForThisSale = 0;

    itemsArray.forEach(item => {
      let historicalCost = item.unitCost;

      // LEGACY FALLBACK: If this is an old sale from before the patch, fetch from live inventory
      if (historicalCost === undefined) {
        const targetId = item.productId || item.id;
        const liveItem = inventory.find(inv => inv.id?.toString() === targetId?.toString());
        const packFactor = liveItem?.factor || 2; // Defaulting to your pack factor of 2
        const liveBoxCost = parseFloat(liveItem?.buyingPrice) || 0;

        if (item.type === "Box") {
          historicalCost = liveBoxCost;
        } else if (item.type === "Strip") {
          historicalCost = liveBoxCost / packFactor;
        } else {
          // Absolute failsafe for corrupted old records
          historicalCost = ((item.price || 0) * 0.80);
        }
      }

      totalCostForThisSale += (historicalCost * (item.qty || 1));
    });

    return actualRevenue - totalCostForThisSale;
  };

  // =========================================================================
  // UPDATED CRASH-PROOF & NO-DOUBLE-DEDUCT PROFIT CALCULATOR (Now with Price Snapshots)
  // =========================================================================
  const totalNetProfit = Math.round(filteredSales.reduce((sum, record) => sum + calculateSaleProfit(record), 0));

  const getGraphData = () => {
    const currentDate = new Date();
    const dataPoints = [];

    if (graphView === "monthly") {
      for (let i = 5; i >= 0; i--) {
        const d = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
        dataPoints.push({
          label: d.toLocaleString('en-US', { month: 'short' }),
          matchId: `${d.getFullYear()}-${d.getMonth()}`,
          revenue: 0,
          refunds: 0,
          profit: 0
        });
      }
      salesHistory.forEach(record => {
        const recDate = new Date(record.timestamp);
        const key = `${recDate.getFullYear()}-${recDate.getMonth()}`;
        const point = dataPoints.find(p => p.matchId === key);
        if (point) {
          if (record.id.startsWith("RET-")) point.refunds += Math.abs(record.grandTotal || 0);
          else {
            point.revenue += (record.grandTotal || 0);
            point.profit += calculateSaleProfit(record);
          }
        }
      });
    } else if (graphView === "weekly") {
      const msPerDay = 24 * 60 * 60 * 1000;
      for (let i = 3; i >= 0; i--) {
        dataPoints.push({
          label: i === 0 ? "This Wk" : `${i} Wk Ago`,
          daysAgoStart: (i + 1) * 7,
          daysAgoEnd: i * 7,
          revenue: 0,
          refunds: 0,
          profit: 0
        });
      }
      const endOfToday = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 23, 59, 59);
      salesHistory.forEach(record => {
        const recDate = new Date(record.timestamp);
        const daysDiff = (endOfToday.getTime() - recDate.getTime()) / msPerDay;
        dataPoints.forEach(w => {
          if (daysDiff >= w.daysAgoEnd && daysDiff < w.daysAgoStart) {
            if(record.id.startsWith("RET-")) w.refunds += Math.abs(record.grandTotal || 0);
            else {
              w.revenue += (record.grandTotal || 0);
              w.profit += calculateSaleProfit(record);
            }
          }
        });
      });
    } else {
      // Daily — this is the "daily profit scale" view: each bar is one
      // calendar day (last 7 days), so the profit trend day-over-day is
      // visible at a glance, not just lumped into a monthly/weekly total.
      for (let i = 6; i >= 0; i--) {
        const targetDay = new Date(currentDate.getTime() - (i * 24 * 60 * 60 * 1000));
        const dayString = targetDay.getDate();
        const monthString = targetDay.toLocaleString('en-US', { month: 'short' });
        dataPoints.push({
          label: i === 0 ? "Today" : `${dayString} ${monthString}`,
          matchKey: targetDay.toDateString(),
          revenue: 0,
          refunds: 0,
          profit: 0
        });
      }
      salesHistory.forEach(record => {
        const recDayString = new Date(record.timestamp).toDateString();
        const point = dataPoints.find(p => p.matchKey === recDayString);
        if (point) {
            if(record.id.startsWith("RET-")) point.refunds += Math.abs(record.grandTotal || 0);
            else {
              point.revenue += (record.grandTotal || 0);
              point.profit += calculateSaleProfit(record);
            }
        }
      });
    }

    const maxChartValue = Math.max(...dataPoints.map(p => Math.max(p.revenue, p.refunds, p.profit)), 1000);
    return { dataPoints, maxChartValue };
  };

  const { dataPoints, maxChartValue } = getGraphData();

  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(passwords.newPin)) {
      setPassMessage({ text: "PIN must be 4 to 8 digits (numbers only).", type: "error" });
      return;
    }
    if (passwords.newPin !== passwords.confirmPin) {
      setPassMessage({ text: "New PINs do not match.", type: "error" });
      return;
    }
    if (window.electronAPI && window.electronAPI.updateVaultPassword) {
      try {
        const res = await window.electronAPI.updateVaultPassword({
          oldPin: passwords.oldPin, 
          newPin: passwords.newPin
        });
        if (res.success) {
          setPassMessage({ text: "Vault PIN updated successfully!", type: "success" });
          setPasswords({ oldPin: "", newPin: "", confirmPin: "" });
        } else {
          setPassMessage({ text: res.message, type: "error" });
        }
      } catch (err) {
        setPassMessage({ text: "Database error updating PIN.", type: "error" });
      }
    }
  };

  const handleUpdateUsername = async (e) => {
    e.preventDefault();
    if (window.electronAPI && window.electronAPI.updateTerminalUsername) {
      try {
        const res = await window.electronAPI.updateTerminalUsername({ newUsername });
        if (res.success) {
          setUserMessage({ text: res.message, type: "success" });
          setNewUsername("");
        } else {
          setUserMessage({ text: res.message, type: "error" });
        }
      } catch (err) {
        setUserMessage({ text: "System error updating username.", type: "error" });
      }
    }
  };

  const [termPasswords, setTermPasswords] = useState({ oldPass: "", newPass: "", confirmPass: "" });
  const [termPassMessage, setTermPassMessage] = useState({ text: "", type: "" });

  const handleUpdateTerminalPassword = async (e) => {
    e.preventDefault();
    if (termPasswords.newPass !== termPasswords.confirmPass) {
      setTermPassMessage({ text: "New passwords do not match.", type: "error" });
      return;
    }
    if (window.electronAPI && window.electronAPI.updateTerminalPassword) {
      try {
        const res = await window.electronAPI.updateTerminalPassword({
          oldPassword: termPasswords.oldPass,
          newPassword: termPasswords.newPass
        });
        if (res.success) {
          setTermPassMessage({ text: res.message, type: "success" });
          setTermPasswords({ oldPass: "", newPass: "", confirmPass: "" });
        } else {
          setTermPassMessage({ text: res.message, type: "error" });
        }
      } catch (err) {
        setTermPassMessage({ text: "System error updating password.", type: "error" });
      }
    }
  };


  const extractItems = (jsonStr) => {
    try { return JSON.parse(jsonStr) || []; } catch (e) { return []; }
  };

  return (
    <div className={`flex-1 flex flex-col p-6 gap-6 overflow-hidden h-full w-full ${lightMode ? "bg-slate-50 text-slate-900" : "bg-slate-950 text-slate-100"}`}>
      
      <div className={`flex items-center gap-2 p-1.5 rounded-2xl w-fit shrink-0 border shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
        <button onClick={() => setVaultView("overview")} className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${vaultView === "overview" ? (lightMode ? "bg-slate-100 text-slate-800" : "bg-slate-800 text-white") : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"}`}>
          <span className="material-symbols-outlined text-sm">dashboard</span> Dashboard
        </button>
        <button onClick={() => { setVaultView("returns"); setSelectedReturnInvoice(null); }} className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${vaultView === "returns" ? (lightMode ? "bg-slate-100 text-slate-800" : "bg-slate-800 text-white") : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"}`}>
          <span className="material-symbols-outlined text-sm">assignment_return</span> Return Ledger
        </button>
        <button onClick={() => setVaultView("security")} className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${vaultView === "security" ? (lightMode ? "bg-slate-100 text-slate-800" : "bg-slate-800 text-white") : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"}`}>
          <span className="material-symbols-outlined text-sm">lock</span> Security
        </button>
        <button onClick={() => setVaultView("backup")} className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${vaultView === "backup" ? (lightMode ? "bg-slate-100 text-slate-800" : "bg-slate-800 text-white") : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"}`}>
          <span className="material-symbols-outlined text-sm">backup</span> Backup
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 flex flex-col gap-6">
        
        {vaultView === "overview" && (
          <>
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 border-b pb-4 border-slate-200/40 shrink-0">
              <div>
                <h2 className="text-lg font-black uppercase tracking-wider">Executive Ledger Board</h2>
                <p className="text-xs text-slate-400 font-medium">Real-time revenue parameters, margin indicators, and asset estimations.</p>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Timeline Scope:</span>
                <select
                  value={timeFilter}
                  onChange={(e) => setTimeFilter(e.target.value)}
                  className={`text-xs font-bold rounded-xl border py-2 px-4 focus:outline-none shadow-sm ${
                    lightMode ? "bg-white border-slate-200 text-slate-700" : "bg-slate-900 border-slate-800 text-slate-200"
                  }`}
                >
                  <option value="all">All-Time Statistics</option>
                  <option value="thisMonth">Current Month Summary</option>
                  <option value="prevMonth">Previous Month Summary</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
              <div className={`border p-4 rounded-2xl flex justify-between items-center shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
                <div className="space-y-1">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Net Profit Margin</span>
                  <div className={`text-xl font-black font-mono tracking-tight ${totalNetProfit < 0 ? "text-rose-500" : "text-emerald-500"}`}>Rs. {totalNetProfit.toLocaleString()}</div>
                </div>
                <span className={`material-symbols-outlined text-xl p-2.5 rounded-xl border ${totalNetProfit < 0 ? "text-rose-500 bg-rose-500/10 border-rose-500/20" : "text-emerald-500 bg-emerald-500/10 border-emerald-500/20"}`}>
                  {totalNetProfit < 0 ? "trending_down" : "trending_up"}
                </span>
              </div>

              <div className={`border p-4 rounded-2xl flex justify-between items-center shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
                <div className="space-y-1">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Gross Sales Turnover</span>
                  <div className="text-xl font-black text-sky-500 font-mono tracking-tight">Rs. {totalGrossSales.toLocaleString()}</div>
                </div>
                <span className="material-symbols-outlined text-xl text-sky-500 p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20">payments</span>
              </div>

              <div className={`border p-4 rounded-2xl flex justify-between items-center shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
                <div className="space-y-1">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Refunds Processed</span>
                  <div className="text-xl font-black text-rose-500 font-mono tracking-tight">Rs. {totalRefunds.toLocaleString()}</div>
                </div>
                <span className="material-symbols-outlined text-xl text-rose-500 p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20">assignment_return</span>
              </div>

              <div className={`border p-4 rounded-2xl flex justify-between items-center shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
                <div className="space-y-1">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Discounts Conceded</span>
                  <div className="text-xl font-black text-amber-500 font-mono tracking-tight">Rs. {totalDiscounts.toLocaleString()}</div>
                </div>
                <span className="material-symbols-outlined text-xl text-amber-500 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">price_check</span>
              </div>
            </div>

            <div className={`border rounded-3xl p-6 flex flex-col gap-6 shadow-sm shrink-0 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/40 border-slate-800"}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    <div className="w-2.5 h-2.5 bg-emerald-500 rounded-sm"></div> Gross Sales
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    <div className="w-2.5 h-2.5 bg-rose-500 rounded-sm"></div> Refunds
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    <div className="w-2.5 h-2.5 bg-violet-500 rounded-sm"></div> Profit
                  </div>
                </div>
                
                <div className={`flex p-1 rounded-xl border ${lightMode ? "bg-slate-50 border-slate-200/80" : "bg-slate-950 border-slate-800/80"}`}>
                  <button type="button" onClick={() => setGraphView("daily")} className={`text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg transition-all ${graphView === "daily" ? "bg-emerald-500 text-slate-950 shadow-sm" : "text-slate-400 hover:text-slate-500 dark:hover:text-slate-200"}`}>Daily</button>
                  <button type="button" onClick={() => setGraphView("weekly")} className={`text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg transition-all ${graphView === "weekly" ? "bg-emerald-500 text-slate-950 shadow-sm" : "text-slate-400 hover:text-slate-500 dark:hover:text-slate-200"}`}>Weekly</button>
                  <button type="button" onClick={() => setGraphView("monthly")} className={`text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg transition-all ${graphView === "monthly" ? "bg-emerald-500 text-slate-950 shadow-sm" : "text-slate-400 hover:text-slate-500 dark:hover:text-slate-200"}`}>Monthly</button>
                </div>
              </div>

              <div className="flex gap-4 items-stretch h-60 w-full pt-2 font-mono relative">
                <div className="flex flex-col justify-between items-end text-[10px] font-bold text-slate-400 pr-2 select-none w-14 shrink-0">
                  <span>Rs.{Math.round(maxChartValue).toLocaleString()}</span>
                  <span>Rs.{Math.round(maxChartValue * 0.66).toLocaleString()}</span>
                  <span>Rs.{Math.round(maxChartValue * 0.33).toLocaleString()}</span>
                  <span>Rs.0</span>
                </div>

                <div className="flex-1 flex items-end justify-between gap-2 h-full border-b border-l pb-1 pl-2 border-slate-200/40 relative">
                  <div className="absolute inset-0 flex flex-col justify-between pointer-events-none pr-2">
                    <div className="w-full border-t border-dashed border-slate-200/10 h-0" />
                    <div className="w-full border-t border-dashed border-slate-200/10 h-0" />
                    <div className="w-full border-t border-dashed border-slate-200/10 h-0" />
                    <div className="w-full h-0" />
                  </div>

                  {dataPoints.map((p, index) => {
                    const revHeight = Math.max(2, (p.revenue / maxChartValue) * 100);
                    const refHeight = Math.max(2, (p.refunds / maxChartValue) * 100);
                    // Profit can go negative on a bad day (heavy discounts/refunds) —
                    // the bar itself floors at 0 (there's no "negative height"),
                    // but the tooltip always shows the true signed figure.
                    const profitHeight = Math.max(2, (Math.max(0, p.profit) / maxChartValue) * 100);
                    return (
                      <div key={index} className="flex-1 flex flex-col items-center h-full justify-end group z-10 relative">
                        <div className={`opacity-0 group-hover:opacity-100 scale-95 group-hover:scale-100 transition-all duration-150 absolute -top-16 text-[10px] font-black p-2.5 rounded-xl shadow-xl font-mono whitespace-nowrap z-50 flex flex-col gap-1 pointer-events-none ${
                          lightMode ? "bg-slate-900 text-white border border-slate-950" : "bg-slate-800 text-slate-100 border border-slate-700"
                        }`}>
                          <div className="text-emerald-400 flex justify-between gap-4"><span>Sales:</span> <span>Rs. {Math.round(p.revenue).toLocaleString()}</span></div>
                          <div className="text-rose-400 flex justify-between gap-4"><span>Refunds:</span> <span>Rs. {Math.round(p.refunds).toLocaleString()}</span></div>
                          <div className={`flex justify-between gap-4 ${p.profit < 0 ? "text-rose-400" : "text-violet-400"}`}><span>Profit:</span> <span>Rs. {Math.round(p.profit).toLocaleString()}</span></div>
                        </div>

                        <div className="w-full flex items-end justify-center gap-0.5 sm:gap-1 h-full relative">
                          <div style={{ height: `${revHeight}%` }} className={`w-1/3 max-w-[18px] rounded-t-md transition-all duration-700 relative shadow-sm ${lightMode ? "bg-emerald-500 group-hover:brightness-110" : "bg-emerald-500/80 group-hover:brightness-120"}`} />
                          <div style={{ height: `${refHeight}%` }} className={`w-1/3 max-w-[18px] rounded-t-md transition-all duration-700 relative shadow-sm ${lightMode ? "bg-rose-500 group-hover:brightness-110" : "bg-rose-500/80 group-hover:brightness-120"}`} />
                          <div style={{ height: `${profitHeight}%` }} className={`w-1/3 max-w-[18px] rounded-t-md transition-all duration-700 relative shadow-sm ${p.profit < 0 ? "bg-rose-600" : lightMode ? "bg-violet-500 group-hover:brightness-110" : "bg-violet-500/80 group-hover:brightness-120"}`} />
                        </div>
                        
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 select-none text-center h-4 mt-1.5 whitespace-nowrap">
                          {p.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 shrink-0 pb-4">
              <div className={`border rounded-3xl p-5 flex flex-col gap-4 shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/40 border-slate-800"}`}>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-amber-500">storefront</span>
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Total Shelf Cost Basis</h3>
                </div>
                <div className={`p-4 rounded-xl border flex flex-col justify-center gap-1 shadow-inner ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800/60"}`}>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Wholesale Asset Capital</span>
                  <span className="text-2xl font-mono font-black text-amber-500">Rs. {totalAssetsValue.toLocaleString()}</span>
                </div>
              </div>

              <div className={`border rounded-3xl p-5 flex flex-col gap-4 shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/40 border-slate-800"}`}>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-emerald-500">currency_exchange</span>
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Total Expected Shelf Profit</h3>
                </div>
                <div className={`p-4 rounded-xl border flex flex-col justify-center gap-1 shadow-inner ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800/60"}`}>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Potential Future Margin Pool</span>
                  <span className="text-2xl font-mono font-black text-emerald-500">Rs. {totalExpectedProfit.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </>
        )}

        {vaultView === "returns" && (
          <div className="flex-1 flex gap-4 overflow-hidden h-full min-h-0">
            
            <div className={`flex-1 flex flex-col overflow-hidden border rounded-3xl shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/40 border-slate-800"}`}>
              <div className={`p-4 border-b shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-900/80 border-slate-800"}`}>
                <h2 className="text-sm font-black uppercase tracking-wider">Return Ledger & Refunds</h2>
                <p className="text-xs text-slate-400 mt-1">Audit log of all reversed transactions. Click any row to inspect.</p>
              </div>
              
              <div className="flex-1 overflow-y-auto custom-scrollbar">
                {returnInvoices.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
                    <span className="material-symbols-outlined text-4xl opacity-50">verified</span>
                    <p className="text-xs font-bold tracking-widest uppercase">No Returns Logged</p>
                  </div>
                ) : (
                  <table className="w-full text-left text-xs border-separate border-spacing-0">
                    <thead className={`sticky top-0 z-10 border-b text-[10px] font-black uppercase tracking-widest text-slate-400 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}>
                      <tr>
                        <th className="py-4 px-6 border-b border-slate-800/20">Return ID</th>
                        <th className="py-4 px-6 border-b border-slate-800/20">Original Sale Ref</th>
                        <th className="py-4 px-4 border-b border-slate-800/20">Timestamp</th>
                        <th className="py-4 px-6 border-b border-slate-800/20 text-center">Restocked</th>
                        <th className="py-4 px-6 border-b border-slate-800/20 text-right text-rose-500">Refund Issued</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${lightMode ? "divide-slate-100" : "divide-slate-800/40"}`}>
                      {returnInvoices.map(sale => {
                        const items = extractItems(sale.itemsJson);
                        const originalSaleRef = sale.id.split('-')[1]; 
                        const isSelected = selectedReturnInvoice && selectedReturnInvoice.id === sale.id;

                        return (
                          <tr 
                            key={sale.id} 
                            onClick={() => { setSelectedReturnInvoice(sale); setReturnDeleteConfirm(false); }}
                            className={`transition-colors duration-150 cursor-pointer ${
                              isSelected
                                ? lightMode ? "bg-rose-500/10 hover:bg-rose-500/15" : "bg-rose-500/20 hover:bg-rose-500/30"
                                : lightMode ? "hover:bg-rose-50" : "hover:bg-rose-950/20"
                            }`}
                          >
                            <td className="py-4 px-6 font-mono font-bold text-rose-500">{sale.id}</td>
                            <td className="py-4 px-6 font-mono font-bold text-slate-400">INV-{originalSaleRef}</td>
                            <td className="py-4 px-4 font-mono text-slate-500">
                              {new Date(sale.timestamp).toLocaleString("en-PK", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </td>
                            <td className="py-4 px-6 text-center font-bold text-slate-500">{items.reduce((sum, i) => sum + i.qty, 0)} units</td>
                            <td className="py-4 px-6 text-right font-mono font-black text-rose-500">Rs. {Math.abs(sale.grandTotal)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <section className={`w-[350px] lg:w-[400px] flex flex-col shrink-0 h-full overflow-hidden border rounded-3xl shadow-sm transition-all ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
              <div className={`p-4 border-b flex justify-between items-center shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-900/80 border-slate-800/80"}`}>
                <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-base">policy</span>
                  <span>Return Inspection</span>
                </h2>
                {selectedReturnInvoice && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setReturnDeleteConfirm(true)}
                      className="text-rose-500 hover:text-rose-600 flex items-center gap-1 text-xs font-bold transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">delete</span>
                      Delete
                    </button>
                    <button onClick={() => { setSelectedReturnInvoice(null); setReturnDeleteConfirm(false); }} className="text-slate-400 hover:text-slate-600 flex items-center text-xs font-bold transition-colors">Close</button>
                  </div>
                )}
              </div>

              <div className={`flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar min-h-0 ${lightMode ? "bg-slate-50/50" : "bg-slate-950/20"}`}>
                {!selectedReturnInvoice ? (
                  <div className={`h-full flex flex-col items-center justify-center text-slate-400 gap-2 border-2 border-dashed rounded-2xl m-1 ${lightMode ? "border-slate-200/60" : "border-slate-800/60"}`}>
                    <span className="material-symbols-outlined text-4xl mb-1 opacity-50">quick_reference_all</span>
                    <p className="text-xs font-bold tracking-wide uppercase text-center px-6 leading-relaxed">Click any return row to inspect refunded items</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="text-center border-b border-dashed pb-3 border-slate-200/20">
                      <div className="text-xs font-mono font-black text-rose-500">
                        {selectedReturnInvoice.id}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono mt-1">
                        {new Date(selectedReturnInvoice.timestamp).toLocaleString("en-PK")}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-[10px] font-black uppercase text-slate-400 tracking-wider px-1">
                        Items Restocked & Refunded:
                      </div>
                      {extractItems(selectedReturnInvoice.itemsJson).map((item) => (
                        <div
                          key={item.id}
                          className={`border rounded-xl p-3 flex justify-between items-center shadow-sm ${lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800"}`}
                        >
                          <div className="min-w-0 flex-1 pr-2">
                            <h4 className="text-xs font-black truncate text-rose-500">
                              {item.name}
                            </h4>
                            <p className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
                              <span>Batch: {item.batch}</span>
                              <span>•</span>
                              <span>Rs. {Math.round(item.price)} ({item.type?.toLowerCase() || 'unit'})</span>
                            </p>
                          </div>
                          <div className="text-right shrink-0 flex flex-col items-end">
                            <span className="font-mono text-xs font-black text-slate-500">
                              Rs. {Math.round(item.price * item.qty)}
                            </span>
                            <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded-md font-black mt-0.5 ${lightMode ? "bg-rose-100 text-rose-600" : "bg-rose-950 text-rose-400"}`}>
                              QTY: {item.qty}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {selectedReturnInvoice && (
                <div className={`border-t p-5 flex flex-col gap-3 shrink-0 ${lightMode ? "bg-slate-50 border-slate-200" : "bg-slate-950 border-slate-800"}`}>
                  {returnDeleteConfirm ? (
                    <div className="space-y-3">
                      <p className="text-xs font-bold text-rose-500 text-center leading-relaxed">
                        This will permanently delete this return record. This does not undo the refund or restock — it only removes the transcript. This can't be undone.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setReturnDeleteConfirm(false)}
                          disabled={isDeletingReturn}
                          className={`flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider border ${lightMode ? "border-slate-200 text-slate-600 hover:bg-slate-100" : "border-slate-800 text-slate-300 hover:bg-slate-800"}`}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => {
                            if (!onDeleteReturnTranscript) return;
                            setIsDeletingReturn(true);
                            onDeleteReturnTranscript(selectedReturnInvoice.id)
                              .then(() => {
                                setSelectedReturnInvoice(null);
                                setReturnDeleteConfirm(false);
                              })
                              .finally(() => setIsDeletingReturn(false));
                          }}
                          disabled={isDeletingReturn}
                          className="flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-60"
                        >
                          {isDeletingReturn ? "Deleting…" : "Confirm Delete"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-between items-center text-sm text-rose-500">
                      <span><b>TOTAL REFUND ISSUED:</b></span>
                      <span className="font-mono text-base font-black">Rs. {Math.abs(selectedReturnInvoice.grandTotal)}</span>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

        {vaultView === "security" && (
          <div className="max-w-4xl mx-auto w-full flex flex-col gap-6 mt-4 pb-8">
            <div className="mb-2">
              <h2 className="text-xl font-black uppercase tracking-wider">System Security Configuration</h2>
              <p className="text-xs text-slate-400 font-medium mt-1">Manage authentication credentials for the main counter and executive vault.</p>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

              {/* CARD 1 — Terminal ID */}
              <div className={`border rounded-3xl p-6 shadow-sm flex flex-col gap-5 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-500 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-xl">badge</span>
                  </div>
                  <div>
                    <h2 className="text-sm font-black uppercase tracking-wider">Terminal ID</h2>
                    <p className="text-xs text-slate-400 leading-relaxed mt-0.5">Change the login username for cashiers.</p>
                  </div>
                </div>
                {userMessage.text && (
                  <div className={`text-xs font-bold p-3 rounded-xl border ${userMessage.type === "error" ? "bg-rose-500/10 border-rose-500/20 text-rose-500" : "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"}`}>
                    {userMessage.text}
                  </div>
                )}
                <form onSubmit={handleUpdateUsername} className="flex gap-3 items-end">
                  <div className="flex-1 space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">New Username</label>
                    <input
                      type="text"
                      required
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      className={`w-full border rounded-xl py-3 px-4 font-mono text-sm font-black tracking-wider focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 focus:border-sky-500" : "bg-slate-950 border-slate-800 focus:border-sky-500"}`}
                    />
                  </div>
                  <button type="submit" className="bg-gradient-to-r from-sky-500 to-blue-500 text-white font-black px-5 py-3.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90 shrink-0">
                    Update
                  </button>
                </form>
              </div>

              {/* CARD 2 — Terminal Password */}
              <div className={`border rounded-3xl p-6 shadow-sm flex flex-col gap-5 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-500 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-xl">password</span>
                  </div>
                  <div>
                    <h2 className="text-sm font-black uppercase tracking-wider">Terminal Password</h2>
                    <p className="text-xs text-slate-400 leading-relaxed mt-0.5">Update the main login password.</p>
                  </div>
                </div>
                {termPassMessage.text && (
                  <div className={`text-xs font-bold p-3 rounded-xl border ${termPassMessage.type === "error" ? "bg-rose-500/10 border-rose-500/20 text-rose-500" : "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"}`}>
                    {termPassMessage.text}
                  </div>
                )}
                <form onSubmit={handleUpdateTerminalPassword} className="flex flex-col gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">Current Password</label>
                    <input
                      type="password"
                      required
                      value={termPasswords.oldPass}
                      onChange={(e) => setTermPasswords({...termPasswords, oldPass: e.target.value})}
                      className={`w-full border rounded-xl py-3 px-4 font-mono text-lg font-black tracking-widest focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 focus:border-violet-500" : "bg-slate-950 border-slate-800 focus:border-violet-500"}`}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">New Password</label>
                      <input
                        type="password"
                        required
                        value={termPasswords.newPass}
                        onChange={(e) => setTermPasswords({...termPasswords, newPass: e.target.value})}
                        className={`w-full border rounded-xl py-3 px-4 font-mono text-lg font-black tracking-widest focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 focus:border-violet-500" : "bg-slate-950 border-slate-800 focus:border-violet-500"}`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">Confirm</label>
                      <input
                        type="password"
                        required
                        value={termPasswords.confirmPass}
                        onChange={(e) => setTermPasswords({...termPasswords, confirmPass: e.target.value})}
                        className={`w-full border rounded-xl py-3 px-4 font-mono text-lg font-black tracking-widest focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 focus:border-violet-500" : "bg-slate-950 border-slate-800 focus:border-violet-500"}`}
                      />
                    </div>
                  </div>
                  <button type="submit" className="w-full bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-black py-3.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90">
                    Save Terminal Password
                  </button>
                </form>
              </div>

              {/* CARD 3 — Vault PIN */}
              <div className={`border rounded-3xl p-6 shadow-sm flex flex-col gap-5 ${lightMode ? "bg-white border-slate-200" : "bg-slate-900/60 border-slate-800"}`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-xl">lock_reset</span>
                  </div>
                  <div>
                    <h2 className="text-sm font-black uppercase tracking-wider">Vault PIN</h2>
                    <p className="text-xs text-slate-400 leading-relaxed mt-0.5">Protect access to financials, settings and audits.</p>
                  </div>
                </div>
                {passMessage.text && (
                  <div className={`text-xs font-bold p-3 rounded-xl border ${passMessage.type === "error" ? "bg-rose-500/10 border-rose-500/20 text-rose-500" : "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"}`}>
                    {passMessage.text}
                  </div>
                )}
                <form onSubmit={handleUpdatePassword} className="flex flex-col gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">Current Master PIN</label>
                    <input
                      type="password"
                      required
                      value={passwords.oldPin}
                      onChange={(e) => setPasswords({...passwords, oldPin: e.target.value})}
                      className={`w-full border rounded-xl py-3 px-4 font-mono text-lg font-black tracking-widest focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 focus:border-emerald-500" : "bg-slate-950 border-slate-800 focus:border-emerald-500"}`}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">New PIN</label>
                      <input
                        type="password"
                        required
                        value={passwords.newPin}
                        onChange={(e) => setPasswords({...passwords, newPin: e.target.value})}
                        className={`w-full border rounded-xl py-3 px-4 font-mono text-lg font-black tracking-widest focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 focus:border-emerald-500" : "bg-slate-950 border-slate-800 focus:border-emerald-500"}`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">Confirm</label>
                      <input
                        type="password"
                        required
                        value={passwords.confirmPin}
                        onChange={(e) => setPasswords({...passwords, confirmPin: e.target.value})}
                        className={`w-full border rounded-xl py-3 px-4 font-mono text-lg font-black tracking-widest focus:outline-none ${lightMode ? "bg-slate-50 border-slate-200 focus:border-emerald-500" : "bg-slate-950 border-slate-800 focus:border-emerald-500"}`}
                      />
                    </div>
                  </div>
                  <button type="submit" className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-black py-3.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90">
                    Save New Security PIN
                  </button>
                </form>
              </div>

              {/* CARD 4 — placeholder / future use or leave as info card */}
              <div className={`border rounded-3xl p-6 shadow-sm flex flex-col justify-center items-center gap-3 ${lightMode ? "bg-slate-50 border-slate-200 border-dashed" : "bg-slate-900/30 border-slate-800 border-dashed"}`}>
                <span className="material-symbols-outlined text-4xl text-slate-300">shield_lock</span>
                <p className="text-xs font-black uppercase tracking-wider text-slate-400 text-center">More Security Options</p>
                <p className="text-[11px] text-slate-400 text-center leading-relaxed">Additional authentication controls will appear here in future updates.</p>
              </div>

            </div>
          </div>
        )}

        {vaultView === "backup" && (
          <BackupPanel lightMode={lightMode} />
        )}

      </div>
    </div>
  );
}

// ─── Backup Panel Component ────────────────────────────────────────────────
function BackupPanel({ lightMode }) {
  const [lastBackupPath, setLastBackupPath] = React.useState('');
  const [status, setStatus] = React.useState({ text: '', type: '' });
  const [devEmail, setDevEmail] = React.useState('');
  const [isWorking, setIsWorking] = React.useState(false);

  const handleExport = async () => {
    setIsWorking(true);
    setStatus({ text: '', type: '' });
    try {
      const res = await window.electronAPI.exportDatabase();
      if (res.success) {
        setLastBackupPath(res.filePath);
        setStatus({ text: `Backup saved: ${res.filePath}`, type: 'success' });
      } else {
        setStatus({ text: res.message, type: 'error' });
      }
    } catch (err) {
      setStatus({ text: 'Backup failed unexpectedly.', type: 'error' });
    }
    setIsWorking(false);
  };

  const handleReveal = async () => {
    if (!lastBackupPath) return;
    await window.electronAPI.revealBackupInFolder(lastBackupPath);
  };

  const handleEmail = async () => {
    if (!lastBackupPath) {
      setStatus({ text: 'Please create a backup first before emailing.', type: 'error' });
      return;
    }
    await window.electronAPI.openEmailWithBackup({ filePath: lastBackupPath, devEmail });
    setStatus({ text: 'Email client opened. Please attach the backup file and send.', type: 'success' });
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className={`text-lg font-black uppercase tracking-wider ${lightMode ? 'text-slate-800' : 'text-slate-100'}`}>
          Database Backup
        </h2>
        <p className="text-xs text-slate-400 font-medium mt-1">
          Create a backup of all pharmacy data. Send it to your developer regularly so you always have a recovery copy.
        </p>
      </div>

      {status.text && (
        <div className={`p-3 rounded-xl border text-xs font-medium ${status.type === 'error' ? 'bg-rose-500/10 border-rose-500/20 text-rose-500' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600'}`}>
          {status.text}
        </div>
      )}

<div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
{/* CARD 1 — Save Backup */}
        <div className={`border rounded-3xl p-6 flex flex-col gap-4 shadow-sm ${lightMode ? 'bg-white border-slate-200' : 'bg-slate-900/60 border-slate-800'}`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500 shrink-0">
              <span className="material-symbols-outlined text-xl">save</span>
            </div>
            <div>
              <h3 className={`text-sm font-black uppercase tracking-wider ${lightMode ? 'text-slate-800' : 'text-slate-200'}`}>Step 1 - Save Backup</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">Creates a dated copy of the database on this computer.</p>
            </div>
          </div>
          <button
            onClick={handleExport}
            disabled={isWorking}
            className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-black py-3.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-auto"
          >
            <span className="material-symbols-outlined text-sm">download</span>
            {isWorking ? 'Saving...' : 'Save Backup to Downloads'}
          </button>
          {lastBackupPath && (
            <button
              onClick={handleReveal}
              className={`w-full border font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider flex items-center justify-center gap-2 ${lightMode ? 'border-slate-200 text-slate-600 hover:bg-slate-50' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}
            >
              <span className="material-symbols-outlined text-sm">folder_open</span>
              Show File in Folder
            </button>
          )}
        </div>

        {/* CARD 2 — Send to Developer */}
        <div className={`border rounded-3xl p-6 flex flex-col gap-4 shadow-sm ${lightMode ? 'bg-white border-slate-200' : 'bg-slate-900/60 border-slate-800'}`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-500 shrink-0">
              <span className="material-symbols-outlined text-xl">mail</span>
            </div>
            <div>
              <h3 className={`text-sm font-black uppercase tracking-wider ${lightMode ? 'text-slate-800' : 'text-slate-200'}`}>Step 2 - Send to Developer</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">Opens your email app with the backup ready to attach.</p>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Developer Email</label>
            <input
              type="email"
              placeholder="developer@email.com"
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              className={`w-full border rounded-xl py-2.5 px-3 text-xs focus:outline-none mt-1 ${lightMode ? 'bg-slate-50 border-slate-200 text-slate-900 focus:border-blue-500' : 'bg-slate-950 border-slate-800 text-slate-100 focus:border-blue-500'}`}
            />
          </div>
          <button
            onClick={handleEmail}
            disabled={!lastBackupPath}
            className="w-full bg-gradient-to-r from-blue-500 to-indigo-500 text-white font-black py-3.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-auto"
          >
            <span className="material-symbols-outlined text-sm">send</span>
            Open Email & Attach
          </button>
          <p className="text-[10px] text-slate-400 text-center">
            Complete Step 1 first. Attach the file manually before sending.
          </p>
        </div>

        {/* CARD 3 — Reminder */}
        <div className={`border rounded-3xl p-6 flex gap-4 items-start xl:col-span-2 ${lightMode ? 'bg-amber-50 border-amber-200' : 'bg-amber-500/10 border-amber-500/20'}`}>
          <span className="material-symbols-outlined text-amber-500 text-2xl shrink-0">info</span>
          <div>
            <p className={`text-sm font-black uppercase tracking-wider mb-1 ${lightMode ? 'text-amber-700' : 'text-amber-400'}`}>Daily Reminder</p>
            <p className={`text-xs leading-relaxed font-medium ${lightMode ? 'text-amber-700' : 'text-amber-400'}`}>
              Do this every evening before closing. In case of any hardware problem, the developer can restore the last backup and you will lose at most one day of data.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OwnerEarnings;