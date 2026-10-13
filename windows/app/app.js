const EMOJI = ['😢', '🙁', '😐', '🙂', '😄'];
const NAMES = ['難過', '不太好', '普通', '不錯', '超開心'];
const COLORS = ['#d1c7fa', '#bfdbff', '#ffd9ba', '#bdeed9', '#ffb5c7'];
const STORE = 'diary.entries';
const $ = id => document.getElementById(id);
const MASCOT = size => `<div class="mascot ${size}"><div class="eyes"><i class="eye"></i><i class="eye"></i></div><div class="cheeks"><i class="cheek"></i><i class="cheek"></i></div><i class="mouth"></i></div>`;

let entries = load();
let selectedId = null;
let mode = 'list';
let calMonth = new Date();
let selDay = new Date();

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
}
function save() {
  localStorage.setItem(STORE, JSON.stringify(entries));
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
  $('cal').classList.toggle('hidden', mode !== 'calendar');
  $('search').classList.toggle('hidden', mode !== 'list');
  renderAll();
});

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

function confetti() {
  const r = $('done').getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2 + 120;
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
renderAll();
setTimeout(() => $('splash').classList.add('out'), 1600);
