const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diaryCrypto', Object.freeze({
  load: () => ipcRenderer.invoke('diary:load'),
  save: plaintext => ipcRenderer.invoke('diary:save', plaintext),
}));
