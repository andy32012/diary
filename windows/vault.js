'use strict';
const { randomBytes, scrypt, createCipheriv, createDecipheriv } = require('node:crypto');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const derive = promisify(scrypt);
const MAGIC = Buffer.from('DIARY-VAULT-V2\n');
const LEGACY = Buffer.from('DIARY-VAULT-V1\n');
const MAX = 32 * 1024 * 1024;
const AAD = Buffer.from('diary:v2:scrypt:N=131072:r=8:p=1:aes-256-gcm');
function validate(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX) throw Error('日記資料過大。');
  const v = JSON.parse(text);
  if (v?.version !== 1 || !Array.isArray(v.entries) || !Array.isArray(v.weights)) throw Error('日記格式錯誤。');
  for (const e of v.entries) {
    if (!Number.isSafeInteger(e.id) || typeof e.body !== 'string' || !Number.isInteger(e.mood) || e.mood < 1 || e.mood > 5 || typeof e.date !== 'string' || !Number.isFinite(Date.parse(e.date))) throw Error('日記記錄格式錯誤。');
  }
  for (const w of v.weights) {
    if (typeof w.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.date) || !Number.isFinite(Date.parse(w.date)) || !Number.isFinite(w.kg) || w.kg < 20 || w.kg > 300) throw Error('體重記錄格式錯誤。');
  }
  return text;
}
async function keyFrom(password, salt, creating = false) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || (creating && [...password].length < 12) || !password.length) throw Error('請使用至少 12 個字元的長密碼，最多 1024 UTF-8 位元組。');
  const bytes = Buffer.from(password, 'utf8');
  try { return await derive(bytes, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }); }
  finally { bytes.fill(0); }
}
function seal(text, key, salt) {
  validate(text);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([AAD, salt]));
  return Buffer.concat([MAGIC, salt, nonce, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
}
async function open(data, password) {
  if (data.length < MAGIC.length + 16 + 12 + 16 || data.length > MAX + 128 || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw Error('日記檔案格式錯誤。');
  const offset = MAGIC.length;
  const salt = Buffer.from(data.subarray(offset, offset + 16));
  const key = await keyFrom(password, salt);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(offset + 16, offset + 28));
    cipher.setAAD(Buffer.concat([AAD, salt]));
    cipher.setAuthTag(data.subarray(-16));
    const bytes = Buffer.concat([cipher.update(data.subarray(offset + 28, -16)), cipher.final()]);
    try { return { key, salt, text: validate(bytes.toString('utf8')) }; }
    finally { bytes.fill(0); }
  } catch { key.fill(0); throw Error('密碼錯誤或日記檔案已損壞。'); }
}
async function read(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    if ((await handle.stat()).size > MAX + 128) throw Error('日記檔案過大。');
    return await handle.readFile();
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
    // Same-directory atomic replacement: old vault survives any failure before rename.
    await fs.rename(tmp, file);
  } finally { await handle?.close(); await fs.rm(tmp, { force: true }); }
}
module.exports = { MAGIC, LEGACY, validate, keyFrom, seal, open, read, write };
