const EMOJI = ['😢', '🙁', '😐', '🙂', '😄'];
const NAMES = ['難過', '不太好', '普通', '不錯', '超開心'];
const COLORS = ['#d1c7fa', '#bfdbff', '#ffd9ba', '#bdeed9', '#ffb5c7'];
const STORE = 'diary.entries';
const WSTORE = 'diary.weights';
const $ = id => document.getElementById(id);
const MASCOT = size => `<div class="mascot ${size}"><div class="eyes"><i class="eye"></i><i class="eye"></i></div><div class="cheeks"><i class="cheek"></i><i class="cheek"></i></div><i class="mouth"></i></div>`;

let entries = [];
let selectedId = null;
let storageReady = false;
let mode = 'list';
let calMonth = new Date();
let selDay = new Date();
let setupRequired = false;
let legacyLocal = false;
let viewEpoch = 0;
let unlocking = false;
// Shown on the lock screen until the next unlock attempt; locking re-renders the gate right after an error.
let gateError = '', gateErrorUntil = Infinity;
function rememberGateError(text) {
  gateError = text;
  // A throttle message counts down; once its wait is over it no longer applies.
  const wait = /請在 (\d+) 秒後再試/.exec(text);
  gateErrorUntil = wait ? Date.now() + Number(wait[1]) * 1000 : Infinity;
}
// Card ids of the last list render; the entrance animation plays only when this changes.
let shownIds = '';
// Electron prefixes rejected invoke() errors with "Error invoking remote method '…': Error: ".
const errorText = error => String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

function readLegacyArray(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('舊日記資料格式錯誤。');
  return value;
}
let pendingConfirm = null;
function settleConfirm(ok) {
  const resolve = pendingConfirm; pendingConfirm = null;
  if ($('confirmDialog').open) $('confirmDialog').close();
  resolve?.(ok);
}
// In-page dialog: a native confirm() takes focus from the window, and losing focus locks the diary.
function confirmAction(message) {
  settleConfirm(false);
  $('confirmMessage').textContent = message;
  $('confirmDialog').showModal();
  return new Promise(resolve => { pendingConfirm = resolve; });
}
$('confirmOk').onclick = () => settleConfirm(true);
$('confirmCancel').onclick = () => settleConfirm(false);
// A modal dialog does not trap Tab; leaving its last button hands focus to the window frame, which fires 'blur' and locks.
$('confirmDialog').addEventListener('keydown', ev => {
  if (ev.key !== 'Tab') return;
  ev.preventDefault();
  const cancel = $('confirmCancel'), ok = $('confirmOk'), current = document.activeElement;
  (current === cancel ? ok : current === ok ? cancel : ev.shiftKey ? ok : cancel).focus();
});
// Esc closes the dialog without a button; a newer dialog may already be open by the time this fires.
$('confirmDialog').addEventListener('close', () => { if (!$('confirmDialog').open) settleConfirm(false); });
function clearPrivateView() {
  storageReady = false;
  viewEpoch++;
  settleConfirm(false);
  entries = []; weights = []; selectedId = null; shownIds = '';
  for (const id of ['body', 'search', 'wKg', 'wDate', 'vaultPassword', 'vaultConfirm']) $(id).value = '';
  for (const id of ['cards', 'grid', 'wList', 'wStats', 'chart', 'edDate', 'count']) $(id).replaceChildren();
  $('editor').classList.add('hidden');
  $('secureGate').classList.remove('hidden');
  $('lockDiary').classList.add('hidden');
  document.querySelector('main').inert = true;
  document.querySelector('aside').inert = true;
  document.querySelector('.detail').style.background = '';
}
function showStorageFailure(error) {
  rememberGateError(`無法安全開啟或儲存：${errorText(error) || '請稍後再試。'}`);
  clearPrivateView();
  $('secureGateMessage').textContent = gateError;
  void window.diaryCrypto.lock();
}
function save() {
  if (!storageReady) return Promise.resolve();
  // Submit every edit immediately; the main process serializes durable writes.
  return window.diaryCrypto.save(JSON.stringify({ version: 1, entries, weights }))
    .catch(showStorageFailure);
}
async function refreshGate() {
  const status = await window.diaryCrypto.status();
  setupRequired = status.setup; legacyLocal = status.legacyLocal;
  $('vaultSubmit').disabled = unlocking;
  $('confirmLabel').classList.toggle('hidden', !setupRequired);
  $('vaultSubmit').textContent = setupRequired ? '建立密碼並加密' : '解鎖';
  $('vaultPassword').autocomplete = setupRequired ? 'new-password' : 'current-password';
  $('secureGateMessage').textContent = (Date.now() < gateErrorUntil && gateError) || (setupRequired
    ? '設定至少 12 個字元的長密碼。舊日記將遷移至密碼加密。'
    : '日記已鎖定，請輸入獨立日記密碼。');
}
$('vaultForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (unlocking) return;
  let password = $('vaultPassword').value;
  if (setupRequired && ([...password].length < 12 || password !== $('vaultConfirm').value)) {
    $('secureGateMessage').textContent = '請輸入至少 12 個字元，並確認兩次密碼相同。';
    return;
  }
  const attempt = viewEpoch;
  unlocking = true; $('vaultSubmit').disabled = true; gateError = '';
  $('secureGateMessage').textContent = '正在安全解鎖，請稍候…';
  $('vaultPassword').value = ''; $('vaultConfirm').value = '';
  try {
    const legacy = legacyLocal ? JSON.stringify({ version: 1, entries: readLegacyArray(STORE), weights: readLegacyArray(WSTORE) }) : null;
    const text = await window.diaryCrypto.unlock(password, legacy);
    if (attempt !== viewEpoch) { await window.diaryCrypto.lock(); return; }
    const data = JSON.parse(text);
    entries = data.entries; weights = data.weights;
    localStorage.removeItem(STORE); localStorage.removeItem(WSTORE);
    storageReady = true;
    renderAll(); if (mode === 'weight') renderWeights();
    $('secureGate').classList.add('hidden');
    $('lockDiary').classList.remove('hidden');
    document.querySelector('main').inert = false;
    document.querySelector('aside').inert = false;
  } catch (error) {
    if (attempt === viewEpoch) {
      rememberGateError(errorText(error) || '解鎖失敗，請再試一次。');
      clearPrivateView();
      $('secureGateMessage').textContent = gateError;
      await window.diaryCrypto.lock();
    }
  } finally {
    password = null; unlocking = false; $('vaultSubmit').disabled = false;
  }
});
window.diaryCrypto.onLocked(() => {
  clearPrivateView();
  refreshGate().catch(error => { $('secureGateMessage').textContent = errorText(error); });
});
$('lockDiary').onclick = () => { clearPrivateView(); void window.diaryCrypto.lock(); };
let lastActivity = 0;
for (const type of ['pointerdown', 'click', 'keydown', 'input']) {
  document.addEventListener(type, event => {
    if (!storageReady && !event.target.closest('#secureGate')) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (storageReady && event.isTrusted && Date.now() - lastActivity > 1000) {
      lastActivity = Date.now(); window.diaryCrypto.activity();
    }
  }, true);
}
window.addEventListener('blur', () => {
  clearPrivateView(); void window.diaryCrypto.lock();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearPrivateView(); void window.diaryCrypto.lock(); }
});

const fmtShort = iso => new Date(iso).toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });
const fmtLong = iso => new Date(iso).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const isBlank = e => !e.body.trim();
const selected = () => entries.find(e => e.id === selectedId);

/* ---------- 左側列表 ---------- */
function visibleEntries() {
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  if (mode === 'calendar') return sorted.filter(e => sameDay(e.date, selDay));
  const q = $('search').value.trim().toLowerCase();
  return q ? sorted.filter(e => e.body.toLowerCase().includes(q)) : sorted;
}

// Cards show at most three lines, so long bodies need not be in the DOM. Collapse whitespace first, as the page
// would, so a body that starts with blank lines still fills its preview, and never end on half a surrogate pair.
const preview = e => isBlank(e) ? '（新的日記）' : e.body.slice(0, 4000).replace(/\s+/g, ' ').trim().slice(0, 400).replace(/[\uD800-\uDBFF]$/, '');
const cardFor = id => $('cards').querySelector(`.card[data-id="${id}"]`);
// Cards currently in view, top to bottom, with their distance from the top of the visible area. Uses layout
// offsets (#cards is their offsetParent) because the entrance animation's scale skews getBoundingClientRect.
function cardsInView(box) {
  const top = box.scrollTop, bottom = top + box.clientHeight, cards = box.children;
  let lo = 0, hi = cards.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cards[mid].offsetTop + cards[mid].offsetHeight <= top) lo = mid + 1; else hi = mid; }
  const found = [];
  for (let i = lo; i < cards.length && cards[i].offsetTop < bottom; i++) {
    if (cards[i].dataset.id) found.push({ id: cards[i].dataset.id, offset: cards[i].offsetTop - top });
  }
  return found;
}

function renderCards() {
  const list = visibleEntries();
  const ids = list.map(e => e.id).join();
  const box = $('cards');
  // New cards forget the heights content-visibility had measured, so a rebuild while scrolled would make the list
  // jump. Keep the first card that is still in view after the rebuild where it was.
  const anchors = box.scrollTop > 0 ? cardsInView(box) : [];
  box.classList.toggle('settled', ids === shownIds);
  shownIds = ids;
  box.innerHTML = list.length
    ? list.map((e, i) => `
      <div class="card ${e.id === selectedId ? 'sel' : ''}" data-id="${e.id}"
           style="box-shadow:0 5px 14px ${COLORS[e.mood - 1]}aa;animation-delay:${Math.min(i, 10) * 0.06}s">
        <div class="face" style="background:${COLORS[e.mood - 1]};animation-delay:${i * 0.4}s">${EMOJI[e.mood - 1]}</div>
        <div><div class="date">${fmtShort(e.date)}</div><div class="txt">${esc(preview(e))}</div></div>
      </div>`).join('')
    : `<div class="empty">${MASCOT(mode === 'list' ? '' : 'small')}<p>${mode === 'list' ? '還沒有日記喔<br>點右下角的筆寫下今天吧 ✎' : '這天沒有寫日記'}</p></div>`;
  for (const anchor of anchors) {
    const card = cardFor(anchor.id);
    if (card) { box.scrollTop = card.offsetTop - anchor.offset; break; }
  }
}
// Rebuilding every card took seconds per keystroke in long diaries; edits update only their own card.
function updateCard(e) {
  const card = cardFor(e.id);
  if (!card) return;
  card.style.boxShadow = `0 5px 14px ${COLORS[e.mood - 1]}aa`;
  const face = card.querySelector('.face');
  face.style.background = COLORS[e.mood - 1]; face.textContent = EMOJI[e.mood - 1];
  card.querySelector('.txt').textContent = preview(e);
}
function markSelected() {
  $('cards').querySelector('.card.sel')?.classList.remove('sel');
  if (selectedId !== null) cardFor(selectedId)?.classList.add('sel');
}

$('cards').addEventListener('click', ev => {
  const card = ev.target.closest('.card');
  if (card) select(Number(card.dataset.id));
});
$('cards').addEventListener('contextmenu', async ev => {
  const card = ev.target.closest('.card');
  if (!card || !storageReady) return;
  ev.preventDefault();
  const attempt = viewEpoch, id = Number(card.dataset.id);
  if (!await confirmAction('要刪除這篇日記嗎？') || !storageReady || attempt !== viewEpoch) return;
  card.classList.add('leaving');
  setTimeout(() => {
    if (!storageReady || attempt !== viewEpoch) return;
    entries = entries.filter(e => e.id !== id);
    save();
    if (selectedId === id) select(null);
    renderAll();
  }, 340);
});
$('search').addEventListener('input', renderCards);

/* ---------- 月曆 ---------- */
function renderCal() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('month').textContent = `${y} 年 ${m + 1} 月`;
  let h = '日一二三四五六'.split('').map(w => `<div class="w">${w}</div>`).join('');
  h += '<div></div>'.repeat(new Date(y, m, 1).getDay());
  const days = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const dt = new Date(y, m, d);
    const cls = [
      entries.some(e => !isBlank(e) && sameDay(e.date, dt)) && 'has',
      sameDay(dt, selDay) && 'sel',
      sameDay(dt, new Date()) && 'today',
    ].filter(Boolean).join(' ');
    h += `<div class="d ${cls}" data-d="${d}">${d}</div>`;
  }
  $('grid').innerHTML = h;
}
$('grid').addEventListener('click', ev => {
  const d = ev.target.dataset.d;
  if (!d) return;
  selDay = new Date(calMonth.getFullYear(), calMonth.getMonth(), Number(d));
  renderCal(); renderCards();
});
$('prev').onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCal(); };
$('next').onclick = () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCal(); };

document.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelector('.seg').classList.toggle('right', mode === 'calendar');
  document.querySelector('.seg').classList.toggle('third', mode === 'weight');
  $('cal').classList.toggle('hidden', mode !== 'calendar');
  $('search').classList.toggle('hidden', mode !== 'list');
  $('cards').classList.toggle('hidden', mode === 'weight');
  $('add').classList.toggle('hidden', mode === 'weight');
  $('weightPanel').classList.toggle('hidden', mode !== 'weight');
  if (mode === 'weight') {
    select(null);
    $('emptyDetail').classList.add('hidden');
    $('weightView').classList.remove('hidden');
    renderWeights();
  } else {
    $('weightView').classList.add('hidden');
    renderAll();
  }
});

/* ---------- 體重 ---------- */
let weights = [];
let rangeDays = 30;
const saveWeights = () => save();
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const byDate = () => [...weights].sort((a, b) => a.date.localeCompare(b.date));

$('wDate').value = dayKey(new Date());

$('wSave').onclick = () => {
  const kg = parseFloat($('wKg').value);
  if (!(kg >= 20 && kg <= 300) || !$('wDate').value) {
    $('wKg').parentElement.classList.remove('shake'); void $('wKg').offsetWidth;
    $('wKg').parentElement.classList.add('shake');
    return;
  }
  const date = $('wDate').value;
  weights = weights.filter(w => w.date !== date);   // 一天只留一筆
  weights.push({ date, kg: Math.round(kg * 10) / 10 });
  saveWeights();
  $('wKg').value = '';
  confettiAt($('wSave'));
  renderWeights();
};
$('wKg').addEventListener('keydown', ev => { if (ev.key === 'Enter') $('wSave').click(); });

$('wList').addEventListener('click', async ev => {
  const del = ev.target.closest('.del');
  if (!del || !storageReady) return;
  const attempt = viewEpoch, date = del.dataset.date;
  if (!await confirmAction('要刪除這筆體重嗎？') || !storageReady || attempt !== viewEpoch) return;
  weights = weights.filter(w => w.date !== date);
  saveWeights(); renderWeights();
});

$('wRange').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  rangeDays = Number(b.dataset.days);
  $('wRange').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  renderChart();
});

function renderWeights() {
  const sorted = byDate();
  $('wList').innerHTML = sorted.slice().reverse().map((w, i, arr) => {
    const prev = arr[i + 1];
    const d = prev ? Math.round((w.kg - prev.kg) * 10) / 10 : null;
    const diff = d === null ? '' : `<span class="diff ${d < 0 ? 'down' : d > 0 ? 'up' : 'same'}">${d > 0 ? '▲ +' : d < 0 ? '▼ ' : '－ '}${d}</span>`;
    return `<div class="w-row" style="animation-delay:${i * 0.04}s">
      <span class="date">${fmtShort(w.date + 'T12:00')}</span><b>${w.kg.toFixed(1)}</b> kg ${diff}
      <button class="del" data-date="${w.date}" title="刪除">✕</button></div>`;
  }).join('');

  const fmt = v => v.toFixed(1) + ' kg';
  const last = sorted.at(-1), first = sorted[0];
  const kgs = sorted.map(w => w.kg);
  const change = last ? Math.round((last.kg - first.kg) * 10) / 10 : 0;
  const stats = sorted.length ? [
    ['最新', fmt(last.kg)],
    ['總變化', (change > 0 ? '+' : '') + change.toFixed(1) + ' kg' + (change < 0 ? ' 🎉' : '')],
    ['最低', fmt(Math.min(...kgs))],
    ['最高', fmt(Math.max(...kgs))],
  ] : [['最新', '—'], ['總變化', '—'], ['最低', '—'], ['最高', '—']];
  $('wStats').innerHTML = stats.map(([k, v], i) => `<div class="stat" style="animation-delay:${i * 0.07}s"><small>${k}</small><div>${v}</div></div>`).join('');
  renderChart();
}

function renderChart() {
  let data = byDate();
  if (rangeDays) {
    const from = new Date(); from.setDate(from.getDate() - rangeDays + 1);
    data = data.filter(w => w.date >= dayKey(from));
  }
  const box = $('chart');
  if (data.length < 2) {
    box.innerHTML = `<div class="chart-empty">${MASCOT('small')}<p>${data.length ? '再記一筆就能畫出曲線囉！' : '還沒有體重紀錄，從左邊開始記吧 ⚖️'}</p></div>`;
    return;
  }
  const W = box.clientWidth || 600, H = box.clientHeight || 300, P = { l: 44, r: 16, t: 20, b: 28 };
  const t = data.map(w => new Date(w.date + 'T12:00').getTime());
  const kgs = data.map(w => w.kg);
  let lo = Math.min(...kgs), hi = Math.max(...kgs);
  const pad = Math.max((hi - lo) * 0.25, 0.5); lo -= pad; hi += pad;
  const x = v => P.l + (v - t[0]) / (t.at(-1) - t[0] || 1) * (W - P.l - P.r);
  const y = v => P.t + (hi - v) / (hi - lo) * (H - P.t - P.b);
  const pts = data.map((w, i) => [x(t[i]), y(w.kg)]);

  // 平滑曲線
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  const area = `${d} L${pts.at(-1)[0]},${H - P.b} L${pts[0][0]},${H - P.b} Z`;
  const ticks = [0, 1, 2, 3].map(i => lo + (hi - lo) * i / 3);

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffb5c7" stop-opacity=".55"/><stop offset="1" stop-color="#d1c7fa" stop-opacity=".05"/></linearGradient></defs>
    ${ticks.map(v => `<line class="gridline" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`).join('')}
    <text class="axis" x="${P.l}" y="${H - 6}">${fmtShort(data[0].date + 'T12:00')}</text>
    <text class="axis" x="${W - P.r}" y="${H - 6}" text-anchor="end">${fmtShort(data.at(-1).date + 'T12:00')}</text>
    <path class="area" d="${area}"/>
    <path class="line" d="${d}"/>
    ${pts.map(([px, py], i) => `<circle class="dot" cx="${px}" cy="${py}" r="6" data-i="${i}" style="animation-delay:${0.3 + i * 1 / pts.length}s"/>`).join('')}
  </svg><div class="tip" style="opacity:0"></div>`;
  const line = box.querySelector('.line');
  line.style.setProperty('--len', line.getTotalLength());

  const tip = box.querySelector('.tip');
  box.querySelectorAll('.dot').forEach(c => {
    c.onmouseenter = () => {
      const w = data[c.dataset.i];
      tip.textContent = `${fmtShort(w.date + 'T12:00')}　${w.kg.toFixed(1)} kg`;
      tip.style.left = c.getAttribute('cx') / W * 100 + '%';
      tip.style.top = c.getAttribute('cy') / H * 100 + '%';
      tip.style.opacity = 1;
    };
    c.onmouseleave = () => { tip.style.opacity = 0; };
  });
}
window.addEventListener('resize', () => { if (mode === 'weight') renderChart(); });

/* ---------- 右側編輯 ---------- */
$('moods').innerHTML = EMOJI.map((e, i) =>
  `<button class="mood" data-m="${i + 1}"><span class="e">${e}</span><small>${NAMES[i]}</small></button>`).join('');
$('moods').addEventListener('click', ev => {
  const b = ev.target.closest('.mood');
  if (b) setMood(Number(b.dataset.m));
});

function showMood(m) {
  document.querySelectorAll('.mood').forEach((b, i) => {
    b.classList.toggle('on', i === m - 1);
    b.querySelector('.e').style.background = i === m - 1 ? COLORS[i] : 'transparent';
  });
  document.querySelector('.detail').style.background = `linear-gradient(${COLORS[m - 1]}77, transparent 70%)`;
}

function setMood(m) {
  if (!storageReady) return;
  const e = selected();
  if (!e) return;
  e.mood = m;
  showMood(m);
  save(); updateCard(e);
}

function select(id) {
  if (!storageReady) return;
  const prev = selected();
  let removed = false;
  if (prev && prev.id !== id && isBlank(prev)) {
    entries = entries.filter(e => e !== prev);
    save(); removed = true;
  }
  selectedId = id;
  const e = selected();
  $('editor').classList.toggle('hidden', !e);
  $('emptyDetail').classList.toggle('hidden', !!e);
  if (e) {
    // 重新觸發滑入動畫
    $('editor').style.animation = 'none'; void $('editor').offsetWidth; $('editor').style.animation = '';
    $('edDate').textContent = fmtLong(e.date);
    $('body').value = e.body;
    $('count').textContent = `${e.body.length} 字`;
    showMood(e.mood);
    if (isBlank(e)) $('body').focus();
  } else {
    document.querySelector('.detail').style.background = '';
  }
  // Selecting only moves the highlight; rebuild the list when a card was removed or is not shown yet.
  if (removed || (e && !cardFor(e.id))) renderAll(); else markSelected();
}

$('body').addEventListener('input', () => {
  const e = selected();
  if (!storageReady || !e) return;
  const wasBlank = isBlank(e);
  e.body = $('body').value;
  e.updated = new Date().toISOString();
  $('count').textContent = `${e.body.length} 字`;
  save();
  // An edit can change which cards a search matches; otherwise only this card changes.
  if (mode === 'list' && $('search').value.trim()) renderCards(); else updateCard(e);
  if (mode === 'calendar' && wasBlank !== isBlank(e)) renderCal();
});

function addEntry() {
  if (!storageReady) return;
  const date = mode === 'calendar' ? new Date(selDay) : new Date();
  if (mode === 'calendar') date.setHours(new Date().getHours(), new Date().getMinutes());
  const e = { id: Date.now(), date: date.toISOString(), mood: 3, body: '' };
  entries.push(e);
  select(e.id);
}
$('add').onclick = addEntry;

function confetti() { confettiAt($('done'), 120); }

function confettiAt(el, dy = 0) {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2 + dy;
  const syms = ['💗', '⭐', '✨', '💖', '🌟', '🎀'];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    const a = i / 18 * Math.PI * 2, d = 140 + (i % 3) * 40;
    p.className = 'p';
    p.textContent = syms[i % syms.length];
    p.style.left = cx + 'px'; p.style.top = cy + 'px';
    p.style.setProperty('--x', Math.cos(a) * d + 'px');
    p.style.setProperty('--y', Math.sin(a) * d + 'px');
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 950);
  }
}
$('done').onclick = () => {
  const attempt = viewEpoch, id = selectedId;
  confetti();
  setTimeout(() => { if (storageReady && attempt === viewEpoch && selectedId === id) select(null); }, 800);
};

document.addEventListener('keydown', ev => {
  if (!storageReady || $('confirmDialog').open) return;
  if (ev.ctrlKey && ev.key.toLowerCase() === 'n') { ev.preventDefault(); addEntry(); }
  if (ev.ctrlKey && ev.key === 'Enter' && selected()) $('done').click();
});

/* ---------- 開始 ---------- */
function renderAll() { renderCards(); if (mode === 'calendar') renderCal(); }

for (let i = 0; i < 14; i++) {
  const b = document.createElement('div');
  const r = 30 + (i % 3) * 12;
  b.className = 'bubble';
  Object.assign(b.style, {
    width: r + 'px', height: r + 'px', left: (i * 37 % 95) + '%', background: COLORS[i % 5],
    animationDuration: (16 + i * 3) + 's', animationDelay: (-i * 4) + 's',
  });
  $('bubbles').appendChild(b);
}
refreshGate().catch(error => { $('secureGateMessage').textContent = errorText(error); });
setTimeout(() => $('splash').classList.add('out'), 1600);

