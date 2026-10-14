'use strict';
// Shared by the renderer (<script>) and the main process (require).
// Keep the rules and constants identical to ipad/Diary.swiftpm/PasswordPolicy.swift.
(function (policy) {
  const MIN_LENGTH = 12;
  const MIN_BITS = 45;
  const ANALYZED = 64;
  const WORD_BITS = 8;
  const YEAR_BITS = 7;
  const DAY_BITS = 8.5;
  const WORDS = [
    'password', 'passwd', 'pass', 'qwerty', 'asdf', 'zxcv', 'qazwsx', 'iloveyou', 'love', 'loveyou',
    'admin', 'welcome', 'letmein', 'login', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
    'soccer', 'master', 'hello', 'freedom', 'whatever', 'trustno', 'superman', 'batman', 'starwars', 'shadow',
    'michael', 'jennifer', 'jordan', 'hunter', 'charlie', 'secret', 'diary', 'mydiary', 'test', 'guest',
    'root', 'user', 'changeme', 'default', 'google', 'apple', 'iphone', 'ipad', 'windows', 'computer',
    'internet', 'taiwan', 'japan', 'tokyo', 'sakura', 'kitty', 'angel', 'baby', 'cutie', 'honey',
    'woaini', 'wodemima', 'mima', 'nihao', 'aini', 'baobei', 'laopo', 'laogong', 'abc', 'abcd',
    '日記', '日记', '密碼', '密码', '我愛你', '我爱你', '寶貝', '宝贝', '老婆', '老公',
  ];
  const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
  const ROWS = ['1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];
  const SHIFTED = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
    '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
  const KEYS = new Map();
  ROWS.forEach((row, r) => [...row].forEach((key, c) => KEYS.set(key, [r, c])));

  const lower = c => (c >= 'A' && c <= 'Z' ? String.fromCharCode(c.charCodeAt(0) + 32) : c);
  const isUpper = c => c >= 'A' && c <= 'Z';
  const isDigit = c => c >= '0' && c <= '9';
  function charBits(c) {
    if (isDigit(c)) return Math.log2(10);
    if ((c >= 'a' && c <= 'z') || isUpper(c)) return Math.log2(26);
    if (c.codePointAt(0) >= 0x20 && c.codePointAt(0) <= 0x7e) return Math.log2(33);
    return 8;
  }
  function adjacentKeys(a, b) {
    const p = KEYS.get(SHIFTED[a] ?? lower(a)), q = KEYS.get(SHIFTED[b] ?? lower(b));
    if (!p || !q) return false;
    const dr = q[0] - p[0], dc = q[1] - p[1];
    return (dr === 0 && Math.abs(dc) === 1) || (dr === -1 && (dc === 0 || dc === 1)) || (dr === 1 && (dc === 0 || dc === -1));
  }
  // Repeats, alphabet/number sequences (9→0 wraps) and keyboard neighbours.
  function predictable(a, b) {
    const x = lower(a), y = lower(b);
    if (x === y) return true;
    if (isDigit(x) && isDigit(y) && ((x === '9' && y === '0') || (x === '0' && y === '9'))) return true;
    if (Math.abs(x.codePointAt(0) - y.codePointAt(0)) === 1) return true;
    return adjacentKeys(a, b);
  }
  const startsWith = (chars, at, word) => word.length <= chars.length - at && word.every((c, k) => chars[at + k] === c);
  const WORD_CHARS = WORDS.map(word => [...word]);

  // Cheapest way to describe the password, in bits, from common guessing patterns.
  function estimateBits(password) {
    const chars = [...String(password)].slice(0, ANALYZED);
    const n = chars.length;
    const plain = chars.map(lower);
    const leet = plain.map(c => LEET[c] ?? c);
    const best = new Array(n + 1).fill(Infinity);
    best[0] = 0;
    const relax = (j, bits) => { if (bits < best[j]) best[j] = bits; };
    for (let i = 0; i < n; i++) {
      const base = best[i];
      relax(i + 1, base + charBits(chars[i]));
      for (const word of WORD_CHARS) {
        const end = i + word.length;
        const cased = chars.slice(i, end).some(isUpper) ? 1 : 0;
        if (startsWith(plain, i, word)) relax(end, base + WORD_BITS + cased);
        else if (startsWith(leet, i, word)) relax(end, base + WORD_BITS + cased + 1);
      }
      let run = i + 1;
      while (run < n && predictable(chars[run - 1], chars[run])) run++;
      for (let end = i + 3; end <= run; end++) relax(end, base + charBits(chars[i]) + 1 + Math.log2(end - i));
      if (i + 4 <= n && chars.slice(i, i + 4).every(isDigit)) {
        const digits = chars.slice(i, i + 4).join('');
        const month = Number(digits.slice(0, 2)), day = Number(digits.slice(2));
        if (/^(19|20)/.test(digits)) relax(i + 4, base + YEAR_BITS);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) relax(i + 4, base + DAY_BITS);
      }
    }
    return best[n];
  }

  // Returns a message for a password that should not protect a new diary, or null.
  function problem(password) {
    if (typeof password !== 'string' || [...password].length < MIN_LENGTH) return '請使用至少 12 個字元的長密碼。';
    if (estimateBits(password) < MIN_BITS) {
      return '這個密碼太容易被猜到（例如連續數字、鍵盤連打、常見單字或年份）。建議用 4 個以上不相關的詞組成一句好記的話。';
    }
    return null;
  }

  policy.MIN_LENGTH = MIN_LENGTH;
  policy.MIN_BITS = MIN_BITS;
  policy.estimateBits = estimateBits;
  policy.problem = problem;
  Object.freeze(policy);
})(typeof module === 'object' && module.exports ? module.exports : (window.passwordPolicy = {}));
