'use strict';
const { app, BrowserWindow, Menu, ipcMain, safeStorage, powerMonitor, protocol, session, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const vault = require('./vault');
const appDir = path.join(__dirname, 'app');
const indexPath = path.join(appDir, 'index.html');
const appPage = 'app://diary/index.html';
// Plaintext data from the first version lives in file:// localStorage, so only that migration still loads file://.
const legacyPage = pathToFileURL(indexPath).href;
const APP_FILES = new Set(['index.html', 'app.js', 'style.css', 'password-policy.js']);
let trustedPage = appPage;
let mainWindow, unlocked, accepting = false, epoch = 0, timer, queue = Promise.resolve();
let failures = 0, retryAt = 0, quitting = false;
const enqueue = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
const file = () => path.join(app.getPath('userData'), 'diary-vault.bin');
const backup = () => `${file()}.bak`;
const isVault = data => Boolean(data?.subarray(0, vault.MAGIC.length).equals(vault.MAGIC));
const isLegacy = data => Boolean(data?.subarray(0, vault.LEGACY.length).equals(vault.LEGACY));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
function serve(request) {
  const url = new URL(request.url);
  const name = url.pathname.slice(1);
  if (request.method !== 'GET' || url.host !== 'diary' || !APP_FILES.has(name)) return new Response(null, { status: 404 });
  return net.fetch(pathToFileURL(path.join(appDir, name)).href);
}
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== trustedPage) throw Error('不允許的儲存請求。');
}
// Removes the old plaintext localStorage once an encrypted vault holds the data.
function clearLegacyStorage() {
  return Promise.resolve().then(() => session.defaultSession.clearStorageData({ storages: ['localstorage'] })).catch(() => {});
}
function clearKey() { unlocked?.key.fill(0); unlocked = null; }
function lock() {
  accepting = false; epoch++; clearTimeout(timer);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diary:locked');
  return enqueue(() => clearKey());
}
function activity() { clearTimeout(timer); if (accepting) timer = setTimeout(() => { void lock(); }, 5 * 60 * 1000); }
// Opens the vault, or the encrypted copy kept from the last successful unlock when the vault is missing or damaged.
async function openVault(data, copy, password) {
  if (isVault(data)) {
    try {
      const opened = await vault.open(data, password);
      if (!copy?.equals(data)) await vault.write(backup(), data);
      return { opened, notice: null };
    } catch (error) {
      if (!isVault(copy) || copy.equals(data)) throw error;
    }
  }
  const opened = await vault.open(copy, password);
  try {
    // The same password opens the copy, so the vault itself is damaged. Keep it instead of deleting it.
    if (data) await fs.rename(file(), `${file()}.damaged`);
    await vault.write(file(), copy);
  } catch (error) { opened.key.fill(0); throw error; }
  return { opened, notice: '日記檔案遺失或損壞，已從上次成功解鎖時的加密備份還原；之後的修改可能沒有保留。' };
}
ipcMain.handle('diary:status', event => {
  trusted(event);
  return enqueue(async () => {
    const data = await vault.read(file());
    if (isVault(data) || (!isLegacy(data) && isVault(await vault.read(backup())))) return { legacyLocal: false, setup: false };
    if (data && !isLegacy(data)) throw Error('日記格式錯誤；未覆寫原始檔案。');
    return { legacyLocal: !data, setup: true };
  });
});
ipcMain.handle('diary:unlock', (event, password, legacyText) => {
  trusted(event);
  const requestedEpoch = epoch;
  return enqueue(async () => {
    if (requestedEpoch !== epoch || !mainWindow?.isFocused()) throw Error('視窗已鎖定，請重新解鎖。');
    if (Date.now() < retryAt) throw Error('嘗試過於頻繁，請稍後再試（最長 30 秒）。');
    if (unlocked) throw Error('請先鎖定日記。');
    let candidate, notice = null;
    try {
      const data = await vault.read(file());
      const copy = await vault.read(backup());
      if (isVault(data) || (!isLegacy(data) && isVault(copy))) {
        ({ opened: candidate, notice } = await openVault(data, copy, password));
      } else {
        let text;
        if (data) {
          if (!isLegacy(data)) throw Error('舊日記格式錯誤。');
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
        await vault.write(backup(), encrypted);
        if (!data) await clearLegacyStorage();
      }
      if (requestedEpoch !== epoch || !mainWindow?.isFocused()) throw Error('視窗已鎖定，請重新解鎖。');
      const text = candidate.text;
      unlocked = { key: candidate.key, salt: candidate.salt };
      candidate = null; accepting = true; failures = 0; retryAt = 0; activity();
      return { text, notice };
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
    if (!unlocked) throw Error('日記已鎖定。');
    await vault.write(file(), vault.seal(plaintext, unlocked.key, unlocked.salt));
    plaintext = null;
    return acceptedEpoch;
  });
});
ipcMain.handle('diary:lock', event => { trusted(event); return lock(); });
ipcMain.on('diary:activity', event => { trusted(event); activity(); });
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1100, height: 760, minWidth: 720, minHeight: 520, title: '日記', backgroundColor: '#fffaf0', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: !app.isPackaged, preload: path.join(__dirname, 'preload.js') } });
  Menu.setApplicationMenu(null);
  // Keep diary pages out of screenshots, recordings and screen sharing.
  mainWindow.setContentProtection(true);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== trustedPage) event.preventDefault(); });
  mainWindow.webContents.on('did-start-loading', () => { void lock(); });
  mainWindow.webContents.on('render-process-gone', () => { void lock(); });
  mainWindow.on('blur', () => { void lock(); });
  mainWindow.on('closed', () => { mainWindow = null; void lock(); });
  mainWindow.loadURL(trustedPage);
}
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.whenReady().then(async () => {
    protocol.handle('app', serve);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    powerMonitor.on('lock-screen', () => { void lock(); });
    powerMonitor.on('suspend', () => { void lock(); });
    try {
      const existing = await vault.read(file()) ?? await vault.read(backup());
      trustedPage = existing ? appPage : legacyPage;
      if (isVault(existing)) await clearLegacyStorage();
    } catch {
      // Unreadable files stay untouched; the status request reports the error.
      trustedPage = appPage;
    }
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
