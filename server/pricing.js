import { getSetting } from './db.js';

export const CLASSES = ['economy', 'comfort', 'business', 'minivan'];

// Какие тарифы может обслуживать машина данного класса.
export const SERVES = {
  economy: ['economy'],
  comfort: ['economy', 'comfort'],
  business: ['economy', 'comfort', 'business'],
  minivan: ['economy', 'minivan'],
};

export function priceFor(carClass, km, min) {
  const t = getSetting('tariffs')[carClass];
  if (!t) return null;
  const raw = Math.max(t.min, t.base + km * t.per_km + min * t.per_min);
  return Math.round(raw / 10) * 10;
}

export function allPrices(km, min) {
  const out = {};
  for (const c of CLASSES) out[c] = priceFor(c, km, min);
  return out;
}
