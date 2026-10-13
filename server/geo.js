import { config } from './config.js';

export const KZ_BBOX = { minLat: 40.5, maxLat: 55.5, minLng: 46.4, maxLng: 87.4 };

export function inKz(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= KZ_BBOX.minLat && lat <= KZ_BBOX.maxLat && lng >= KZ_BBOX.minLng && lng <= KZ_BBOX.maxLng;
}

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Маршрут по дорогам (OSRM). Если сервис недоступен, считаем по прямой с поправкой на изгибы дорог.
export async function route(a, b) {
  try {
    const url = `${config.geo.osrm}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500), headers: { 'User-Agent': `KUKA-TAXI/1.0 (${config.contactEmail})` } });
    if (res.ok) {
      const j = await res.json();
      const r = j.routes?.[0];
      if (r) return { km: r.distance / 1000, min: r.duration / 60, geometry: r.geometry, source: 'osrm' };
    }
  } catch { /* переходим на запасной расчёт */ }
  const km = haversineKm(a, b) * 1.35;
  return { km, min: (km / 28) * 60, geometry: null, source: 'estimate' };
}

// Поиск адресов и обратное геокодирование (OpenStreetMap Nominatim).
// Для боевой нагрузки замените на 2GIS / Яндекс Геокодер: достаточно переписать эти две функции.
let chain = Promise.resolve();
const cache = new Map();
function throttled(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => new Promise((r) => setTimeout(r, 1100)), () => new Promise((r) => setTimeout(r, 1100)));
  return run;
}
async function nominatim(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < 3600_000) return hit.v;
  const v = await throttled(async () => {
    const res = await fetch(`${config.geo.nominatim}${path}`, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': `KUKA-TAXI/1.0 (${config.contactEmail})`, 'Accept-Language': 'ru' },
    });
    if (!res.ok) throw new Error('geo ' + res.status);
    return res.json();
  });
  if (cache.size > 500) cache.clear();
  cache.set(path, { t: Date.now(), v });
  return v;
}

export async function searchAddress(q) {
  const j = await nominatim(`/search?format=jsonv2&limit=6&countrycodes=kz&addressdetails=0&q=${encodeURIComponent(q)}`);
  return j.map((x) => ({ addr: x.display_name.split(', ').slice(0, 3).join(', '), lat: Number(x.lat), lng: Number(x.lon) }))
    .filter((x) => inKz(x.lat, x.lng));
}

export async function reverse(lat, lng) {
  const j = await nominatim(`/reverse?format=jsonv2&zoom=18&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`);
  const a = j.address || {};
  const street = [a.road, a.house_number].filter(Boolean).join(', ');
  const place = a.city || a.town || a.village || a.state || '';
  return { addr: [street, place].filter(Boolean).join(', ') || (j.display_name || '').split(', ').slice(0, 3).join(', ') };
}
