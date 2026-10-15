'use strict';
const { app, BrowserWindow, Menu, ipcMain, safeStorage, powerMonitor } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const vault = require('./vault');
const indexPath = path.join(__dirname, 'app', 'index.html');
const trustedPage = pathToFileURL(indexPath).href;
// Only `electron .` sets defaultApp. Unlike app.isPackaged it does not depend on the executable's name, and the
// OnlyLoadAppFromAsar fuse keeps a renamed packaged build from loading Electron's default app.
const developing = process.defaultApp === true;
let mainWindow, session, accepting = false, epoch = 0, timer, queue = Promise.resolve();
let failures = 0, retryAt = 0, quitting = false;
const enqueue = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
const file = () => path.join(app.getPath('userData'), 'diary-vault.bin');
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== trustedPage) throw Error('不允許的儲存請求。');
}
function clearKey() { session?.key.fill(0); session = null; }
function lock() {
  accepting = false; epoch++; clearTimeout(timer);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diary:locked');
  return enqueue(() => clearKey());
}
function activity() { clearTimeout(timer); if (accepting) timer = setTimeout(() => { void lock(); }, 5 * 60 * 1000); }
ipcMain.handle('diary:status', event => {
  trusted(event);
  return enqueue(async () => {
    const data = await vault.read(file());
    if (data && !data.subarray(0, vault.MAGIC.length).equals(vault.MAGIC) && !data.subarray(0, vault.LEGACY.length).equals(vault.LEGACY)) throw Error('日記格式錯誤；未覆寫原始檔案。');
    return { legacyLocal: !data, setup: !data || data.subarray(0, vault.LEGACY.length).equals(vault.LEGACY) };
  });
});
ipcMain.handle('diary:unlock', (event, password, legacyText) => {
  trusted(event);
  const requestedEpoch = epoch;
  return enqueue(async () => {
    if (requestedEpoch !== epoch || !mainWindow?.isFocused()) throw Error('視窗已鎖定，請重新解鎖。');
    if (Date.now() < retryAt) throw Error('嘗試過於頻繁，請稍後再試（最長 30 秒）。');
    if (session) throw Error('請先鎖定日記。');
    let candidate;
    try {
      const data = await vault.read(file());
      if (data?.subarray(0, vault.MAGIC.length).equals(vault.MAGIC)) {
        candidate = await vault.open(data, password);
      } else {
        let text;
        if (data) {
          if (!data.subarray(0, vault.LEGACY.length).equals(vault.LEGACY)) throw Error('舊日記格式錯誤。');
          if (!await safeStorage.isAsyncEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw Error('無法取得舊日記的系統金鑰。');
          const result = await safeStorage.decryptStringAsync(data.subarray(vault.LEGACY.length));
          text = vault.validate(result.result);
        } else {
          text = vault.validate(legacyText);
        }
        const salt = randomBytes(16);
        candidate = { salt, key: await vault.keyFrom(password, salt, true), text };
        const encrypted = vault.seal(text, candidate.key, salt);
        // Verify before replacing the only existing vault.
        const check = await vault.open(encrypted, password);
        check.key.fill(0);
        if (requestedEpoch !== epoch) throw Error('視窗已鎖定，請重新解鎖。');
        await vault.write(file(), encrypted);
      }
      if (requestedEpoch !== epoch || !mainWindow?.isFocused()) throw Error('視窗已鎖定，請重新解鎖。');
      const text = candidate.text;
      session = { key: candidate.key, salt: candidate.salt };
      candidate = null; accepting = true; failures = 0; retryAt = 0; activity();
      return text;
    } catch (error) {
      failures++; retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
      throw error;
    } finally { candidate?.key.fill(0); password = null; legacyText = null; }
  });
});
ipcMain.handle('diary:save', (event, plaintext) => {
  trusted(event);
  if (!accepting) throw Error('日記已鎖定。');
  const acceptedEpoch = epoch;
  return enqueue(async () => {
    // Saves accepted before lock finish before the queued key destruction.
    if (!session) throw Error('日記已鎖定。');
    await vault.write(file(), vault.seal(plaintext, session.key, session.salt));
    plaintext = null;
    return acceptedEpoch;
  });
});
ipcMain.handle('diary:lock', event => { trusted(event); return lock(); });
ipcMain.on('diary:activity', event => { trusted(event); activity(); });
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1100, height: 760, minWidth: 720, minHeight: 520, title: '日記', backgroundColor: '#fffaf0', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: developing, preload: path.join(__dirname, 'preload.js') } });
  // Electron grants web permissions by default; the diary needs none (camera, microphone, notifications, devices, …).
  const browserSession = mainWindow.webContents.session;
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setDevicePermissionHandler(() => false);
  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== trustedPage) event.preventDefault(); });
  mainWindow.webContents.on('did-start-loading', () => { void lock(); });
  mainWindow.webContents.on('render-process-gone', () => { void lock(); });
  mainWindow.on('blur', () => { void lock(); });
  mainWindow.on('closed', () => { mainWindow = null; void lock(); });
  mainWindow.loadFile(indexPath);
}
// Fuses disable Node's --inspect; Chromium's remote debugging would still expose the unlocked page.
if (!developing && ['remote-debugging-port', 'remote-debugging-pipe'].some(name => app.commandLine.hasSwitch(name))) { app.exit(1); }
else if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.whenReady().then(() => {
    powerMonitor.on('lock-screen', () => { void lock(); });
    powerMonitor.on('suspend', () => { void lock(); });
    createWindow();
  });
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    lock().finally(() => { quitting = true; app.quit(); });
  });
  app.on('window-all-closed', () => app.quit());
}
