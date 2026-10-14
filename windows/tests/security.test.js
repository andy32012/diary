'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const vault = require('../vault');
const policy = require('../app/password-policy');
const password = 'correct horse battery staple 日記';
const plaintext = JSON.stringify({ version: 1, entries: [{ id: 1, date: '2026-10-14T12:00:00Z', mood: 3, body: '私人的日記' }], weights: [{ date: '2026-10-14', kg: 60 }] });

test('password vault: round trip, randomized nonce, wrong password and tampering', async () => {
  const salt = crypto.randomBytes(16);
  const key = await vault.keyFrom(password, salt, true);
  try {
    const first = vault.seal(plaintext, key, salt);
    const second = vault.seal(plaintext, key, salt);
    assert.notDeepEqual(first, second);
    assert.equal(first.includes(Buffer.from('私人的日記')), false);
    const opened = await vault.open(first, password);
    assert.equal(opened.text, plaintext); opened.key.fill(0);
    await assert.rejects(vault.open(first, 'incorrect password'));
    for (const index of [vault.MAGIC.length, vault.MAGIC.length + 16, first.length - 17, first.length - 1]) {
      const altered = Buffer.from(first); altered[index] ^= 1;
      await assert.rejects(vault.open(altered, password));
    }
    await assert.rejects(vault.open(first.subarray(0, 20), password));
    await assert.rejects(vault.keyFrom('short', salt, true));
  } finally { key.fill(0); }
});
test('validate rejects HTML-bearing IDs/dates and malformed records', () => {
  assert.equal(vault.validate(plaintext), plaintext);
  const data = JSON.parse(plaintext); data.entries[0].id = '1" onclick="attack()';
  assert.throws(() => vault.validate(JSON.stringify(data)));
  const other = JSON.parse(plaintext); other.weights[0].date = '2026-10-14"';
  assert.throws(() => vault.validate(JSON.stringify(other)));
  assert.throws(() => vault.validate('{bad'));
});
test('password policy rejects guessable passwords for new vaults but still opens existing ones', async () => {
  for (const weak of ['123456789012', 'password1234', 'iloveyou2026', 'aaaaaaaaaaaa', 'qwertyuiop12', '1qaz2wsx3edc',
    'P@ssw0rd2026!', 'abcabcabcabc', 'mydiarypassword', '20260214woaini', '839201746582', 'short']) {
    assert.ok(policy.problem(weak), weak);
  }
  for (const good of [password, 'purple monkey dishwasher', 'blue-apple-river-sky', '我最喜歡的貓咪叫做小白喔', 'Kx9#mQ2$vL7p']) {
    assert.equal(policy.problem(good), null, good);
  }
  const salt = crypto.randomBytes(16);
  await assert.rejects(vault.keyFrom('123456789012', salt, true), /太容易被猜到/);
  // Existing vaults keep opening with whatever password they were created with.
  (await vault.keyFrom('123456789012', salt)).fill(0);
});
test('atomic writes replace file without leaving temporary files; failed rename preserves original', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-test-'));
  try {
    const file = path.join(dir, 'vault');
    await vault.write(file, Buffer.from('old'));
    await vault.write(file, Buffer.from('new'));
    assert.equal((await vault.read(file)).toString(), 'new');
    assert.deepEqual(await fs.readdir(dir), ['vault']);
    assert.equal(await vault.read(path.join(dir, 'absent')), null);
    const target = path.join(dir, 'directory'); await fs.mkdir(target);
    await assert.rejects(vault.write(target, Buffer.from('cannot replace directory')));
    assert.equal((await vault.read(file)).toString(), 'new');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['directory', 'vault']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
async function harness(dir) {
  const handles = new Map(), listeners = new Map(), protocols = new Map(), privileged = [], fetched = [], cleared = [], permissions = {};
  const app = new EventEmitter();
  app.whenReady = () => Promise.resolve(); app.getPath = () => dir; app.isPackaged = true;
  app.requestSingleInstanceLock = () => true; app.quit = () => {};
  let win;
  class Window extends EventEmitter {
    constructor(options) {
      super(); win = this; this.focused = true; this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
    }
    isFocused() { return this.focused; } isDestroyed() { return false; }
    loadURL(url) { this.webContents.mainFrame.url = url; }
    setContentProtection(enabled) { this.contentProtection = enabled; }
    show() {} focus() { this.focused = true; }
  }
  const defaultSession = {
    setPermissionRequestHandler: handler => { permissions.request = handler; },
    setPermissionCheckHandler: handler => { permissions.check = handler; },
    clearStorageData: async options => { cleared.push(options); },
  };
  const electron = { app, BrowserWindow: Window, Menu: { setApplicationMenu() {} },
    ipcMain: { handle: (k, v) => handles.set(k, v), on: (k, v) => listeners.set(k, v) },
    protocol: { registerSchemesAsPrivileged: schemes => privileged.push(...schemes), handle: (scheme, handler) => protocols.set(scheme, handler) },
    session: { defaultSession }, net: { fetch: async url => { fetched.push(url); return new Response('file'); } },
    powerMonitor: new EventEmitter(), safeStorage: { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'test-keyring',
      decryptStringAsync: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) } };
  vm.runInNewContext(await fs.readFile(path.resolve(__dirname, '../main.js'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './vault' ? vault : require(name),
    __dirname: path.resolve(__dirname, '..'), process, Buffer, URL, Response, setTimeout, clearTimeout,
  });
  for (let i = 0; !win; i++) {
    if (i > 1000) throw Error('window was not created');
    await new Promise(resolve => setImmediate(resolve));
  }
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return { win, event, handles, protocols, privileged, fetched, cleared, permissions,
    call: (name, ...args) => Promise.resolve().then(() => handles.get(`diary:${name}`)(event, ...args)) };
}
test('main process enforces authentication, blocks untrusted frames and serializes saves before lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-main-'));
  const h = await harness(dir);
  try {
    await assert.rejects(h.call('save', plaintext), /鎖定/);
    await assert.rejects(Promise.resolve().then(() => h.handles.get('diary:status')({ sender: {}, senderFrame: {} })), /不允許/);
    assert.equal((await h.call('status')).setup, true);
    const opened = await h.call('unlock', password, plaintext);
    assert.equal(opened.text, plaintext); assert.equal(opened.notice, null);
    const updated = plaintext.replace('私人的日記', '更新後的日記');
    const save = h.call('save', updated);
    const lock = h.call('lock');
    await Promise.all([save, lock]);
    await assert.rejects(h.call('save', plaintext), /鎖定/);
    assert.equal((await h.call('unlock', password)).text, updated);
    h.win.focused = false; h.win.emit('blur');
    await assert.rejects(h.call('save', plaintext), /鎖定/);
    await assert.rejects(h.call('unlock', password), /鎖定/);
  } finally { await h.call('lock'); await fs.rm(dir, { recursive: true, force: true }); }
});
test('a damaged or missing vault is restored from the encrypted copy kept at the last unlock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-backup-'));
  const file = path.join(dir, 'diary-vault.bin');
  const updated = plaintext.replace('私人的日記', '最新的日記');
  try {
    const h = await harness(dir);
    await h.call('unlock', password, plaintext);
    await h.call('save', updated); await h.call('lock');
    const saved = await fs.readFile(file);
    assert.equal((await h.call('unlock', password)).notice, null);
    await h.call('lock');
    assert.deepEqual(await fs.readFile(`${file}.bak`), saved);
    const damaged = Buffer.from(saved); damaged[damaged.length - 1] ^= 1;
    await fs.writeFile(file, damaged);
    const wrong = await harness(dir);
    await assert.rejects(wrong.call('unlock', 'not the diary password'), /密碼錯誤/);
    assert.deepEqual(await fs.readFile(file), damaged);
    const restore = await harness(dir);
    const restored = await restore.call('unlock', password);
    assert.equal(restored.text, updated); assert.match(restored.notice, /備份還原/);
    assert.deepEqual(await fs.readFile(file), saved);
    assert.deepEqual(await fs.readFile(`${file}.damaged`), damaged);
    await restore.call('lock');
    await fs.rm(file);
    assert.equal((await restore.call('status')).setup, false);
    assert.match((await restore.call('unlock', password)).notice, /備份還原/);
    assert.deepEqual(await fs.readFile(file), saved);
    await restore.call('lock');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('window serves only bundled files over app://, denies permissions, blocks capture and clears migrated localStorage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-window-'));
  try {
    const first = await harness(dir);
    assert.equal(first.win.webContents.mainFrame.url, pathToFileURL(path.resolve(__dirname, '../app/index.html')).href);
    await first.call('unlock', password, plaintext);
    assert.ok(first.cleared.some(options => options.storages.includes('localstorage')));
    await first.call('lock');
    const h = await harness(dir);
    assert.equal(h.win.webContents.mainFrame.url, 'app://diary/index.html');
    assert.equal(h.cleared.length, 1);
    assert.equal(h.win.contentProtection, true);
    const prefs = h.win.options.webPreferences;
    assert.equal(prefs.spellcheck, false); assert.equal(prefs.devTools, false);
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    let granted;
    h.permissions.request(null, 'media', value => { granted = value; });
    assert.equal(granted, false);
    assert.equal(h.permissions.check(null, 'clipboard-read'), false);
    assert.deepEqual(h.privileged.map(scheme => scheme.scheme), ['app']);
    const serve = h.protocols.get('app');
    await serve({ url: 'app://diary/app.js', method: 'GET' });
    assert.deepEqual(h.fetched, [pathToFileURL(path.resolve(__dirname, '../app/app.js')).href]);
    for (const url of ['app://diary/../main.js', 'app://diary/%2e%2e/main.js', 'app://other/index.html', 'app://diary/preload.js', 'app://diary/']) {
      assert.equal((await serve({ url, method: 'GET' })).status, 404, url);
    }
    assert.equal((await serve({ url: 'app://diary/index.html', method: 'POST' })).status, 404);
    assert.equal(h.fetched.length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('an unreadable vault still opens the window without falling back to setup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-unreadable-'));
  try {
    await fs.mkdir(path.join(dir, 'diary-vault.bin'));
    const h = await harness(dir);
    assert.equal(h.win.webContents.mainFrame.url, 'app://diary/index.html');
    await assert.rejects(h.call('status'));
    await assert.rejects(h.call('unlock', password, plaintext));
    assert.ok((await fs.stat(path.join(dir, 'diary-vault.bin'))).isDirectory());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('legacy migration survives invalid password and then replaces DPAPI vault with password ciphertext', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-migrate-'));
  const file = path.join(dir, 'diary-vault.bin');
  const old = Buffer.concat([vault.LEGACY, Buffer.from(plaintext)]);
  await fs.writeFile(file, old);
  const h = await harness(dir);
  try {
    assert.equal((await h.call('status')).setup, true);
    await assert.rejects(h.call('unlock', 'short', null));
    assert.deepEqual(await fs.readFile(file), old);
    // New process represents retry after restart; no security claim depends on retry counters.
    const retry = await harness(dir);
    try {
      assert.equal((await retry.call('unlock', password, null)).text, plaintext);
      assert.equal((await retry.call('status')).setup, false);
      const read = await vault.open(await fs.readFile(file), password);
      assert.equal(read.text, plaintext); read.key.fill(0);
    } finally { await retry.call('lock'); }
  } finally { await h.call('lock'); await fs.rm(dir, { recursive: true, force: true }); }
});
test('backgrounding during expensive unlock does not restore a session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-race-'));
  const h = await harness(dir);
  try {
    const unlock = h.call('unlock', password, plaintext);
    await new Promise(resolve => setTimeout(resolve, 30));
    h.win.focused = false; h.win.emit('blur');
    await assert.rejects(unlock, /鎖定/);
    await assert.rejects(h.call('save', plaintext), /鎖定/);
  } finally { await h.call('lock'); await fs.rm(dir, { recursive: true, force: true }); }
});
test('renderer clears diary DOM on lock and ignores unlock response after backgrounding', async () => {
  const elements = new Map(), events = new Map(), windowEvents = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', disabled: false,
      style: {}, dataset: {}, listeners: new Map(), classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, cb) { this.listeners.set(type, cb); },
      appendChild() {}, replaceChildren() { this.textContent = ''; this.innerHTML = ''; },
    });
    return elements.get(id);
  }
  let onLocked, resolveUnlock, lockCalls = 0;
  const document = {
    getElementById: element,
    querySelector: element,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {} } }),
    addEventListener: (type, cb) => events.set(type, cb),
  };
  const window = { addEventListener: (type, cb) => windowEvents.set(type, cb), diaryCrypto: {
    status: async () => ({ setup: false, legacyLocal: false }),
    unlock: () => new Promise(resolve => { resolveUnlock = resolve; }),
    save: async () => {}, activity() {}, onLocked: cb => { onLocked = cb; },
    lock: async () => { lockCalls++; onLocked(); },
  } };
  vm.runInNewContext(await fs.readFile(path.resolve(__dirname, '../app/app.js'), 'utf8'), {
    document, window, localStorage: { getItem: () => null, removeItem() {} }, setTimeout: () => 0, confirm: () => false,
  });
  await new Promise(resolve => setImmediate(resolve));
  element('vaultPassword').value = password;
  const first = element('vaultForm').listeners.get('submit')({ preventDefault() {} });
  resolveUnlock({ text: plaintext, notice: '已從備份還原' }); await first;
  assert.match(element('cards').innerHTML, /私人的日記/);
  assert.equal(element('notice').textContent, '已從備份還原');
  element('body').value = 'private draft'; element('search').value = 'private search';
  onLocked();
  assert.equal(element('cards').innerHTML, '');
  assert.equal(element('body').value, ''); assert.equal(element('search').value, '');
  assert.equal(element('notice').textContent, '');
  assert.equal(element('main').inert, true);
  await new Promise(resolve => setImmediate(resolve));
  element('vaultPassword').value = password;
  const pending = element('vaultForm').listeners.get('submit')({ preventDefault() {} });
  windowEvents.get('blur')(); resolveUnlock({ text: plaintext, notice: null }); await pending;
  assert.equal(element('cards').innerHTML, '');
  assert.equal(element('main').inert, true);
  assert.ok(lockCalls >= 2);
});
