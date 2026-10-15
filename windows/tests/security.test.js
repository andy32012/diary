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
async function harness(dir, { dev = false, switches = [] } = {}) {
  const handles = new Map(), listeners = new Map(), permissions = {};
  const app = new EventEmitter();
  let exitCode = null;
  app.whenReady = () => Promise.resolve(); app.getPath = () => dir;
  app.requestSingleInstanceLock = () => true; app.quit = () => {};
  // A renamed packaged executable reports isPackaged=false; the app must not rely on it.
  app.isPackaged = false; app.commandLine = { hasSwitch: name => switches.includes(name) };
  app.exit = code => { exitCode = code; };
  let win;
  class Window extends EventEmitter {
    constructor(options) {
      super(); win = this; this.focused = true; this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: require('node:url').pathToFileURL(path.resolve(__dirname, '../app/index.html')).href };
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.session = {
        setPermissionRequestHandler: handler => { permissions.request = handler; },
        setPermissionCheckHandler: handler => { permissions.check = handler; },
        setDevicePermissionHandler: handler => { permissions.device = handler; },
      };
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
    __dirname: path.resolve(__dirname, '..'), process: Object.create(process, { defaultApp: { value: dev || undefined } }), Buffer, setTimeout, clearTimeout,
  });
  await new Promise(resolve => setImmediate(resolve));
  const event = win && { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return { win, event, handles, permissions, exitCode, call: (name, ...args) => Promise.resolve().then(() => handles.get(`diary:${name}`)(event, ...args)) };
}
test('window denies every web permission; shipped builds disable DevTools and refuse remote debugging', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-hardening-'));
  try {
    const h = await harness(dir);
    const permissions = ['media', 'notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write',
      'display-capture', 'hid', 'serial', 'usb', 'fullscreen', 'openExternal', 'unknown'];
    for (const permission of permissions) {
      const answers = [];
      h.permissions.request(h.win.webContents, permission, value => answers.push(value), {});
      assert.deepEqual(answers, [false], permission);
      assert.equal(h.permissions.check(h.win.webContents, permission, 'file://', {}), false, permission);
    }
    for (const deviceType of ['hid', 'serial', 'usb']) assert.equal(h.permissions.device({ deviceType, origin: 'file://' }), false);
    const prefs = h.win.options.webPreferences;
    assert.deepEqual([prefs.contextIsolation, prefs.nodeIntegration, prefs.sandbox, prefs.devTools], [true, false, true, false]);
    assert.equal(h.exitCode, null);
    for (const name of ['remote-debugging-port', 'remote-debugging-pipe']) {
      const debug = await harness(dir, { switches: [name] });
      assert.equal(debug.exitCode, 1);
      assert.equal(debug.win, undefined);
      await assert.rejects(Promise.resolve().then(() => debug.handles.get('diary:status')({ sender: {}, senderFrame: {} })), /不允許/);
    }
    // `electron .` during development keeps DevTools and debugging switches.
    const dev = await harness(dir, { dev: true, switches: ['remote-debugging-port'] });
    assert.equal(dev.exitCode, null); assert.equal(dev.win.options.webPreferences.devTools, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('package config keeps hardening fuses and ships only app files', async () => {
  const pkg = JSON.parse(await fs.readFile(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.deepEqual(pkg.build.electronFuses, {
    runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
  });
  assert.notEqual(pkg.build.asar, false);
  assert.deepEqual(pkg.build.files, ['main.js', 'preload.js', 'vault.js', 'app/**']);
  // `npm audit fix --force` proposes electron-builder 26.5.0, which brings back the critical node-tar advisories.
  const lock = JSON.parse(await fs.readFile(path.resolve(__dirname, '../package-lock.json'), 'utf8'));
  const [major, minor] = lock.packages['node_modules/electron-builder'].version.split('.').map(Number);
  assert.ok(major > 26 || (major === 26 && minor >= 15), `electron-builder ${major}.${minor} is older than 26.15`);
});
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
async function renderer({ runTimers = false } = {}) {
  const elements = new Map(), events = new Map(), windowEvents = new Map(), saves = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, open: false,
      style: {}, dataset: {}, listeners: new Map(), classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, cb) { this.listeners.set(type, cb); },
      appendChild() {}, replaceChildren() { this.textContent = ''; this.innerHTML = ''; },
      showModal() { if (this.open) throw Error('dialog already open'); this.open = true; },
      focus() { document.activeElement = this; },
      // Like HTMLDialogElement, the close event is dispatched after close() returns.
      close() { this.open = false; const cb = this.listeners.get('close'); if (cb) setImmediate(cb); },
    });
    return elements.get(id);
  }
  const state = { onLocked: null, resolveUnlock: null, lockCalls: 0 };
  const document = {
    getElementById: element,
    querySelector: element,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {} } }),
    addEventListener: (type, cb) => events.set(type, cb),
  };
  const window = { addEventListener: (type, cb) => windowEvents.set(type, cb), diaryCrypto: {
    status: async () => ({ setup: false, legacyLocal: false }),
    unlock: () => new Promise(resolve => { state.resolveUnlock = resolve; }),
    save: async text => { saves.push(JSON.parse(text)); }, activity() {}, onLocked: cb => { state.onLocked = cb; },
    lock: async () => { state.lockCalls++; state.onLocked(); },
  } };
  vm.runInNewContext(await fs.readFile(path.resolve(__dirname, '../app/app.js'), 'utf8'), {
    document, window, localStorage: { getItem: () => null, removeItem() {} },
    setTimeout: runTimers ? (cb => { setImmediate(cb); return 0; }) : () => 0,
    confirm: () => { throw Error('native confirm() blurs the window and locks the diary'); },
  });
  await new Promise(resolve => setImmediate(resolve));
  async function unlock() {
    element('vaultPassword').value = password;
    const submit = element('vaultForm').listeners.get('submit')({ preventDefault() {} });
    state.resolveUnlock(plaintext); await submit;
  }
  return { element, document, events, windowEvents, saves, state, unlock };
}
const settle = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
test('renderer clears diary DOM on lock and ignores unlock response after backgrounding', async () => {
  const { element, windowEvents, state } = await renderer();
  const onLocked = () => state.onLocked();
  const resolveUnlock = text => state.resolveUnlock(text);
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
  assert.ok(state.lockCalls >= 2);
});
test('deleting uses the in-page dialog; cancel, Esc and locking keep the data', async () => {
  const { element, saves, state, unlock } = await renderer({ runTimers: true });
  await unlock();
  const dialog = element('confirmDialog');
  const card = { dataset: { id: '1' }, classList: { add() {} } };
  const rightClick = () => {
    let prevented = false;
    const done = element('cards').listeners.get('contextmenu')({ target: { closest: () => card }, preventDefault() { prevented = true; } });
    return { done, prevented: () => prevented };
  };

  let click = rightClick();
  assert.equal(click.prevented(), true); assert.equal(dialog.open, true);
  assert.match(element('confirmMessage').textContent, /刪除這篇日記/);
  element('confirmCancel').onclick(); await click.done; await settle();
  assert.equal(dialog.open, false); assert.equal(saves.length, 0);

  // A browser-initiated close (Esc) dispatches only the close event.
  click = rightClick(); dialog.close(); await click.done; await settle();
  assert.equal(saves.length, 0);

  // Locking while the dialog is open cancels it; the stale confirmation cannot delete later.
  click = rightClick(); state.onLocked(); await click.done; await settle();
  assert.equal(dialog.open, false); assert.equal(saves.length, 0);
  element('confirmOk').onclick(); await settle();
  assert.equal(saves.length, 0);

  await unlock();
  click = rightClick(); element('confirmOk').onclick(); await click.done; await settle();
  assert.equal(dialog.open, false);
  assert.deepEqual(saves.at(-1).entries, []);
  assert.equal(saves.at(-1).weights.length, 1);

  const del = { dataset: { date: '2026-10-14' } };
  const weightClick = () => element('wList').listeners.get('click')({ target: { closest: () => del } });
  let pending = weightClick(); assert.match(element('confirmMessage').textContent, /刪除這筆體重/);
  element('confirmCancel').onclick(); await pending; await settle();
  assert.equal(saves.at(-1).weights.length, 1);
  pending = weightClick(); element('confirmOk').onclick(); await pending; await settle();
  assert.deepEqual(saves.at(-1).weights, []);
});
test('Tab stays inside the delete dialog and shortcuts are ignored while it is open', async () => {
  const { element, document, events, unlock } = await renderer({ runTimers: true });
  await unlock();
  const dialog = element('confirmDialog'), cancel = element('confirmCancel'), ok = element('confirmOk');
  // Returns whether the handler called preventDefault().
  const press = (handler, key, modifiers = {}) => {
    let prevented = false;
    handler({ key, ...modifiers, preventDefault() { prevented = true; } });
    return prevented;
  };
  const tab = shiftKey => press(dialog.listeners.get('keydown'), 'Tab', { shiftKey });
  const pending = element('wList').listeners.get('click')({ target: { closest: () => ({ dataset: { date: '2026-10-14' } }) } });
  cancel.focus();
  // Leaving the last button would hand focus to the window frame and lock the diary.
  assert.equal(tab(false), true); assert.equal(document.activeElement, ok);
  assert.equal(tab(false), true); assert.equal(document.activeElement, cancel);
  assert.equal(tab(true), true); assert.equal(document.activeElement, ok);
  assert.equal(tab(true), true); assert.equal(document.activeElement, cancel);
  dialog.focus(); assert.equal(tab(true), true); assert.equal(document.activeElement, ok);   // after a backdrop click
  dialog.focus(); assert.equal(tab(false), true); assert.equal(document.activeElement, cancel);
  assert.equal(press(dialog.listeners.get('keydown'), 'Enter'), false);
  const shortcut = () => press(events.get('keydown'), 'n', { ctrlKey: true });
  assert.equal(shortcut(), false);
  cancel.onclick(); await pending;
  assert.equal(shortcut(), true);
});
test('a newer confirmation is not cancelled by the previous dialog close event', async () => {
  const { element, saves, unlock } = await renderer({ runTimers: true });
  await unlock();
  const del = { dataset: { date: '2026-10-14' } };
  const weightClick = () => element('wList').listeners.get('click')({ target: { closest: () => del } });
  const first = weightClick();
  element('confirmCancel').onclick();
  const second = weightClick();          // opens before the first close event is dispatched
  await first; await settle();
  assert.equal(element('confirmDialog').open, true);
  element('confirmOk').onclick(); await second; await settle();
  assert.deepEqual(saves.at(-1).weights, []);
});
