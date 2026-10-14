const { app, BrowserWindow, Menu, ipcMain, safeStorage } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');

let mainWindow = null;
const indexPath = path.join(__dirname, 'app', 'index.html');
const trustedPage = pathToFileURL(indexPath).href;
const vaultMagic = Buffer.from('DIARY-VAULT-V1\n');
const maxVaultBytes = 32 * 1024 * 1024;

function assertTrustedSender(event) {
  if (!mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted renderer requested diary storage.');
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

function getVaultPath() {
  return path.join(app.getPath('userData'), 'diary-vault.bin');
}

async function writeEncryptedVault(plaintext) {
  const encrypted = await safeStorage.encryptStringAsync(plaintext);
  const target = getVaultPath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temporary, Buffer.concat([vaultMagic, encrypted]), {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

ipcMain.handle('diary:load', async (event) => {
  assertTrustedSender(event);
  await assertSecureStorageAvailable();

  let encrypted;
  try {
    encrypted = await fs.readFile(getVaultPath());
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (encrypted.length > maxVaultBytes + vaultMagic.length + 1024) {
    throw new Error('加密日記檔案超過安全儲存限制。');
  }
  if (encrypted.length <= vaultMagic.length ||
      !encrypted.subarray(0, vaultMagic.length).equals(vaultMagic)) {
    throw new Error('加密日記檔案格式錯誤。');
  }
  const decrypted = await safeStorage.decryptStringAsync(encrypted.subarray(vaultMagic.length));
  if (!decrypted || typeof decrypted.result !== 'string') {
    throw new Error('加密日記資料無法解鎖。');
  }
  if (decrypted.shouldReEncrypt) {
    await writeEncryptedVault(decrypted.result);
  }
  return decrypted.result;
});

ipcMain.handle('diary:save', async (event, plaintext) => {
  assertTrustedSender(event);
  if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > maxVaultBytes) {
    throw new TypeError('日記資料超過安全儲存限制。');
  }
  await assertSecureStorageAvailable();
  await writeEncryptedVault(plaintext);
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
