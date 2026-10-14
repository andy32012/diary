const EMOJI = ['😢', '🙁', '😐', '🙂', '😄'];
const NAMES = ['難過', '不太好', '普通', '不錯', '超開心'];
const COLORS = ['#d1c7fa', '#bfdbff', '#ffd9ba', '#bdeed9', '#ffb5c7'];
const STORE = 'diary.entries';
const WSTORE = 'diary.weights';
const VAULT = 'diary.encrypted.v1';
const VAULT_PREFIX = 'v1:';
const $ = id => document.getElementById(id);
const MASCOT = size => `<div class="mascot ${size}"><div class="eyes"><i class="eye"></i><i class="eye"></i></div><div class="cheeks"><i class="cheek"></i><i class="cheek"></i></div><i class="mouth"></i></div>`;

let entries = [];
let selectedId = null;
let storageReady = false;
let saveRunning = false;
let saveDirty = false;
let mode = 'list';
let calMonth = new Date();
let selDay = new Date();

function readLegacyArray(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('舊日記資料格式錯誤。');
  return value;
}

function showStorageFailure(error) {
  storageReady = false;
  $('secureGateMessage').textContent = `無法安全開啟或儲存日記：${error?.message || '加密服務無法使用。'}`;
  $('secureRetry').classList.remove('hidden');
  $('secureGate').classList.remove('hidden');
}

function save() {
  if (!storageReady) return Promise.resolve();
  saveDirty = true;
  if (saveRunning) return Promise.resolve();

  saveRunning = true;
  const flush = async () => {
    try {
      while (saveDirty && storageReady) {
        saveDirty = false;
        const snapshot = JSON.stringify({ version: 1, entries, weights });
        const encrypted = await window.diaryCrypto.encrypt(snapshot);
        if (saveDirty) continue;
        localStorage.setItem(VAULT, VAULT_PREFIX + encrypted);
      }
    } catch (error) {
      showStorageFailure(error);
    } finally {
      saveRunning = false;
      if (saveDirty && storageReady) save();
    }
  };
  return flush();
}

async function initializeSecureStore() {
  const stored = localStorage.getItem(VAULT);
  if (stored) {
    if (!stored.startsWith(VAULT_PREFIX)) throw new Error('加密資料版本不受支援。');
    const decrypted = await window.diaryCrypto.decrypt(stored.slice(VAULT_PREFIX.length));
    const vault = JSON.parse(decrypted.plaintext);
    if (vault?.version !== 1 || !Array.isArray(vault.entries) || !Array.isArray(vault.weights)) {
      throw new Error('加密日記資料格式錯誤。');
    }
    entries = vault.entries;
    weights = vault.weights;
    if (decrypted.replacementCiphertext) {
      localStorage.setItem(VAULT, VAULT_PREFIX + decrypted.replacementCiphertext);
    }
    // Remove old plaintext only after the encrypted copy has been opened successfully.
    localStorage.removeItem(STORE);
    localStorage.removeItem(WSTORE);
  } else {
    entries = readLegacyArray(STORE);
    weights = readLegacyArray(WSTORE);
    const encrypted = await window.diaryCrypto.encrypt(JSON.stringify({ version: 1, entries, weights }));
    localStorage.setItem(VAULT, VAULT_PREFIX + encrypted);
    localStorage.removeItem(STORE);
    localStorage.removeItem(WSTORE);
  }
  storageReady = true;
  renderAll();
  if (mode === 'weight') renderWeights();
  $('secureGate').classList.add('hidden');
}

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

function renderCards() {
  const list = visibleEntries();
  $('cards').innerHTML = list.length
    ? list.map((e, i) => `
      <div class="card ${e.id === selectedId ? 'sel' : ''}" data-id="${e.id}"
           style="box-shadow:0 5px 14px ${COLORS[e.mood - 1]}aa;animation-delay:${i * 0.06}s">
        <div class="face" style="background:${COLORS[e.mood - 1]};animation-delay:${i * 0.4}s">${EMOJI[e.mood - 1]}</div>
        <div><div class="date">${fmtShort(e.date)}</div><div class="txt">${isBlank(e) ? '（新的日記）' : esc(e.body)}</div></div>
      </div>`).join('')
    : `<div class="empty">${MASCOT(mode === 'list' ? '' : 'small')}<p>${mode === 'list' ? '還沒有日記喔<br>點右下角的筆寫下今天吧 ✎' : '這天沒有寫日記'}</p></div>`;
}

$('cards').addEventListener('click', ev => {
  const card = ev.target.closest('.card');
  if (card) select(Number(card.dataset.id));
});
$('cards').addEventListener('contextmenu', ev => {
  const card = ev.target.closest('.card');
  if (!card || !confirm('要刪除這篇日記嗎？')) return;
  ev.preventDefault();
  const id = Number(card.dataset.id);
  card.classList.add('leaving');
  setTimeout(() => {
    entries = entries.filter(e => e.id !== id);
    save();
    if (selectedId === id) select(null); else renderAll();
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

$('wList').addEventListener('click', ev => {
  const del = ev.target.closest('.del');
  if (!del || !confirm('要刪除這筆體重嗎？')) return;
  weights = weights.filter(w => w.date !== del.dataset.date);
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

function setMood(m) {
  const e = selected();
  if (!e) return;
  e.mood = m;
  document.querySelectorAll('.mood').forEach((b, i) => {
    b.classList.toggle('on', i === m - 1);
    b.querySelector('.e').style.background = i === m - 1 ? COLORS[i] : 'transparent';
  });
  document.querySelector('.detail').style.background = `linear-gradient(${COLORS[m - 1]}77, transparent 70%)`;
  save(); renderCards();
}

function select(id) {
  const prev = selected();
  if (prev && prev.id !== id && isBlank(prev)) {
    entries = entries.filter(e => e !== prev);
    save();
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
    setMood(e.mood);
    if (isBlank(e)) $('body').focus();
  } else {
    document.querySelector('.detail').style.background = '';
  }
  renderAll();
}

$('body').addEventListener('input', () => {
  const e = selected();
  e.body = $('body').value;
  e.updated = new Date().toISOString();
  $('count').textContent = `${e.body.length} 字`;
  save(); renderCards();
});

function addEntry() {
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
$('done').onclick = () => { confetti(); setTimeout(() => select(null), 800); };

document.addEventListener('keydown', ev => {
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
$('secureRetry').addEventListener('click', () => window.location.reload());
initializeSecureStore().catch(showStorageFailure);
setTimeout(() => $('splash').classList.add('out'), 1600);
