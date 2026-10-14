'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const vault = require('../vault');
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
  const handles = new Map(), listeners = new Map();
  const app = new EventEmitter();
  app.whenReady = () => Promise.resolve(); app.getPath = () => dir;
  app.requestSingleInstanceLock = () => true; app.quit = () => {};
  let win;
  class Window extends EventEmitter {
    constructor() {
      super(); win = this; this.focused = true;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: require('node:url').pathToFileURL(path.resolve(__dirname, '../app/index.html')).href };
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
    }
    isFocused() { return this.focused; } isDestroyed() { return false; }
    loadFile() {} show() {} focus() { this.focused = true; }
  }
  const electron = { app, BrowserWindow: Window, Menu: { setApplicationMenu() {} },
    ipcMain: { handle: (k, v) => handles.set(k, v), on: (k, v) => listeners.set(k, v) },
    powerMonitor: new EventEmitter(), safeStorage: { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'test-keyring',
      decryptStringAsync: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) } };
  vm.runInNewContext(await fs.readFile(path.resolve(__dirname, '../main.js'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './vault' ? vault : require(name),
    __dirname: path.resolve(__dirname, '..'), process, Buffer, setTimeout, clearTimeout,
  });
  await new Promise(resolve => setImmediate(resolve));
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return { win, event, handles, call: (name, ...args) => Promise.resolve().then(() => handles.get(`diary:${name}`)(event, ...args)) };
}
test('main process enforces authentication, blocks untrusted frames and serializes saves before lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-main-'));
  const h = await harness(dir);
  try {
    await assert.rejects(h.call('save', plaintext), /鎖定/);
    await assert.rejects(Promise.resolve().then(() => h.handles.get('diary:status')({ sender: {}, senderFrame: {} })), /不允許/);
    assert.equal((await h.call('status')).setup, true);
    assert.equal(await h.call('unlock', password, plaintext), plaintext);
    const updated = plaintext.replace('私人的日記', '更新後的日記');
    const save = h.call('save', updated);
    const lock = h.call('lock');
    await Promise.all([save, lock]);
    await assert.rejects(h.call('save', plaintext), /鎖定/);
    assert.equal(await h.call('unlock', password), updated);
    h.win.focused = false; h.win.emit('blur');
    await assert.rejects(h.call('save', plaintext), /鎖定/);
    await assert.rejects(h.call('unlock', password), /鎖定/);
  } finally { await h.call('lock'); await fs.rm(dir, { recursive: true, force: true }); }
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
      assert.equal(await retry.call('unlock', password, null), plaintext);
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
  resolveUnlock(plaintext); await first;
  assert.match(element('cards').innerHTML, /私人的日記/);
  element('body').value = 'private draft'; element('search').value = 'private search';
  onLocked();
  assert.equal(element('cards').innerHTML, '');
  assert.equal(element('body').value, ''); assert.equal(element('search').value, '');
  assert.equal(element('main').inert, true);
  await new Promise(resolve => setImmediate(resolve));
  element('vaultPassword').value = password;
  const pending = element('vaultForm').listeners.get('submit')({ preventDefault() {} });
  windowEvents.get('blur')(); resolveUnlock(plaintext); await pending;
  assert.equal(element('cards').innerHTML, '');
  assert.equal(element('main').inert, true);
  assert.ok(lockCalls >= 2);
});
