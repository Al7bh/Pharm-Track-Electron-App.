const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Authentication & Security
  authenticateTerminal: (credentials) => ipcRenderer.invoke('authenticateTerminal', credentials),
  authenticateVault: (pin) => ipcRenderer.invoke('authenticateVault', pin),
  updateVaultPassword: (payload) => ipcRenderer.invoke('updateVaultPassword', payload),
  updateTerminalUsername: (data) => ipcRenderer.invoke('updateTerminalUsername', data),
  updateTerminalPassword: (data) => ipcRenderer.invoke('updateTerminalPassword', data),

  // Inventory Management
  getInventory: () => ipcRenderer.invoke('getInventory'),
  getProductByBarcode: (barcode) => ipcRenderer.invoke('getProductByBarcode', barcode),
  getProductsByBarcode: (barcode) => ipcRenderer.invoke('getProductsByBarcode', barcode),
  addInventory: (newItem) => ipcRenderer.invoke('addInventory', newItem),
  updateInventory: (updatedItem) => ipcRenderer.invoke('updateInventory', updatedItem),
  searchInventory: (query) => ipcRenderer.invoke('searchInventory', query),
  deleteInventory: (itemId) => ipcRenderer.invoke('deleteInventory', itemId),

  // Sales & History
  getSalesHistory: () => ipcRenderer.invoke('getSalesHistory'),
  processCheckout: (payload) => ipcRenderer.invoke('process-checkout', payload),
  searchSalesHistory: (query) => ipcRenderer.invoke('searchSalesHistory', query),
  returnSaleItem: (payload) => ipcRenderer.invoke('returnSaleItem', payload),

  // ─── Developer / Network Configuration ────────────────────────────────────
  // These are only accessible through the hidden 7-tap developer screen.
  getSystemConfig: () => ipcRenderer.invoke('getSystemConfig'),
  verifyDevPassword: (password) => ipcRenderer.invoke('verifyDevPassword', password),
  saveSystemConfig: (payload) => ipcRenderer.invoke('saveSystemConfig', payload),
  testServerConnection: (payload) => ipcRenderer.invoke('testServerConnection', payload),
  restartApp: () => ipcRenderer.invoke('restartApp'),

  // ─── Backup & Restore ─────────────────────────────────────────────────────
  exportDatabase: () => ipcRenderer.invoke('exportDatabase'),
  revealBackupInFolder: (filePath) => ipcRenderer.invoke('revealBackupInFolder', filePath),
  openEmailWithBackup: (payload) => ipcRenderer.invoke('openEmailWithBackup', payload),
  importDatabase: () => ipcRenderer.invoke('importDatabase'),

  // ─── Server Status (used by the nav indicator on client machines) ──────────
  checkServerStatus: () => ipcRenderer.invoke('checkServerStatus'),
});
