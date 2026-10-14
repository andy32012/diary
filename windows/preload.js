const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('diaryCrypto', Object.freeze({
  status: () => ipcRenderer.invoke('diary:status'),
  unlock: (password, legacyText) => ipcRenderer.invoke('diary:unlock', password, legacyText),
  save: plaintext => ipcRenderer.invoke('diary:save', plaintext),
  lock: () => ipcRenderer.invoke('diary:lock'),
  activity: () => ipcRenderer.send('diary:activity'),
  onLocked: callback => { ipcRenderer.on('diary:locked', () => callback()); },
}));
