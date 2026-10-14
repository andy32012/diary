const { app, BrowserWindow, Menu, ipcMain, safeStorage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

let mainWindow = null;
const indexPath = path.join(__dirname, 'app', 'index.html');
const trustedPage = pathToFileURL(indexPath).href;

function assertTrustedSender(event) {
  if (!mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted renderer requested diary encryption.');
  }
}

async function assertSecureStorageAvailable() {
  if (!await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error('Windows 安全儲存服務目前無法使用。');
  }
  if (process.platform === 'linux' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('目前系統沒有可用的安全金鑰儲存區。');
  }
}

ipcMain.handle('diary:encrypt', async (event, plaintext) => {
  assertTrustedSender(event);
  if (typeof plaintext !== 'string') throw new TypeError('Plaintext must be a string.');
  await assertSecureStorageAvailable();
  const encrypted = await safeStorage.encryptStringAsync(plaintext);
  return encrypted.toString('base64');
});

ipcMain.handle('diary:decrypt', async (event, encodedCiphertext) => {
  assertTrustedSender(event);
  if (typeof encodedCiphertext !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCiphertext)) {
    throw new TypeError('Ciphertext is malformed.');
  }
  await assertSecureStorageAvailable();
  const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encodedCiphertext, 'base64'));
  if (!decrypted || typeof decrypted.result !== 'string') {
    throw new Error('Encrypted diary data could not be decrypted.');
  }

  let replacementCiphertext = null;
  if (decrypted.shouldReEncrypt) {
    const replacement = await safeStorage.encryptStringAsync(decrypted.result);
    replacementCiphertext = replacement.toString('base64');
  }
  return { plaintext: decrypted.result, replacementCiphertext };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: '日記',
    backgroundColor: '#fffaf0',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== trustedPage) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(indexPath);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
