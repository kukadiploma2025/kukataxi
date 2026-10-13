import crypto from 'node:crypto';
import { config } from './config.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s) => crypto.createHmac('sha256', config.secret).update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomCode = (digits = 6) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Простой лимитер «не больше N событий за окно» (в памяти процесса).
export function limiter(max, windowMs) {
  const hits = new Map();
  return {
    take(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        return false;
      }
      arr.push(now);
      hits.set(key, arr);
      return true;
    },
    sweep() {
      const now = Date.now();
      for (const [k, arr] of hits) {
        const f = arr.filter((t) => now - t < windowMs);
        if (f.length) hits.set(k, f); else hits.delete(k);
      }
    },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
