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
async function harness(dir, { dev = false, switches = [], appDir = path.resolve(__dirname, '..'), frameURL } = {}) {
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
      this.webContents.mainFrame = { url: frameURL ?? require('node:url').pathToFileURL(path.join(appDir, 'app', 'index.html')).href };
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.session = {
        setPermissionRequestHandler: handler => { permissions.request = handler; },
        setPermissionCheckHandler: handler => { permissions.check = handler; },
        setDevicePermissionHandler: handler => { permissions.device = handler; },
      };
    }
    isFocused() { return this.focused; } isDestroyed() { return false; }
    loadURL(url) { this.loadedURL = url; } show() {} focus() { this.focused = true; }
  }
  const electron = { app, BrowserWindow: Window, Menu: { setApplicationMenu() {} },
    ipcMain: { handle: (k, v) => handles.set(k, v), on: (k, v) => listeners.set(k, v) },
    powerMonitor: new EventEmitter(), safeStorage: { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'test-keyring',
      decryptStringAsync: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) } };
  vm.runInNewContext(await fs.readFile(path.resolve(__dirname, '../main.js'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './vault' ? vault : require(name),
    __dirname: appDir, process: Object.create(process, { defaultApp: { value: dev || undefined } }), Buffer, setTimeout, clearTimeout,
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
async function renderer({ runTimers = false, text = plaintext } = {}) {
  const elements = new Map(), events = new Map(), windowEvents = new Map(), saves = [];
  const classList = () => {
    const names = new Set();
    return { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name),
      toggle: (name, on = !names.has(name)) => (on ? names.add(name) : names.delete(name), on) };
  };
  const isCard = id => /^cards \.card\[data-id="\d+"\]$/.test(id);
  function element(id) {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', innerHTML: '', disabled: false, open: false,
      // Descendant lookups return stable stubs keyed by selector, e.g. element('cards .card[data-id="1"] .txt').
      // In #cards, a card exists only while the last render contains it, and '.card.sel' finds the highlighted one.
      querySelector(selector) {
        if (this.id === 'cards') {
          if (selector === '.card.sel') return [...elements.values()].find(el => isCard(el.id) && el.classList.contains('sel')) ?? null;
          const card = /^\.card\[data-id="(\d+)"\]/.exec(selector);
          if (card && !this.innerHTML.includes(`data-id="${card[1]}"`)) return null;
        }
        return element(`${this.id} ${selector}`);
      },
      style: {}, dataset: {}, listeners: new Map(), classList: classList(),
      addEventListener(type, cb) { this.listeners.set(type, cb); },
      appendChild() {}, replaceChildren() { this.textContent = ''; this.innerHTML = ''; },
      showModal() { if (this.open) throw Error('dialog already open'); this.open = true; },
      focus() { document.activeElement = this; },
      // Like HTMLDialogElement, the close event is dispatched after close() returns.
      close() { this.open = false; const cb = this.listeners.get('close'); if (cb) setImmediate(cb); },
    });
    if (id === 'cards' && !Object.getOwnPropertyDescriptor(elements.get(id), 'innerHTML').set) {
      let html = '';
      Object.defineProperty(elements.get(id), 'innerHTML', { configurable: true, enumerable: true, get: () => html, set(value) {
        html = value;
        // A render replaces every card: only the one written as class="card sel" is highlighted afterwards.
        for (const [key, card] of elements) {
          if (isCard(key)) card.classList.toggle('sel', value.includes(`class="card sel" data-id="${/data-id="(\d+)"/.exec(key)[1]}"`));
        }
      } });
    }
    return elements.get(id);
  }
  const state = { onLocked: null, resolveUnlock: null, rejectUnlock: null, saveError: null, lockCalls: 0 };
  const document = {
    getElementById: element,
    querySelector: element,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {} } }),
    addEventListener: (type, cb) => events.set(type, cb),
  };
  const window = { addEventListener: (type, cb) => windowEvents.set(type, cb), diaryCrypto: {
    status: async () => ({ setup: false, legacyLocal: false }),
    unlock: () => new Promise((resolve, reject) => { state.resolveUnlock = resolve; state.rejectUnlock = reject; }),
    save: async text => { if (state.saveError) throw state.saveError; saves.push(JSON.parse(text)); },
    activity() {}, onLocked: cb => { state.onLocked = cb; },
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
    state.resolveUnlock(text); await submit;
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
test('trusted page check survives ~ % [ ] in the install path and either URL escaping', async () => {
  const { pathToFileURL } = require('node:url');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-paths-'));
  try {
    // e.g. the portable build extracted under an 8.3 %TEMP% such as C:\Users\ADMINI~1\AppData\Local\Temp
    const appDir = path.join(dir, 'ADMINI~1', '100%', 'x[1]', 'resources', 'app');
    const page = pathToFileURL(path.join(appDir, 'app', 'index.html')).href;
    // Chromium may keep the escapes it was given or show ~ [ ] raw; both name the same file.
    const raw = page.replace(/%7E/g, '~').replace(/%5B/g, '[').replace(/%5D/g, ']');
    assert.notEqual(raw, page);
    for (const frameURL of [page, raw, `${page}?again#top`]) {
      const h = await harness(dir, { appDir, frameURL });
      assert.equal(h.win.loadedURL, page);
      assert.equal((await h.call('status')).setup, true, frameURL);
    }
    for (const frameURL of [pathToFileURL(path.join(appDir, 'app', 'other.html')).href, pathToFileURL(path.join(dir, 'index.html')).href,
      'https://example.com/app/index.html', 'file:///etc/passwd', `${page.slice(0, -'index.html'.length)}..%2Fapp%2Findex.html`, 'not a url']) {
      const h = await harness(dir, { appDir, frameURL });
      await assert.rejects(h.call('status'), /不允許/, frameURL);
    }
    const h = await harness(dir, { appDir });
    const navigate = url => { let blocked = false; h.win.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, url); return blocked; };
    assert.equal(navigate(raw), false);
    assert.equal(navigate('https://example.com/'), true);
    assert.equal(navigate(pathToFileURL(path.join(appDir, 'app', 'other.html')).href), true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('a throttled retry says how long to wait and does not lengthen the wait', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-throttle-'));
  const h = await harness(dir);
  try {
    assert.equal(await h.call('unlock', password, plaintext), plaintext);
    await h.call('lock');
    await assert.rejects(h.call('unlock', 'not the right password'), /密碼錯誤/);
    await assert.rejects(h.call('unlock', password), /請在 1 秒後再試/);
    await assert.rejects(h.call('unlock', password), /秒後再試/);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await h.call('unlock', password), plaintext);
  } finally { await h.call('lock'); await fs.rm(dir, { recursive: true, force: true }); }
});
test('lock screen keeps the unlock or save error instead of the generic locked text', async () => {
  const { element, state, unlock } = await renderer();
  const message = () => element('secureGateMessage').textContent;
  const submit = () => element('vaultForm').listeners.get('submit')({ preventDefault() {} });
  element('vaultPassword').value = 'not the right password';
  let attempt = submit();
  state.rejectUnlock(new Error("Error invoking remote method 'diary:unlock': Error: 密碼錯誤或日記檔案已損壞。"));
  await attempt; await settle();   // locking re-renders the gate after the error
  assert.equal(message(), '密碼錯誤或日記檔案已損壞。');
  element('vaultPassword').value = password;
  attempt = submit();
  assert.equal(message(), '正在安全解鎖，請稍候…');
  state.rejectUnlock(new Error("Error invoking remote method 'diary:unlock': Error: 嘗試過於頻繁，請在 1 秒後再試。"));
  await attempt; await settle();
  assert.equal(message(), '嘗試過於頻繁，請在 1 秒後再試。');

  // The countdown is only true until the wait is over; a later lock shows the normal text again.
  await new Promise(resolve => setTimeout(resolve, 1100));
  state.onLocked(); await settle();
  assert.equal(message(), '日記已鎖定，請輸入獨立日記密碼。');

  element('vaultPassword').value = 'not the right password';
  attempt = submit();
  state.rejectUnlock(new Error("Error invoking remote method 'diary:unlock': Error: 密碼錯誤或日記檔案已損壞。"));
  await attempt; await settle();
  await unlock();
  state.onLocked(); await settle();   // a successful unlock clears the old error
  assert.equal(message(), '日記已鎖定，請輸入獨立日記密碼。');
  await unlock();
  state.saveError = new Error("Error invoking remote method 'diary:save': Error: ENOSPC: no space left on device");
  element('cards').listeners.get('click')({ target: { closest: () => ({ dataset: { id: '1' } }) } });
  element('body').value = '寫到一半'; element('body').listeners.get('input')();
  await settle();
  assert.equal(message(), '無法安全開啟或儲存：ENOSPC: no space left on device');
  assert.equal(element('main').inert, true);
});
test('typing, selecting and changing mood update cards in place instead of rebuilding the list', async () => {
  const { element, saves, unlock } = await renderer();
  await unlock();
  const cards = element('cards');
  let html = cards.innerHTML, rebuilds = 0;
  Object.defineProperty(cards, 'innerHTML', { get: () => html, set: value => { rebuilds++; html = value; } });
  const input = text => { element('body').value = text; element('body').listeners.get('input')(); };
  const card = selector => element(`cards .card[data-id="1"]${selector}`);

  element('cards').listeners.get('click')({ target: { closest: () => ({ dataset: { id: '1' } }) } });
  assert.equal(rebuilds, 0); assert.equal(saves.length, 0);   // selecting neither rebuilds nor rewrites the vault
  input('私人的日記，再多寫一點');
  assert.equal(rebuilds, 0);
  assert.equal(card(' .txt').textContent, '私人的日記，再多寫一點');
  assert.equal(saves.at(-1).entries[0].body, '私人的日記，再多寫一點');
  element('moods').listeners.get('click')({ target: { closest: () => ({ dataset: { m: '5' } }) } });
  assert.equal(rebuilds, 0);
  assert.equal(card(' .face').textContent, '😄'); assert.equal(saves.at(-1).entries[0].mood, 5);
  input('x'.repeat(5000));
  assert.equal(card(' .txt').textContent.length, 400);   // the card only shows three lines
  assert.equal(saves.at(-1).entries[0].body.length, 5000);
  // Whitespace collapses as on the page, so leading blank lines do not leave the preview empty.
  input(`${'\n'.repeat(210)}早安\n\n  今天  好熱`);
  assert.equal(card(' .txt').textContent, '早安 今天 好熱');
  input(`${'a'.repeat(399)}😀`);
  assert.equal(card(' .txt').textContent, 'a'.repeat(399));   // no half of an emoji at the cut
  // With a search active an edit can change which cards match, so the list is rebuilt.
  element('search').value = 'x';
  input('x'.repeat(5001));
  assert.equal(rebuilds, 1); assert.match(html, /x{400}/); assert.doesNotMatch(html, /x{401}/);
});
test('adding shows the new card, selecting moves the highlight, deleting the selected card removes it', async () => {
  const two = JSON.stringify({ version: 1, weights: [], entries: [
    { id: 1, date: '2026-10-13T12:00:00Z', mood: 3, body: '第一篇' }, { id: 2, date: '2026-10-14T12:00:00Z', mood: 4, body: '第二篇' }] });
  const { element, events, saves, unlock } = await renderer({ runTimers: true, text: two });
  await unlock();
  const cards = element('cards');
  const shown = () => [...cards.innerHTML.matchAll(/data-id="(\d+)"/g)].map(m => m[1]);
  const highlighted = id => element(`cards .card[data-id="${id}"]`).classList.contains('sel');
  const click = id => cards.listeners.get('click')({ target: { closest: () => ({ dataset: { id: String(id) } }) } });
  assert.deepEqual(shown(), ['2', '1']);

  click(1); assert.equal(highlighted(1), true);
  click(2); assert.equal(highlighted(2), true); assert.equal(highlighted(1), false);

  // Ctrl+N adds an entry whose card is not rendered yet, so the list is rebuilt to show it.
  events.get('keydown')({ ctrlKey: true, key: 'n', preventDefault() {} });
  assert.equal(shown().length, 3);
  // Leaving the new entry blank and selecting another drops it from the list.
  click(1);
  assert.deepEqual(shown(), ['2', '1']); assert.equal(highlighted(1), true);

  const rightClick = element('cards').listeners.get('contextmenu')({ target: { closest: () => ({ dataset: { id: '1' }, classList: { add() {} } }) }, preventDefault() {} });
  element('confirmOk').onclick(); await rightClick; await settle();
  assert.deepEqual(shown(), ['2']);
  assert.deepEqual(saves.at(-1).entries.map(e => e.id), [2]);
});
