// Верификация водителей.
// ВАЖНО: фотографии документов живут ТОЛЬКО в оперативной памяти процесса.
// Они не пишутся ни в базу, ни на диск, ни в логи. После решения администратора, по истечении
// срока или при перезапуске сервера они исчезают. В базе остаётся только факт решения.
import crypto from 'node:crypto';

export const REQUIRED = {
  registration: ['selfie_with_id', 'id_front', 'id_back', 'license_front', 'license_back', 'tech_passport', 'car_photo'],
  face: ['selfie_with_id'],
};

const MAX_IMG = 900 * 1024;
const MIN_IMG = 8 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const MAX_QUEUE = 300;

const requests = new Map();   // requestId -> { id, driverId, kind, images:{key:Buffer}, challenge, createdAt }
const byDriver = new Map();   // driverId -> requestId
const challenges = new Map(); // driverId -> { code, expires }

export function getChallenge(driverId) {
  const c = challenges.get(driverId);
  if (c && c.expires > Date.now()) return c.code;
  const code = String(crypto.randomInt(1000, 10000));
  challenges.set(driverId, { code, expires: Date.now() + 30 * 60 * 1000 });
  return code;
}

function decode(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < MIN_IMG || buf.length > MAX_IMG) return null;
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return null; // JPEG-сигнатура
  return buf;
}

export function submit(driverId, kind, images) {
  const keys = REQUIRED[kind];
  if (!keys || typeof images !== 'object' || !images) return { error: 'bad_request' };
  const out = {};
  let total = 0;
  for (const k of keys) {
    const buf = decode(images[k]);
    if (!buf) return { error: 'bad_image', key: k };
    total += buf.length;
    out[k] = buf;
  }
  if (total > MAX_TOTAL) return { error: 'too_large' };
  const old = byDriver.get(driverId);
  if (old) requests.delete(old);
  if (requests.size >= MAX_QUEUE) return { error: 'queue_full' };
  const id = crypto.randomUUID();
  requests.set(id, { id, driverId, kind, images: out, challenge: getChallenge(driverId), createdAt: Date.now() });
  byDriver.set(driverId, id);
  return { id };
}

export const pendingFor = (driverId) => {
  const r = requests.get(byDriver.get(driverId));
  return r ? { id: r.id, kind: r.kind, createdAt: r.createdAt } : null;
};

export const list = () => [...requests.values()]
  .sort((a, b) => a.createdAt - b.createdAt)
  .map((r) => ({ id: r.id, driverId: r.driverId, kind: r.kind, challenge: r.challenge, createdAt: r.createdAt, keys: Object.keys(r.images) }));

export const get = (id) => requests.get(id) || null;
export const image = (id, key) => requests.get(id)?.images[key] || null;

export function remove(id) {
  const r = requests.get(id);
  if (!r) return;
  for (const k of Object.keys(r.images)) r.images[k] = null; // подсказка сборщику мусора
  requests.delete(id);
  if (byDriver.get(r.driverId) === id) byDriver.delete(r.driverId);
  challenges.delete(r.driverId);
}

export function purge(ttlMs) {
  const now = Date.now();
  for (const r of [...requests.values()]) if (now - r.createdAt > ttlMs) remove(r.id);
  for (const [d, c] of challenges) if (c.expires < now) challenges.delete(d);
}
