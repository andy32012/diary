const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diaryCrypto', Object.freeze({
  encrypt: plaintext => ipcRenderer.invoke('diary:encrypt', plaintext),
  decrypt: ciphertext => ipcRenderer.invoke('diary:decrypt', ciphertext),
}));
