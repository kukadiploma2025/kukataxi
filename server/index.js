import { config, normalizePhone } from './config.js';
import { db, getSetting, setSetting, DEFAULTS, ratingFor } from './db.js';
import { App, HttpError } from './http.js';
import { hmac, sha256, randomToken, randomCode, safeEqual, limiter } from './security.js';
import { sendOtp, sendText } from './otp.js';
import { inKz, haversineKm, route, searchAddress, reverse } from './geo.js';
import { CLASSES, SERVES, priceFor, allPrices } from './pricing.js';
import * as rt from './realtime.js';
import * as ver from './verification.js';

const app = new App();
const DAY = 86400_000;
const ACTIVE = ['searching', 'accepted', 'arrived', 'in_progress'];
const now = () => Date.now();

const rl = {
  otpIp: limiter(20, 3600_000), otpPhone: limiter(5, 3600_000), verifyIp: limiter(40, 3600_000),
  quote: limiter(40, 60_000), geo: limiter(25, 60_000), rides: limiter(12, 3600_000),
  loc: limiter(1, 2000), verif: limiter(8, DAY), rate: limiter(30, 3600_000),
};
setInterval(() => Object.values(rl).forEach((l) => l.sweep()), 600_000).unref();

const bad = (code = 'bad_request', status = 400, extra) => new HttpError(status, code, extra);
const str = (v, min, max) => { if (typeof v !== 'string') return null; const s = v.trim(); return s.length >= min && s.length <= max ? s : null; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------- представления ----------
function userView(u) {
  const rp = ratingFor(u.id, 'passenger');
  return { id: u.id, name: u.name, phone: u.phone, lang: u.lang, is_admin: !!u.is_admin, rating: rp.rating, rating_count: rp.count };
}

function driverRow(userId) { return db.prepare('SELECT * FROM drivers WHERE user_id=?').get(userId) || null; }
const faceOk = (d) => d.face_valid_until > now();

function driverView(d) {
  const r = ratingFor(d.user_id, 'driver');
  const pending = ver.pendingFor(d.user_id);
  return {
    status: d.status, reject_reason: d.reject_reason, face_reject_reason: d.face_reject_reason,
    city: d.city, car_make: d.car_make, car_model: d.car_model, car_year: d.car_year, car_color: d.car_color,
    plate: d.plate, car_class: d.car_class, online: !!d.online,
    face_valid_until: d.face_valid_until, face_ok: faceOk(d),
    rating: r.rating, rating_count: r.count,
    verification_pending: pending ? { kind: pending.kind, created_at: pending.createdAt } : null,
  };
}

function rideView(r, viewerId) {
  const out = {
    id: r.id, status: r.status,
    pickup: { addr: r.pickup_addr, lat: r.pickup_lat, lng: r.pickup_lng },
    drop: { addr: r.drop_addr, lat: r.drop_lat, lng: r.drop_lng },
    distance_km: Math.round(r.distance_km * 10) / 10, duration_min: Math.round(r.duration_min),
    car_class: r.car_class, price: r.price, boost: r.boost, payment: r.payment, comment: r.comment,
    created_at: r.created_at, accepted_at: r.accepted_at, arrived_at: r.arrived_at, started_at: r.started_at, finished_at: r.finished_at,
    cancel_by: r.cancel_by, cancel_reason: r.cancel_reason,
  };
  const isPassenger = r.passenger_id === viewerId;
  const isDriver = r.driver_id === viewerId;
  if (r.driver_id && (isPassenger || viewerId === 0)) {
    const d = driverRow(r.driver_id);
    const u = db.prepare('SELECT name, phone FROM users WHERE id=?').get(r.driver_id);
    const rt_ = ratingFor(r.driver_id, 'driver');
    out.driver = { name: u.name, phone: u.phone, car: `${d.car_make} ${d.car_model}`, color: d.car_color, plate: d.plate, rating: rt_.rating, rating_count: rt_.count, lat: d.lat, lng: d.lng };
  }
  if (isDriver) {
    const u = db.prepare('SELECT name, phone FROM users WHERE id=?').get(r.passenger_id);
    const rp = ratingFor(r.passenger_id, 'passenger');
    out.passenger = { name: u.name.split(' ')[0], phone: u.phone, rating: rp.rating, rating_count: rp.count };
  }
  if (isPassenger) out.my_rating = r.rating_for_driver;
  if (isDriver) out.my_rating = r.rating_for_passenger;
  return out;
}

const getRide = (id) => db.prepare('SELECT * FROM rides WHERE id=?').get(id);
const activeRideOf = (userId, field) =>
  db.prepare(`SELECT * FROM rides WHERE ${field}=? AND status IN ('searching','accepted','arrived','in_progress') ORDER BY id DESC LIMIT 1`).get(userId);

function notifyRide(r) {
  rt.push(r.passenger_id, 'ride_update', { ride: rideView(r, r.passenger_id) });
  if (r.driver_id) rt.push(r.driver_id, 'ride_update', { ride: rideView(r, r.driver_id) });
}

// ---------- диспетчеризация ----------
const declined = new Map(); // rideId -> Set(driverId)

function eligibleDrivers(ride) {
  const radius = getSetting('offer_radius_km');
  const rows = db.prepare(`SELECT d.* FROM drivers d JOIN users u ON u.id=d.user_id
    WHERE d.status='approved' AND d.online=1 AND d.face_valid_until>? AND d.loc_at>? AND u.blocked=0 AND d.user_id!=?`)
    .all(now(), now() - 120_000, ride.passenger_id);
  return rows.filter((d) =>
    SERVES[d.car_class]?.includes(ride.car_class)
    && !declined.get(ride.id)?.has(d.user_id)
    && !activeRideOf(d.user_id, 'driver_id')
    && haversineKm({ lat: d.lat, lng: d.lng }, { lat: ride.pickup_lat, lng: ride.pickup_lng }) <= radius);
}

function offerView(r, d) {
  return {
    id: r.id, pickup: { addr: r.pickup_addr, lat: r.pickup_lat, lng: r.pickup_lng },
    drop: { addr: r.drop_addr }, distance_km: Math.round(r.distance_km * 10) / 10, duration_min: Math.round(r.duration_min),
    price: r.price, boost: r.boost, car_class: r.car_class, comment: r.comment, created_at: r.created_at,
    to_pickup_km: d?.lat != null ? Math.round(haversineKm({ lat: d.lat, lng: d.lng }, { lat: r.pickup_lat, lng: r.pickup_lng }) * 10) / 10 : null,
  };
}

function dispatch(ride) {
  for (const d of eligibleDrivers(ride)) rt.push(d.user_id, 'offer', { offer: offerView(ride, d) });
}

function withdrawOffer(rideId) {
  const rows = db.prepare(`SELECT user_id FROM drivers WHERE online=1`).all();
  rt.pushMany(rows.map((x) => x.user_id), 'offer_gone', { id: rideId });
}

// ---------- авторизация по коду из WhatsApp ----------
app.get('/api/config', () => ({
  face_check_hours: getSetting('face_check_hours'),
  commission_percent: getSetting('commission_percent'),
  tariffs: getSetting('tariffs'),
  support_phone: config.supportPhone,
}));

app.post('/api/auth/request', async ({ body, ip }) => {
  const phone = normalizePhone(body.phone);
  if (!phone) throw bad('bad_phone');
  const lang = body.lang === 'kk' ? 'kk' : 'ru';
  if (!rl.otpIp.take(ip) || !rl.otpPhone.take(phone)) throw bad('too_many_requests', 429);
  const prev = db.prepare('SELECT sent_at FROM otp WHERE phone=?').get(phone);
  if (prev && now() - prev.sent_at < config.otp.cooldownMs) {
    throw bad('cooldown', 429, { retry_after: Math.ceil((config.otp.cooldownMs - (now() - prev.sent_at)) / 1000) });
  }
  const code = randomCode(6);
  db.prepare(`INSERT INTO otp(phone,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,?,?)
    ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at`)
    .run(phone, hmac(phone + ':' + code), now() + config.otp.ttlMs, 0, now());
  try {
    await sendOtp(phone, code, lang);
  } catch (e) {
    db.prepare('DELETE FROM otp WHERE phone=?').run(phone);
    console.error('OTP send failed:', e.message);
    throw bad('send_failed', 502);
  }
  const known = !!db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone);
  return { ok: true, retry_after: config.otp.cooldownMs / 1000, new_user: !known, ...(config.otp.exposeDevCode ? { dev_code: code } : {}) };
});

app.post('/api/auth/verify', ({ body, ip, res }) => {
  if (!rl.verifyIp.take(ip)) throw bad('too_many_requests', 429);
  const phone = normalizePhone(body.phone);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!phone || !/^\d{6}$/.test(code)) throw bad('bad_request');
  const row = db.prepare('SELECT * FROM otp WHERE phone=?').get(phone);
  if (!row || row.expires_at < now()) throw bad('code_expired', 400);
  if (row.attempts >= config.otp.maxAttempts) { db.prepare('DELETE FROM otp WHERE phone=?').run(phone); throw bad('too_many_attempts', 429); }
  if (!safeEqual(hmac(phone + ':' + code), row.code_hash)) {
    db.prepare('UPDATE otp SET attempts=attempts+1 WHERE phone=?').run(phone);
    throw bad('wrong_code', 400);
  }
  let user = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  if (!user) {
    const name = str(body.name, 2, 40);
    if (!name) throw bad('name_required', 400);
    const lang = body.lang === 'kk' ? 'kk' : 'ru';
    const r = db.prepare('INSERT INTO users(phone,name,lang,created_at) VALUES(?,?,?,?)').run(phone, name, lang, now());
    user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  }
  if (user.blocked) throw bad('blocked', 403);
  db.prepare('DELETE FROM otp WHERE phone=?').run(phone);
  const isAdmin = config.adminPhones.includes(phone) ? 1 : 0;
  if (user.is_admin !== isAdmin) { db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(isAdmin, user.id); user.is_admin = isAdmin; }
  const token = randomToken();
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(sha256(token), user.id, now(), now() + 30 * DAY);
  res.setHeader('Set-Cookie', `kuka_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${config.isProd ? '; Secure' : ''}`);
  return { ok: true, user: userView(user) };
});

app.post('/api/auth/logout', { auth: 'user' }, ({ req, res }) => {
  const m = /kuka_session=([^;]+)/.exec(req.headers.cookie || '');
  if (m) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(m[1]));
  res.setHeader('Set-Cookie', 'kuka_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
});

// ---------- кабинет ----------
app.get('/api/me', { auth: 'user' }, ({ user }) => {
  const d = driverRow(user.id);
  const a = activeRideOf(user.id, 'passenger_id');
  const ad = d ? activeRideOf(user.id, 'driver_id') : null;
  return {
    user: userView(user),
    driver: d ? driverView(d) : null,
    active_ride: a ? rideView(a, user.id) : null,
    active_drive: ad ? rideView(ad, user.id) : null,
  };
});

app.patch('/api/me', { auth: 'user' }, ({ user, body }) => {
  const name = body.name === undefined ? user.name : str(body.name, 2, 40);
  const lang = body.lang === undefined ? user.lang : (['ru', 'kk'].includes(body.lang) ? body.lang : null);
  if (!name || !lang) throw bad('bad_request');
  db.prepare('UPDATE users SET name=?, lang=? WHERE id=?').run(name, lang, user.id);
  return { ok: true, user: userView({ ...user, name, lang }) };
});

app.get('/api/stream', { auth: 'user' }, ({ req, res, user }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\nevent: hello\ndata: {}\n\n');
  rt.addClient(user.id, res);
  return { __sse: true };
});

// ---------- карта и расчёт ----------
app.get('/api/geo/search', { auth: 'user' }, async ({ query, user }) => {
  const q = str(query.q, 2, 100);
  if (!q) throw bad('bad_request');
  if (!rl.geo.take(user.id)) throw bad('too_many_requests', 429);
  try { return { results: await searchAddress(q) }; } catch { throw bad('geo_unavailable', 502); }
});

app.get('/api/geo/reverse', { auth: 'user' }, async ({ query, user }) => {
  const lat = Number(query.lat), lng = Number(query.lng);
  if (!inKz(lat, lng)) throw bad('out_of_country');
  if (!rl.geo.take(user.id)) throw bad('too_many_requests', 429);
  try { return await reverse(lat, lng); } catch { return { addr: `${lat.toFixed(5)}, ${lng.toFixed(5)}` }; }
});

function point(p, needAddr) {
  if (!p || typeof p !== 'object') throw bad('bad_point');
  const lat = num(p.lat), lng = num(p.lng);
  if (!inKz(lat, lng)) throw bad('out_of_country');
  const addr = needAddr ? str(p.addr, 2, 200) : null;
  if (needAddr && !addr) throw bad('bad_address');
  return { lat, lng, addr };
}

app.post('/api/quote', { auth: 'user' }, async ({ body, user }) => {
  if (!rl.quote.take(user.id)) throw bad('too_many_requests', 429);
  const a = point(body.pickup), b = point(body.drop);
  const r = await route(a, b);
  if (r.km < 0.3) throw bad('too_close');
  if (r.km > 150) throw bad('too_far');
  return { distance_km: Math.round(r.km * 10) / 10, duration_min: Math.round(r.min), prices: allPrices(r.km, r.min), geometry: r.geometry };
});

// ---------- поездки пассажира ----------
app.post('/api/rides', { auth: 'user' }, async ({ body, user }) => {
  if (!rl.rides.take(user.id)) throw bad('too_many_requests', 429);
  const a = point(body.pickup, true), b = point(body.drop, true);
  if (!CLASSES.includes(body.car_class)) throw bad('bad_class');
  const comment = body.comment ? str(body.comment, 0, 200) ?? '' : '';
  const boost = body.boost === undefined ? 0 : body.boost;
  if (!Number.isInteger(boost) || boost < 0 || boost > 500 || boost % 50) throw bad('bad_boost');
  if (activeRideOf(user.id, 'passenger_id')) throw bad('active_ride_exists', 409);
  const r = await route(a, b);
  if (r.km < 0.3) throw bad('too_close');
  if (r.km > 150) throw bad('too_far');
  const price = priceFor(body.car_class, r.km, r.min) + boost;
  const res = db.prepare(`INSERT INTO rides(passenger_id,status,pickup_addr,pickup_lat,pickup_lng,drop_addr,drop_lat,drop_lng,
    distance_km,duration_min,car_class,price,boost,payment,comment,commission_percent,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(user.id, 'searching', a.addr, a.lat, a.lng, b.addr, b.lat, b.lng, r.km, r.min, body.car_class, price, boost, 'cash', comment, getSetting('commission_percent'), now());
  const ride = getRide(res.lastInsertRowid);
  dispatch(ride);
  return { ride: rideView(ride, user.id) };
});

app.get('/api/rides/active', { auth: 'user' }, ({ user }) => {
  const a = activeRideOf(user.id, 'passenger_id');
  return { ride: a ? rideView(a, user.id) : null };
});

app.get('/api/rides', { auth: 'user' }, ({ user, query }) => {
  const field = query.role === 'driver' ? 'driver_id' : 'passenger_id';
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 30, 1), 100);
  const before = parseInt(query.before, 10) || 2 ** 31;
  const rows = db.prepare(`SELECT * FROM rides WHERE ${field}=? AND id<? AND status IN ('completed','cancelled','expired') ORDER BY id DESC LIMIT ?`)
    .all(user.id, before, limit);
  return { rides: rows.map((r) => rideView(r, user.id)) };
});

app.post('/api/rides/:id/cancel', { auth: 'user' }, ({ user, params, body }) => {
  const r = getRide(Number(params.id));
  if (!r) throw bad('not_found', 404);
  const reason = body.reason ? str(body.reason, 0, 200) ?? '' : '';
  if (r.passenger_id === user.id) {
    if (!['searching', 'accepted', 'arrived'].includes(r.status)) throw bad('cannot_cancel', 409);
    db.prepare(`UPDATE rides SET status='cancelled', cancel_by='passenger', cancel_reason=? WHERE id=? AND status IN ('searching','accepted','arrived')`).run(reason, r.id);
    withdrawOffer(r.id);
    declined.delete(r.id);
    notifyRide(getRide(r.id));
    return { ok: true };
  }
  if (r.driver_id === user.id) {
    if (!['accepted', 'arrived'].includes(r.status)) throw bad('cannot_cancel', 409);
    // Поездка возвращается в поиск, пассажира не бросаем.
    db.prepare(`UPDATE rides SET status='searching', driver_id=NULL, accepted_at=NULL, arrived_at=NULL WHERE id=? AND driver_id=?`).run(r.id, user.id);
    if (!declined.has(r.id)) declined.set(r.id, new Set());
    declined.get(r.id).add(user.id);
    const fresh = getRide(r.id);
    rt.push(r.passenger_id, 'ride_update', { ride: rideView(fresh, r.passenger_id), notice: 'driver_cancelled' });
    rt.push(user.id, 'ride_update', { ride: { id: r.id, status: 'released' } });
    dispatch(fresh);
    return { ok: true };
  }
  throw bad('forbidden', 403);
});

app.post('/api/rides/:id/rate', { auth: 'user' }, ({ user, params, body }) => {
  if (!rl.rate.take(user.id)) throw bad('too_many_requests', 429);
  const r = getRide(Number(params.id));
  if (!r || r.status !== 'completed') throw bad('not_found', 404);
  const stars = body.stars;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw bad('bad_stars');
  const comment = body.comment ? str(body.comment, 0, 300) ?? '' : '';
  if (now() - r.finished_at > 7 * DAY) throw bad('rating_closed', 409);
  if (r.passenger_id === user.id) {
    if (r.rating_for_driver != null) throw bad('already_rated', 409);
    db.prepare('UPDATE rides SET rating_for_driver=?, comment_for_driver=? WHERE id=?').run(stars, comment, r.id);
  } else if (r.driver_id === user.id) {
    if (r.rating_for_passenger != null) throw bad('already_rated', 409);
    db.prepare('UPDATE rides SET rating_for_passenger=?, comment_for_passenger=? WHERE id=?').run(stars, comment, r.id);
  } else throw bad('forbidden', 403);
  return { ok: true };
});

// ---------- водитель ----------
const CITIES = ['Астана', 'Алматы', 'Шымкент', 'Караганда', 'Актобе', 'Атырау', 'Павлодар', 'Усть-Каменогорск', 'Семей', 'Костанай', 'Петропавловск', 'Актау', 'Тараз', 'Кызылорда', 'Уральск', 'Туркестан', 'Талдыкорган', 'Кокшетау', 'Темиртау', 'Другой город'];
const COLORS = ['белый', 'чёрный', 'серый', 'серебристый', 'синий', 'красный', 'зелёный', 'жёлтый', 'коричневый', 'бежевый', 'другой'];

app.post('/api/driver/apply', { auth: 'user' }, ({ user, body }) => {
  const existing = driverRow(user.id);
  if (existing && !['draft', 'rejected'].includes(existing.status)) throw bad('already_applied', 409);
  const make = str(body.car_make, 2, 30), model = str(body.car_model, 1, 30), plate = str(body.plate, 5, 12);
  const year = body.car_year, city = CITIES.includes(body.city) ? body.city : null;
  if (!make || !model || !plate || !city) throw bad('bad_request');
  if (!Number.isInteger(year) || year < 2005 || year > new Date().getFullYear() + 1) throw bad('bad_year');
  if (!COLORS.includes(body.car_color)) throw bad('bad_color');
  if (!CLASSES.includes(body.car_class)) throw bad('bad_class');
  const plateN = plate.toUpperCase().replace(/\s+/g, '');
  if (!/^[0-9A-ZА-Я]{5,10}$/.test(plateN)) throw bad('bad_plate');
  if (existing) {
    db.prepare(`UPDATE drivers SET city=?,car_make=?,car_model=?,car_year=?,car_color=?,plate=?,car_class=?,status='draft',reject_reason='' WHERE user_id=?`)
      .run(city, make, model, year, body.car_color, plateN, body.car_class, user.id);
  } else {
    db.prepare(`INSERT INTO drivers(user_id,city,car_make,car_model,car_year,car_color,plate,car_class,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(user.id, city, make, model, year, body.car_color, plateN, body.car_class, 'draft', now());
  }
  return { driver: driverView(driverRow(user.id)) };
});

app.get('/api/driver/verification', { auth: 'user' }, ({ user }) => {
  const d = driverRow(user.id);
  if (!d) throw bad('not_a_driver', 404);
  return {
    driver: driverView(d),
    challenge: ver.getChallenge(user.id),
    required: ver.REQUIRED,
    face_check_hours: getSetting('face_check_hours'),
  };
});

let lastAdminPing = 0;
function notifyAdminsAboutQueue() {
  const admins = db.prepare('SELECT id, phone FROM users WHERE is_admin=1').all();
  rt.pushMany(admins.map((a) => a.id), 'queue', { size: ver.list().length });
  if (now() - lastAdminPing > 5 * 60_000) {
    lastAdminPing = now();
    for (const a of admins) sendText(a.phone, 'KUKA TAXI: новая заявка на проверку водителя. Откройте админ-панель.');
  }
}

app.post('/api/driver/verification', { auth: 'user', maxBody: 14 * 1024 * 1024 }, ({ user, body }) => {
  const d = driverRow(user.id);
  if (!d) throw bad('not_a_driver', 404);
  const kind = body.kind;
  if (kind === 'registration') {
    if (!['draft', 'rejected', 'pending'].includes(d.status)) throw bad('wrong_state', 409);
  } else if (kind === 'face') {
    if (d.status !== 'approved') throw bad('wrong_state', 409);
  } else throw bad('bad_request');
  if (body.consent !== true) throw bad('consent_required');
  if (!rl.verif.take(user.id)) throw bad('too_many_requests', 429);
  const r = ver.submit(user.id, kind, body.images);
  if (r.error) throw bad(r.error, r.error === 'queue_full' ? 503 : 400, r.key ? { key: r.key } : {});
  if (kind === 'registration') db.prepare(`UPDATE drivers SET status='pending', reject_reason='' WHERE user_id=?`).run(user.id);
  else db.prepare(`UPDATE drivers SET face_reject_reason='' WHERE user_id=?`).run(user.id);
  notifyAdminsAboutQueue();
  return { ok: true, driver: driverView(driverRow(user.id)) };
});

app.post('/api/driver/online', { auth: 'user' }, ({ user, body }) => {
  const d = driverRow(user.id);
  if (!d) throw bad('not_a_driver', 404);
  if (body.online === false) {
    db.prepare('UPDATE drivers SET online=0 WHERE user_id=?').run(user.id);
    return { driver: driverView(driverRow(user.id)) };
  }
  if (d.status !== 'approved') throw bad('not_approved', 403);
  if (!faceOk(d)) throw bad('face_check_required', 403);
  const lat = num(body.lat), lng = num(body.lng);
  if (!inKz(lat, lng)) throw bad('location_required');
  db.prepare('UPDATE drivers SET online=1, lat=?, lng=?, loc_at=? WHERE user_id=?').run(lat, lng, now(), user.id);
  return { driver: driverView(driverRow(user.id)), offers: currentOffers(driverRow(user.id)) };
});

app.post('/api/driver/location', { auth: 'user' }, ({ user, body }) => {
  const d = driverRow(user.id);
  if (!d || !d.online) throw bad('not_online', 409);
  if (!rl.loc.take(user.id)) return { ok: true, skipped: true };
  const lat = num(body.lat), lng = num(body.lng);
  if (!inKz(lat, lng)) throw bad('bad_point');
  db.prepare('UPDATE drivers SET lat=?, lng=?, loc_at=? WHERE user_id=?').run(lat, lng, now(), user.id);
  const ride = activeRideOf(user.id, 'driver_id');
  if (ride) rt.push(ride.passenger_id, 'driver_location', { ride_id: ride.id, lat, lng });
  return { ok: true };
});

function currentOffers(d) {
  if (!d || !d.online || d.status !== 'approved' || !faceOk(d) || activeRideOf(d.user_id, 'driver_id')) return [];
  const radius = getSetting('offer_radius_km');
  const rows = db.prepare(`SELECT * FROM rides WHERE status='searching' AND created_at>? ORDER BY created_at DESC LIMIT 50`).all(now() - 10 * 60_000);
  return rows
    .filter((r) => r.passenger_id !== d.user_id && SERVES[d.car_class]?.includes(r.car_class) && !declined.get(r.id)?.has(d.user_id)
      && haversineKm({ lat: d.lat, lng: d.lng }, { lat: r.pickup_lat, lng: r.pickup_lng }) <= radius)
    .map((r) => offerView(r, d));
}

app.get('/api/driver/offers', { auth: 'user' }, ({ user }) => ({ offers: currentOffers(driverRow(user.id)) }));

const KZ_OFFSET = 5 * 3600_000; // Казахстан: UTC+5
app.get('/api/driver/stats', { auth: 'user' }, ({ user }) => {
  const d = driverRow(user.id);
  if (!d) throw bad('not_a_driver', 404);
  const startOfDay = Math.floor((now() + KZ_OFFSET) / DAY) * DAY - KZ_OFFSET;
  const q = (since) => db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(price - price*commission_percent/100.0),0) s FROM rides WHERE driver_id=? AND status='completed' AND finished_at>=?`).get(user.id, since);
  const t = q(startOfDay), w = q(startOfDay - 6 * DAY), m = q(startOfDay - 29 * DAY);
  const all = db.prepare(`SELECT COUNT(*) c FROM rides WHERE driver_id=? AND status='completed'`).get(user.id);
  return {
    today: { rides: t.c, earned: Math.round(t.s) }, week: { rides: w.c, earned: Math.round(w.s) }, month: { rides: m.c, earned: Math.round(m.s) },
    total_rides: all.c, commission_percent: getSetting('commission_percent'),
  };
});

function driverGuard(user) {
  const d = driverRow(user.id);
  if (!d || d.status !== 'approved') throw bad('not_approved', 403);
  return d;
}

app.post('/api/rides/:id/accept', { auth: 'user' }, ({ user, params }) => {
  const d = driverGuard(user);
  if (!d.online) throw bad('not_online', 409);
  if (!faceOk(d)) throw bad('face_check_required', 403);
  if (activeRideOf(user.id, 'driver_id')) throw bad('active_ride_exists', 409);
  const r = getRide(Number(params.id));
  if (!r) throw bad('not_found', 404);
  if (r.passenger_id === user.id) throw bad('own_ride', 400);
  if (!SERVES[d.car_class]?.includes(r.car_class)) throw bad('wrong_class', 403);
  const res = db.prepare(`UPDATE rides SET status='accepted', driver_id=?, accepted_at=? WHERE id=? AND status='searching'`).run(user.id, now(), r.id);
  if (res.changes !== 1) throw bad('ride_taken', 409);
  declined.delete(r.id);
  withdrawOffer(r.id);
  const fresh = getRide(r.id);
  notifyRide(fresh);
  return { ride: rideView(fresh, user.id) };
});

function transition(name, from, to, stamp, extra = '') {
  app.post(`/api/rides/:id/${name}`, { auth: 'user' }, ({ user, params }) => {
    const r = getRide(Number(params.id));
    if (!r || r.driver_id !== user.id) throw bad('not_found', 404);
    const res = db.prepare(`UPDATE rides SET status=?, ${stamp}=? ${extra} WHERE id=? AND status=? AND driver_id=?`).run(to, now(), r.id, from, user.id);
    if (res.changes !== 1) throw bad('wrong_state', 409);
    const fresh = getRide(r.id);
    notifyRide(fresh);
    return { ride: rideView(fresh, user.id) };
  });
}
transition('arrived', 'accepted', 'arrived', 'arrived_at');
transition('start', 'arrived', 'in_progress', 'started_at');
transition('complete', 'in_progress', 'completed', 'finished_at');

// ---------- админ-панель ----------
const driverBrief = (userId) => {
  const u = db.prepare('SELECT name, phone FROM users WHERE id=?').get(userId);
  const d = driverRow(userId);
  return { name: u?.name, phone: u?.phone, car: d ? `${d.car_make} ${d.car_model} ${d.car_year}, ${d.car_color}` : '', plate: d?.plate, car_class: d?.car_class, city: d?.city };
};

app.get('/api/admin/verifications', { auth: 'admin' }, () => ({
  items: ver.list().map((r) => ({ ...r, driver: driverBrief(r.driverId) })),
}));

app.get('/api/admin/verifications/:id/image/:key', { auth: 'admin' }, ({ params, res }) => {
  const buf = ver.image(params.id, params.key);
  if (!buf) throw bad('not_found', 404);
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store, private' });
  res.end(buf);
});

app.post('/api/admin/verifications/:id/decision', { auth: 'admin' }, ({ user, params, body }) => {
  const r = ver.get(params.id);
  if (!r) throw bad('not_found', 404);
  const d = driverRow(r.driverId);
  const approve = body.approve === true;
  const reason = approve ? '' : str(body.reason, 3, 200);
  if (!approve && !reason) throw bad('reason_required');
  const hours = getSetting('face_check_hours');
  const validUntil = approve ? now() + hours * 3600_000 : null;
  if (approve) {
    if (r.kind === 'registration') db.prepare(`UPDATE drivers SET status='approved', approved_at=?, face_valid_until=?, reject_reason='', face_reject_reason='' WHERE user_id=?`).run(now(), validUntil, r.driverId);
    else db.prepare(`UPDATE drivers SET face_valid_until=?, face_reject_reason='' WHERE user_id=?`).run(validUntil, r.driverId);
  } else if (r.kind === 'registration') {
    db.prepare(`UPDATE drivers SET status='rejected', reject_reason=? WHERE user_id=?`).run(reason, r.driverId);
  } else {
    db.prepare(`UPDATE drivers SET face_reject_reason=? WHERE user_id=?`).run(reason, r.driverId);
  }
  db.prepare('INSERT INTO verification_log(driver_id,kind,decision,reason,admin_id,valid_until,decided_at) VALUES(?,?,?,?,?,?,?)')
    .run(r.driverId, r.kind, approve ? 'approved' : 'rejected', reason || '', user.id, validUntil, now());
  ver.remove(r.id); // фото удаляются из памяти сразу после решения
  const fresh = driverRow(r.driverId);
  rt.push(r.driverId, 'verification', { driver: driverView(fresh) });
  const phone = db.prepare('SELECT phone FROM users WHERE id=?').get(r.driverId)?.phone;
  if (phone) sendText(phone, approve ? 'KUKA TAXI: проверка пройдена. Можно выходить на линию.' : `KUKA TAXI: проверка не пройдена. Причина: ${reason}`);
  rt.pushMany(db.prepare('SELECT id FROM users WHERE is_admin=1').all().map((a) => a.id), 'queue', { size: ver.list().length });
  return { ok: true, driver: driverView(fresh) };
});

app.get('/api/admin/drivers', { auth: 'admin' }, () => {
  const rows = db.prepare(`SELECT d.*, u.name, u.phone, u.blocked FROM drivers d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 500`).all();
  return {
    drivers: rows.map((d) => ({ id: d.user_id, name: d.name, phone: d.phone, blocked: !!d.blocked, ...driverView(d),
      rides: db.prepare(`SELECT COUNT(*) c FROM rides WHERE driver_id=? AND status='completed'`).get(d.user_id).c })),
  };
});

app.post('/api/admin/drivers/:id/status', { auth: 'admin' }, ({ params, body }) => {
  const id = Number(params.id);
  const d = driverRow(id);
  if (!d) throw bad('not_found', 404);
  if (body.status === 'suspended') {
    db.prepare(`UPDATE drivers SET status='suspended', online=0 WHERE user_id=?`).run(id);
  } else if (body.status === 'approved') {
    if (!d.approved_at) throw bad('never_approved', 409);
    db.prepare(`UPDATE drivers SET status='approved' WHERE user_id=?`).run(id);
  } else throw bad('bad_request');
  rt.push(id, 'verification', { driver: driverView(driverRow(id)) });
  return { ok: true };
});

app.post('/api/admin/drivers/:id/face-reset', { auth: 'admin' }, ({ params }) => {
  const id = Number(params.id);
  if (!driverRow(id)) throw bad('not_found', 404);
  db.prepare('UPDATE drivers SET face_valid_until=0, online=0 WHERE user_id=?').run(id);
  rt.push(id, 'face_required', { driver: driverView(driverRow(id)) });
  return { ok: true };
});

app.get('/api/admin/rides', { auth: 'admin' }, () => {
  const rows = db.prepare('SELECT * FROM rides ORDER BY id DESC LIMIT 100').all();
  const name = (id) => (id ? db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name : null);
  return { rides: rows.map((r) => ({ ...rideView(r, -1), passenger_name: name(r.passenger_id), driver_name: name(r.driver_id), rating_for_driver: r.rating_for_driver, rating_for_passenger: r.rating_for_passenger })) };
});

app.get('/api/admin/stats', { auth: 'admin' }, () => {
  const c = (sql, ...a) => db.prepare(sql).get(...a).c;
  const startOfDay = Math.floor((now() + KZ_OFFSET) / DAY) * DAY - KZ_OFFSET;
  return {
    users: c('SELECT COUNT(*) c FROM users'),
    drivers_approved: c(`SELECT COUNT(*) c FROM drivers WHERE status='approved'`),
    drivers_online: c(`SELECT COUNT(*) c FROM drivers WHERE online=1`),
    drivers_pending: c(`SELECT COUNT(*) c FROM drivers WHERE status='pending'`),
    rides_today: c(`SELECT COUNT(*) c FROM rides WHERE created_at>=?`, startOfDay),
    rides_completed_today: c(`SELECT COUNT(*) c FROM rides WHERE status='completed' AND finished_at>=?`, startOfDay),
    queue: ver.list().length,
  };
});

app.get('/api/admin/settings', { auth: 'admin' }, () => ({
  face_check_hours: getSetting('face_check_hours'), commission_percent: getSetting('commission_percent'),
  offer_radius_km: getSetting('offer_radius_km'), tariffs: getSetting('tariffs'),
}));

app.put('/api/admin/settings', { auth: 'admin' }, ({ body }) => {
  const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (body.face_check_hours !== undefined) { if (!inRange(body.face_check_hours, 1, 168)) throw bad('bad_value'); setSetting('face_check_hours', body.face_check_hours); }
  if (body.commission_percent !== undefined) { if (!inRange(body.commission_percent, 0, 30)) throw bad('bad_value'); setSetting('commission_percent', body.commission_percent); }
  if (body.offer_radius_km !== undefined) { if (!inRange(body.offer_radius_km, 1, 50)) throw bad('bad_value'); setSetting('offer_radius_km', body.offer_radius_km); }
  if (body.tariffs !== undefined) {
    const t = {};
    for (const c of CLASSES) {
      const x = body.tariffs?.[c];
      if (!x || !inRange(x.base, 0, 20000) || !inRange(x.per_km, 0, 5000) || !inRange(x.per_min, 0, 1000) || !inRange(x.min, 0, 50000)) throw bad('bad_value');
      t[c] = { base: x.base, per_km: x.per_km, per_min: x.per_min, min: x.min };
    }
    setSetting('tariffs', t);
  }
  return { ok: true };
});

// ---------- фоновые задачи ----------
function tick() {
  const t = now();
  // Поиск без водителя дольше 10 минут закрываем.
  const stale = db.prepare(`SELECT * FROM rides WHERE status='searching' AND created_at<?`).all(t - 10 * 60_000);
  for (const r of stale) {
    db.prepare(`UPDATE rides SET status='expired' WHERE id=? AND status='searching'`).run(r.id);
    declined.delete(r.id);
    withdrawOffer(r.id);
    notifyRide(getRide(r.id));
  }
  // Проверка лица просрочена: выводим водителя с линии (текущую поездку он может завершить).
  const expired = db.prepare(`SELECT * FROM drivers WHERE status='approved' AND online=1 AND face_valid_until<?`).all(t);
  for (const d of expired) {
    if (activeRideOf(d.user_id, 'driver_id')) continue;
    db.prepare('UPDATE drivers SET online=0 WHERE user_id=?').run(d.user_id);
    rt.push(d.user_id, 'face_required', { driver: driverView(driverRow(d.user_id)) });
  }
  // Водители без сигнала GPS больше 15 минут уходят с линии.
  db.prepare(`UPDATE drivers SET online=0 WHERE online=1 AND loc_at<?`).run(t - 15 * 60_000);
  ver.purge(getSetting('verification_ttl_hours') * 3600_000);
  db.prepare('DELETE FROM otp WHERE expires_at<?').run(t - 3600_000);
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(t);
}
setInterval(tick, 30_000).unref();
setInterval(rt.heartbeat, 25_000).unref();

export const server = app.listen();
if (!config.isTest) {
  server.listen(config.port, config.host, () => {
    console.log(`KUKA TAXI запущен: http://localhost:${config.port}  (OTP: ${config.otp.provider}, админы: ${config.adminPhones.length})`);
    if (config.isProd && config.otp.provider === 'console') console.warn('ВНИМАНИЕ: OTP_PROVIDER=console, коды не уходят в WhatsApp.');
    if (!config.adminPhones.length) console.warn('ADMIN_PHONES не задан: войти в админ-панель будет некому.');
  });
}
export { tick };
