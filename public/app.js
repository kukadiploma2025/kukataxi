import { DICT } from './i18n.js';

// Пустые значения (null/false) не должны превращаться в текст "null".
for (const m of ['replaceChildren', 'append', 'prepend']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
}

/* ---------------------------------------------------------------- утилиты */
const L = window.L;
let lang = 'ru';
{
  const nav = (navigator.language || '').startsWith('kk') ? 'kk' : 'ru';
  try { const saved = localStorage.getItem('lang'); lang = saved === 'kk' || saved === 'ru' ? saved : nav; } catch { lang = nav; }
}
document.documentElement.lang = lang;

export function t(key, vars) {
  let s = DICT[lang]?.[key] ?? DICT.ru[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
const errText = (code) => DICT[lang]?.['err.' + code] ?? DICT.ru['err.' + code] ?? t('err.generic');

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'for') el.setAttribute('for', v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (['value', 'checked', 'disabled', 'type', 'placeholder', 'href', 'id', 'name', 'maxLength', 'inputMode', 'autocomplete', 'rows', 'accept', 'min', 'max', 'step', 'required'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svg = (inner, vb = '0 0 24 24') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', vb); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = inner; return s; };
const ICONS = {
  car: '<path d="M5 17h14M6 17l1.5-5h9L18 17M5 17v2M19 17v2M8 13h8"/><circle cx="8" cy="17" r="1"/><circle cx="16" cy="17" r="1"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  wheel: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 3v7M5 16l6-3M19 16l-6-3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
};

const money = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₸`;
const tz = 'Asia/Almaty';
const fmtDT = (ms) => new Intl.DateTimeFormat(lang === 'kk' ? 'kk-KZ' : 'ru-RU', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
const fmtTime = (ms) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ms);
function fmtLeft(ms) {
  if (ms <= 0) return t('time.expired');
  const m = Math.floor(ms / 60000);
  return t('time.left', { h: Math.floor(m / 60), m: m % 60 });
}
const stars = (n) => '★'.repeat(Math.round(n || 0)) + '☆'.repeat(5 - Math.round(n || 0));
const ratingText = (r, c) => (r == null ? t('rating.new') : `${r.toFixed(1)} (${c})`);

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 3800);
}

function modal(content, { dismissible = true } = {}) {
  const back = h('div', { class: 'modal-back', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'modal' }, content));
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape' && dismissible) close(); };
  if (dismissible) back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', esc);
  document.body.append(back);
  return close;
}

/* ---------------------------------------------------------------- API */
const S = {
  cfg: null, user: null, driver: null, activeRide: null, activeDrive: null,
  offers: [], stats: null, es: null, timers: [], map: null, watchId: null, lastLocPost: 0, pos: null, finished: null,
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-KUKA': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) {
    const e = new Error(data?.error || 'generic');
    e.code = data?.error || 'generic'; e.status = res.status; e.data = data;
    if (res.status === 401 && S.user && !path.startsWith('/api/auth')) { S.user = null; closeStream(); location.hash = '#/login'; route(); }
    throw e;
  }
  return data;
}
const guard = (btn, fn) => async (...a) => {
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { await fn(...a); } catch (e) { toast(errText(e.code)); } finally { if (btn) btn.disabled = false; }
};

function every(ms, fn) { const id = setInterval(fn, ms); S.timers.push(id); return id; }
function cleanup() {
  S.timers.forEach(clearInterval); S.timers = [];
  if (S.map) { S.map.remove(); S.map = null; }
}

/* ---------------------------------------------------------------- старт */
async function loadMe() {
  try {
    const me = await api('GET', '/api/me');
    S.user = me.user; S.driver = me.driver; S.activeRide = me.active_ride; S.activeDrive = me.active_drive;
    if (S.user.lang !== lang) { /* язык интерфейса выбирает сам человек на этом устройстве */ }
    return true;
  } catch { S.user = null; return false; }
}

async function boot() {
  try { S.cfg = await api('GET', '/api/config'); } catch { S.cfg = { face_check_hours: 34, commission_percent: 0, tariffs: {}, support_phone: '' }; }
  if (await loadMe()) openStream();
  if (!location.hash) location.hash = '#/';
  route();
}
window.addEventListener('hashchange', route);

function route() {
  cleanup();
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  if (!S.user) return path === '/login' ? loginView() : landingView();
  if (path === '/login') { location.hash = '#/'; return; }
  const views = { '/': passengerView, '/trips': tripsView, '/drive': driverView, '/profile': profileView };
  (views[path] || passengerView)();
}

function mount(...nodes) { const app = document.getElementById('app'); app.replaceChildren(...nodes); window.scrollTo(0, 0); }

function shell(active, ...children) {
  const tabs = [['/', 'tab.order', 'car'], ['/trips', 'tab.trips', 'list'], ['/drive', 'tab.drive', 'wheel'], ['/profile', 'tab.profile', 'user']];
  const bar = h('div', { class: 'tabbar' }, h('nav', { 'aria-label': 'Меню' },
    tabs.map(([href, label, icon]) => h('a', { href: '#' + href, 'aria-current': active === href ? 'page' : null }, svg(ICONS[icon]), t(label)))));
  mount(h('main', { class: 'shell' }, ...children), bar);
}

function setLang(l) {
  lang = l; document.documentElement.lang = l;
  try { localStorage.setItem('lang', l); } catch { /* ok */ }
  if (S.user) api('PATCH', '/api/me', { lang: l }).catch(() => {});
  route();
}
const langToggle = () => h('button', { class: 'langbtn', onclick: () => setLang(lang === 'ru' ? 'kk' : 'ru'), 'aria-label': 'Language' }, lang === 'ru' ? 'ҚАЗ' : 'РУС');
const logo = () => h('a', { class: 'logo', href: '#/' }, 'KUKA', h('small', null, 'TAXI'));

/* ---------------------------------------------------------------- лендинг */
const CITY_LIST = ['Астана', 'Алматы', 'Шымкент', 'Караганда', 'Актобе', 'Атырау', 'Павлодар', 'Усть-Каменогорск', 'Семей', 'Костанай', 'Петропавловск', 'Актау', 'Тараз', 'Кызылорда', 'Уральск', 'Туркестан', 'Талдыкорган', 'Кокшетау', 'Темиртау'];

function landingView() {
  const tf = S.cfg?.tariffs?.economy;
  mount(h('div', { class: 'land' },
    h('header', { class: 'topbar' }, logo(), h('div', { class: 'row' }, langToggle(), h('a', { class: 'btn small dark', href: '#/login' }, t('login.enter')))),
    h('section', { class: 'hero' },
      h('div', { class: 'col gap20' },
        h('span', { class: 'pill' }, t('land.badge')),
        h('h1', null, t('land.h1a'), ' ', h('em', null, t('land.h1b'))),
        h('p', { class: 'muted', style: 'font-size:18px;max-width:46ch' }, t('land.lead')),
        h('div', { class: 'row wrap' },
          h('a', { class: 'btn primary', href: '#/login' }, t('land.cta.pass')),
          h('a', { class: 'btn', href: '#/login?driver' , }, t('land.cta.drv')))),
      h('div', { class: 'hero-card' },
        h('h3', null, t('land.card.t')),
        h('div', { class: 'rowx' }, h('span', null, t('land.card.pay')), h('b', null, t('land.card.pay.v'))),
        h('div', { class: 'rowx' }, h('span', null, t('land.card.com')), h('b', null, t('land.card.com.v'))),
        h('div', { class: 'rowx' }, h('span', null, t('land.card.min')), h('b', null, tf ? money(tf.min) : '—')),
        h('div', { class: 'rowx' }, h('span', null, t('land.card.face')), h('b', null, t('land.card.face.v', { h: S.cfg?.face_check_hours ?? 34 }))))),
    h('section', { class: 'col gap20' }, h('h2', null, t('land.pass.t')),
      h('div', { class: 'grid3' }, [1, 2, 3].map((i) => h('div', { class: 'card feat' }, h('b', null, t(`land.pass.${i}.t`)), h('p', { class: 'muted' }, t(`land.pass.${i}.d`)))))),
    h('section', { class: 'col gap20' }, h('h2', null, t('land.drv.t')),
      h('div', { class: 'grid3' }, [1, 2, 3].map((i) => h('div', { class: 'card feat' }, h('b', null, t(`land.drv.${i}.t`)), h('p', { class: 'muted' }, t(`land.drv.${i}.d`)))))),
    h('section', { class: 'col' }, h('h2', null, t('land.cities')), h('div', { class: 'cities' }, CITY_LIST.map((c) => h('span', null, c)))),
    h('footer', { class: 'muted small' }, t('land.foot'), S.cfg?.support_phone ? ` · ${S.cfg.support_phone}` : '')));
}

/* ---------------------------------------------------------------- вход по коду из WhatsApp */
function loginView() {
  let phone = ''; let isNew = false; let countdown = 0;
  const box = h('div', { class: 'card col' });
  const wrap = h('div', { class: 'shell', style: 'padding-bottom:40px' },
    h('header', { class: 'topbar' }, logo(), langToggle()), box);
  mount(wrap);

  const tick = () => { if (countdown > 0) { countdown--; const b = document.getElementById('resend'); if (b) { b.textContent = countdown ? t('login.resend.in', { s: countdown }) : t('login.resend'); b.disabled = countdown > 0; } } };
  every(1000, tick);

  function stepPhone(msg = '') {
    const inp = h('input', { class: 'input', id: 'phone', type: 'tel', inputMode: 'tel', autocomplete: 'tel-national', placeholder: '701 234 56 78', value: phone.replace('+7', ''), 'aria-label': t('login.phone') });
    const err = h('div', { class: 'err', role: 'alert' }, msg);
    const btn = h('button', { class: 'btn primary block' }, t('login.getcode'));
    const send = async () => {
      if (btn.disabled) return;
      btn.disabled = true; err.textContent = '';
      let digits = inp.value.replace(/\D/g, '');
      if (digits.length === 11 && /^[78]/.test(digits)) digits = digits.slice(1);
      phone = '+7' + digits;
      try {
        const r = await api('POST', '/api/auth/request', { phone, lang });
        isNew = r.new_user; countdown = r.retry_after;
        stepCode(r.dev_code);
      } catch (e) {
        if (e.code === 'cooldown') { isNew = false; countdown = e.data?.retry_after || 60; err.textContent = ''; stepCode(); return; }
        err.textContent = errText(e.code); btn.disabled = false;
      }
    };
    btn.onclick = send;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    box.replaceChildren(
      h('h2', null, t('login.title')), h('p', { class: 'muted' }, t('login.sub')),
      h('label', { class: 'f', for: 'phone' }, t('login.phone'), h('div', { class: 'row gap8' }, h('b', { style: 'font-size:18px' }, '+7'), inp)),
      err, btn, h('p', { class: 'muted small' }, t('login.legal')));
    inp.focus();
  }

  function stepCode(devCode) {
    const code = h('input', { class: 'input code-input', id: 'code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, placeholder: '••••••', 'aria-label': t('login.code') });
    const name = isNew ? h('input', { class: 'input', id: 'uname', autocomplete: 'name', maxLength: 40, placeholder: t('login.name.ph') }) : null;
    const err = h('div', { class: 'err', role: 'alert' });
    const btn = h('button', { class: 'btn primary block' }, t('login.confirm'));
    const resend = h('button', { class: 'btn small', id: 'resend', disabled: countdown > 0 }, countdown ? t('login.resend.in', { s: countdown }) : t('login.resend'));
    const verify = async () => {
      btn.disabled = true; err.textContent = '';
      try {
        await api('POST', '/api/auth/verify', { phone, code: code.value.trim(), name: name?.value.trim(), lang });
        await loadMe(); openStream();
        const to = S.afterLogin || '/'; S.afterLogin = null;
        location.hash = '#' + to; route();
      } catch (e) { err.textContent = errText(e.code); btn.disabled = false; }
    };
    btn.onclick = verify;
    code.addEventListener('input', () => { if (code.value.replace(/\D/g, '').length === 6 && (!name || name.value.trim().length > 1)) verify(); });
    resend.onclick = () => stepPhone();
    box.replaceChildren(
      h('h2', null, t('login.code.title')),
      h('p', { class: 'muted' }, t('login.code.sub', { phone })),
      devCode ? h('div', { class: 'hint warn' }, `DEV: ${devCode}`) : null,
      isNew ? h('label', { class: 'f', for: 'uname' }, t('login.name'), name) : null,
      h('label', { class: 'f', for: 'code' }, t('login.code'), code),
      err, btn, h('div', { class: 'row between' }, resend, h('button', { class: 'btn small', onclick: () => stepPhone() }, t('login.change'))));
    (isNew ? name : code).focus();
  }
  if (location.hash.includes('driver')) S.afterLogin = '/drive';
  stepPhone();
}

/* ---------------------------------------------------------------- realtime */
function openStream() {
  closeStream();
  const es = new EventSource('/api/stream');
  S.es = es;
  const on = (name, fn) => es.addEventListener(name, (e) => { try { fn(JSON.parse(e.data)); } catch { /* битое событие */ } });
  on('ride_update', ({ ride, notice }) => onRideUpdate(ride, notice));
  on('driver_location', ({ ride_id, lat, lng }) => { if (S.activeRide?.id === ride_id && S.activeRide.driver) { S.activeRide.driver.lat = lat; S.activeRide.driver.lng = lng; moveCar?.(lat, lng); } });
  on('offer', ({ offer }) => { if (!S.offers.find((o) => o.id === offer.id)) { S.offers.unshift(offer); beep(); if (currentPath() === '/drive') renderOffers?.(); } });
  on('offer_gone', ({ id }) => { S.offers = S.offers.filter((o) => o.id !== id); if (currentPath() === '/drive') renderOffers?.(); });
  on('verification', ({ driver }) => { S.driver = driver; toast(driver.status === 'approved' ? t('drv.toast.approved') : driver.status === 'rejected' ? t('drv.toast.rejected') : t('drv.toast.updated')); if (currentPath() === '/drive') route(); });
  on('face_required', ({ driver }) => { S.driver = driver; stopWatch(); toast(t('drv.toast.face')); if (currentPath() === '/drive') route(); });
}
function closeStream() { S.es?.close(); S.es = null; }
const currentPath = () => location.hash.replace(/^#/, '').split('?')[0] || '/';

function onRideUpdate(ride, notice) {
  const asDriver = !!ride.passenger || ride.status === 'released';
  if (asDriver) {
    if (ride.status === 'released') { S.activeDrive = null; }
    else if (['completed'].includes(ride.status)) { S.activeDrive = null; S.finished = { ride, as: 'driver' }; }
    else if (['cancelled', 'expired'].includes(ride.status)) { S.activeDrive = null; toast(t('drv.toast.pcancel')); }
    else S.activeDrive = ride;
    if (currentPath() === '/drive') route();
    if (S.finished?.as === 'driver') askRating();
    return;
  }
  if (notice === 'driver_cancelled') toast(t('ride.driver.cancelled'));
  if (ride.status === 'completed') { S.activeRide = null; S.finished = { ride, as: 'passenger' }; }
  else if (ride.status === 'cancelled') { S.activeRide = null; toast(t('ride.cancelled')); }
  else if (ride.status === 'expired') { S.activeRide = null; toast(t('ride.expired')); }
  else {
    const prev = S.activeRide?.status;
    S.activeRide = ride;
    if (prev && prev !== ride.status) { if (ride.status === 'accepted') beep(); if (ride.status === 'arrived') { beep(); toast(t('ride.arrived.toast')); } }
  }
  if (currentPath() === '/') route();
  if (S.finished?.as === 'passenger') askRating();
}

let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch { /* звук недоступен */ }
}

/* ---------------------------------------------------------------- карта */
const ASTANA = [51.1605, 71.4704];
function mkMap(el, center = ASTANA, zoom = 12) {
  if (!L) { el.style.height = 'auto'; el.style.minHeight = '0'; el.append(h('div', { class: 'hint warn' }, t('map.fail'))); return null; }
  const m = L.map(el, { zoomControl: false, attributionControl: true }).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  L.control.zoom({ position: 'topright' }).addTo(m);
  S.map = m;
  return m;
}
const pin = (cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
let moveCar = null; let renderOffers = null;

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(Object.assign(new Error('geo'), { code: 'location_required' }));
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(Object.assign(new Error('geo'), { code: 'location_denied' })), { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 });
  });
}

/* ---------------------------------------------------------------- пассажир: заказ */
const order = { pickup: null, drop: null, car_class: 'economy', quote: null, boost: 0, comment: '', active: 'pickup', results: [], busy: false };

function passengerView() {
  if (S.activeRide) return rideScreen();
  orderScreen();
}

function orderScreen() {
  const mapEl = h('div', { class: 'map', id: 'map' });
  const sheet = h('div', { class: 'card col' });
  shell('/', h('header', { class: 'topbar' }, logo(), langToggle()), mapEl, sheet);
  const map = mkMap(mapEl);
  const markers = {}; let routeLine = null;

  function drawPoints() {
    if (!map) return;
    for (const k of ['pickup', 'drop']) {
      markers[k]?.remove(); markers[k] = null;
      if (order[k]) markers[k] = L.marker([order[k].lat, order[k].lng], { icon: pin(k === 'pickup' ? 'a' : 'b') }).addTo(map);
    }
    routeLine?.remove(); routeLine = null;
    if (order.quote?.geometry) routeLine = L.geoJSON(order.quote.geometry, { style: { color: '#1B7FD3', weight: 5, opacity: .85 } }).addTo(map);
    const pts = ['pickup', 'drop'].map((k) => order[k]).filter(Boolean).map((p) => [p.lat, p.lng]);
    if (pts.length === 2) map.fitBounds(pts, { padding: [40, 40] }); else if (pts.length === 1) map.setView(pts[0], 15);
  }

  async function setPoint(which, pt) {
    order[which] = pt; order.results = [];
    if (which === 'pickup' && !order.drop) order.active = 'drop';
    order.quote = null; drawPoints(); renderSheet();
    if (order.pickup && order.drop) {
      try {
        order.quote = await api('POST', '/api/quote', { pickup: order.pickup, drop: order.drop });
        drawPoints();
      } catch (e) { toast(errText(e.code)); }
      renderSheet();
    }
  }

  if (map) map.on('click', async (e) => {
    const which = order.active;
    const lat = e.latlng.lat, lng = e.latlng.lng;
    let addr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    try { addr = (await api('GET', `/api/geo/reverse?lat=${lat}&lng=${lng}`)).addr || addr; } catch (er) { if (er.code === 'out_of_country') return toast(errText(er.code)); }
    setPoint(which, { addr, lat, lng });
  });

  async function locate() {
    try {
      const p = await getPosition(); S.pos = p;
      let addr = t('order.here');
      try { addr = (await api('GET', `/api/geo/reverse?lat=${p.lat}&lng=${p.lng}`)).addr || addr; } catch { /* оставляем подпись */ }
      setPoint('pickup', { addr, ...p });
    } catch (e) { toast(errText(e.code)); }
  }

  function field(which, labelKey) {
    const inp = h('input', { class: 'input', id: 'f_' + which, placeholder: t(labelKey), value: order[which]?.addr || '', autocomplete: 'off', maxLength: 100, 'aria-label': t(labelKey) });
    inp.addEventListener('focus', () => { order.active = which; });
    const search = async () => {
      const q = inp.value.trim(); if (q.length < 2) return;
      order.active = which;
      try { order.results = (await api('GET', `/api/geo/search?q=${encodeURIComponent(q + (/астана|алматы|шымкент|караганд/i.test(q) ? '' : ''))}`)).results; if (!order.results.length) toast(t('order.nores')); } catch (e) { toast(errText(e.code)); }
      renderSheet(which);
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    return h('div', { class: 'fieldrow' }, h('span', { class: 'dot ' + (which === 'pickup' ? 'a' : 'b') }), h('div', { class: 'grow' }, inp),
      h('button', { class: 'btn small', onclick: search, 'aria-label': t('order.find') }, t('order.find')));
  }

  function renderSheet(focus) {
    const children = [h('h3', null, t('order.title'))];
    children.push(field('pickup', 'order.from'), field('drop', 'order.to'));
    children.push(h('div', { class: 'row wrap gap8' },
      h('button', { class: 'btn small', onclick: locate }, t('order.locate')),
      h('span', { class: 'muted small' }, order.active === 'pickup' ? t('order.tap.from') : t('order.tap.to'))));
    if (order.results.length) {
      children.push(h('div', { class: 'results', role: 'listbox' }, order.results.map((r) => h('button', { role: 'option', onclick: () => setPoint(order.active, r) }, r.addr))));
    }
    if (order.pickup && order.drop && !order.quote) children.push(h('p', { class: 'muted center' }, t('order.calc')));
    if (order.quote) {
      const q = order.quote;
      children.push(h('div', { class: 'row between' }, h('b', null, t('order.dist', { km: q.distance_km, min: q.duration_min })), h('span', { class: 'pill' }, t('order.cash'))));
      const names = { economy: 'cls.economy', comfort: 'cls.comfort', business: 'cls.business', minivan: 'cls.minivan' };
      children.push(h('div', { class: 'tariffs', role: 'radiogroup' }, Object.keys(names).map((c) =>
        h('button', { class: 'tariff', 'aria-pressed': String(order.car_class === c), onclick: () => { order.car_class = c; renderSheet(); } },
          h('div', { class: 'grow' }, h('div', { class: 'nm' }, t(names[c])), h('div', { class: 'sub' }, t(names[c] + '.d'))),
          h('span', { class: 'price' }, money(q.prices[c] + order.boost))))));
      children.push(h('label', { class: 'f', for: 'boost' }, t('order.boost'),
        h('select', { class: 'input', id: 'boost', onchange: (e) => { order.boost = Number(e.target.value); renderSheet(); } },
          [0, 100, 200, 300, 500].map((b) => h('option', { value: b, selected: order.boost === b }, b ? `+ ${money(b)}` : t('order.boost.none'))))));
      children.push(h('label', { class: 'f', for: 'cmt' }, t('order.comment'),
        h('input', { class: 'input', id: 'cmt', maxLength: 200, value: order.comment, placeholder: t('order.comment.ph'), oninput: (e) => { order.comment = e.target.value; } })));
      const go = h('button', { class: 'btn primary block' }, t('order.go', { price: money(q.prices[order.car_class] + order.boost) }));
      go.onclick = guard(go, async () => {
        const r = await api('POST', '/api/rides', { pickup: order.pickup, drop: order.drop, car_class: order.car_class, boost: order.boost, comment: order.comment });
        S.activeRide = r.ride; order.quote = null; order.drop = null; order.comment = ''; order.boost = 0;
        route();
      });
      children.push(go, h('p', { class: 'muted small center' }, t('order.cash.note')));
    }
    sheet.replaceChildren(...children);
    if (focus) document.getElementById('f_' + focus)?.focus();
  }
  renderSheet();
  drawPoints();
  if (!order.pickup && navigator.permissions?.query) navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') locate(); }).catch(() => {});
  if (order.pickup && order.drop && !order.quote) setPoint('drop', order.drop);
}

/* ---------------------------------------------------------------- пассажир: поездка */
function statusSteps(status) {
  const idx = { searching: 0, accepted: 1, arrived: 2, in_progress: 3 }[status] ?? 0;
  return h('div', { class: 'steps', 'aria-hidden': 'true' }, [0, 1, 2, 3].map((i) => h('i', { class: i <= idx ? 'on' : '' })));
}

function rideScreen() {
  const r = S.activeRide;
  const mapEl = h('div', { class: 'map', id: 'map' });
  const panel = h('div', { class: 'card col' });
  shell('/', h('header', { class: 'topbar' }, logo(), langToggle()), mapEl, panel);
  const map = mkMap(mapEl, [r.pickup.lat, r.pickup.lng], 14);
  let car = null;
  if (map) {
    L.marker([r.pickup.lat, r.pickup.lng], { icon: pin('a') }).addTo(map);
    L.marker([r.drop.lat, r.drop.lng], { icon: pin('b') }).addTo(map);
    map.fitBounds([[r.pickup.lat, r.pickup.lng], [r.drop.lat, r.drop.lng]], { padding: [40, 40] });
    if (r.driver?.lat != null) car = L.marker([r.driver.lat, r.driver.lng], { icon: pin('car') }).addTo(map);
  }
  moveCar = (lat, lng) => { if (!map) return; if (car) car.setLatLng([lat, lng]); else car = L.marker([lat, lng], { icon: pin('car') }).addTo(map); };

  const titles = { searching: 'ride.searching', accepted: 'ride.accepted', arrived: 'ride.arrived', in_progress: 'ride.inprogress' };
  const kids = [statusSteps(r.status), h('div', { class: 'row' }, r.status === 'searching' ? h('span', { class: 'pulse' }) : null, h('h2', null, t(titles[r.status] || 'ride.searching')))];
  if (r.status === 'searching') {
    const left = h('span', null, '');
    const upd = () => { const s = Math.floor((Date.now() - r.created_at) / 1000); left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    upd(); every(1000, upd);
    kids.push(h('p', { class: 'muted' }, t('ride.searching.d'), ' ', left));
  }
  if (r.driver) {
    kids.push(h('div', { class: 'card col', style: 'background:var(--paper)' },
      h('div', { class: 'row between' }, h('b', null, r.driver.name), h('span', { class: 'stars' }, ratingText(r.driver.rating, r.driver.rating_count))),
      h('div', { class: 'row between wrap' }, h('span', null, `${r.driver.car}, ${r.driver.color}`), h('span', { class: 'plate' }, r.driver.plate)),
      h('a', { class: 'btn small', href: `tel:${r.driver.phone}` }, t('ride.call'), ' ', r.driver.phone)));
  }
  kids.push(h('div', { class: 'col gap8' },
    h('div', { class: 'addr' }, h('span', { class: 'dot a' }), r.pickup.addr),
    h('div', { class: 'addr' }, h('span', { class: 'dot b' }), r.drop.addr)));
  kids.push(h('div', { class: 'row between' }, h('span', { class: 'muted' }, t('ride.pay.cash')), h('span', { class: 'price', style: 'font-size:22px' }, money(r.price))));
  if (r.status === 'in_progress') kids.push(h('div', { class: 'hint warn' }, t('ride.sos'), ' ', h('a', { href: 'tel:112' }, '112'), ' · ', h('a', { href: 'tel:102' }, '102')));
  if (r.status !== 'in_progress') {
    const cancel = h('button', { class: 'btn danger block' }, t('ride.cancel'));
    cancel.onclick = guard(cancel, async () => { await api('POST', `/api/rides/${r.id}/cancel`, {}); S.activeRide = null; toast(t('ride.cancelled')); route(); });
    kids.push(cancel);
  }
  panel.replaceChildren(...kids);
}

function askRating() {
  const f = S.finished; if (!f) return;
  S.finished = null;
  const asDriver = f.as === 'driver';
  let pick = 0;
  const comment = h('input', { class: 'input', maxLength: 300, placeholder: t('rate.comment') });
  const starsEl = h('div', { class: 'starpick', role: 'radiogroup', 'aria-label': t('rate.title') });
  const draw = () => starsEl.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h('button', { class: n <= pick ? 'on' : '', 'aria-label': `${n}`, onclick: () => { pick = n; draw(); send.disabled = false; } }, '★')));
  const send = h('button', { class: 'btn primary block', disabled: true }, t('rate.send'));
  const close = modal([
    h('h2', { class: 'center' }, t('rate.done')),
    h('p', { class: 'center' }, asDriver ? t('rate.cash.get', { price: money(f.ride.price) }) : t('rate.cash.pay', { price: money(f.ride.price) })),
    h('p', { class: 'muted center' }, asDriver ? t('rate.q.pass', { name: f.ride.passenger?.name || '' }) : t('rate.q.drv', { name: f.ride.driver?.name || '' })),
    starsEl, comment, send,
    h('button', { class: 'btn block', onclick: () => { close(); afterRate(); } }, t('rate.skip')),
  ], { dismissible: false });
  draw();
  send.onclick = guard(send, async () => { await api('POST', `/api/rides/${f.ride.id}/rate`, { stars: pick, comment: comment.value.trim() }); toast(t('rate.thanks')); close(); afterRate(); });
  function afterRate() { if (currentPath() === '/' || currentPath() === '/drive') route(); }
}

/* ---------------------------------------------------------------- история */
async function tripsView() {
  const isDriver = S.driver?.status === 'approved';
  let role = 'passenger';
  const list = h('div', { class: 'col' });
  const seg = h('div', { class: 'row gap8' });
  shell('/trips', h('header', { class: 'topbar' }, h('h2', null, t('trips.title')), langToggle()), seg, list);
  async function load() {
    seg.replaceChildren(...(isDriver ? [['passenger', 'trips.asp'], ['driver', 'trips.asd']].map(([r, k]) => h('button', { class: 'btn small' + (role === r ? ' dark' : ''), onclick: () => { role = r; load(); } }, t(k))) : []));
    list.replaceChildren(h('p', { class: 'muted' }, t('common.loading')));
    try {
      const { rides } = await api('GET', `/api/rides?role=${role}`);
      if (!rides.length) return list.replaceChildren(h('div', { class: 'card center muted' }, t('trips.empty')));
      list.replaceChildren(...rides.map((r) => h('div', { class: 'card trip' },
        h('div', { class: 'row between' }, h('span', { class: 'muted small' }, fmtDT(r.created_at)), h('span', { class: 'pill ' + (r.status === 'completed' ? 'ok' : 'bad') }, t('st.' + r.status))),
        h('div', { class: 'addr' }, h('span', { class: 'dot a' }), r.pickup.addr),
        h('div', { class: 'addr' }, h('span', { class: 'dot b' }), r.drop.addr),
        h('div', { class: 'row between' },
          h('span', { class: 'muted small' }, `${r.distance_km} км · ${t('pay.cash')}`),
          h('span', { class: 'price' }, money(r.price))),
        r.status === 'completed' ? h('div', { class: 'small muted' }, r.my_rating ? `${t('trips.myrate')}: ${stars(r.my_rating)}` : t('trips.norate')) : null)));
    } catch (e) { list.replaceChildren(h('div', { class: 'hint bad' }, errText(e.code))); }
  }
  load();
}

/* ---------------------------------------------------------------- профиль */
function profileView() {
  const u = S.user;
  const name = h('input', { class: 'input', id: 'pname', value: u.name, maxLength: 40 });
  const save = h('button', { class: 'btn primary block' }, t('profile.save'));
  save.onclick = guard(save, async () => { const r = await api('PATCH', '/api/me', { name: name.value.trim() }); S.user = { ...S.user, ...r.user }; toast(t('profile.saved')); });
  const out = h('button', { class: 'btn danger block' }, t('profile.logout'));
  out.onclick = guard(out, async () => { await api('POST', '/api/auth/logout', {}); S.user = null; S.driver = null; closeStream(); stopWatch(); location.hash = '#/'; route(); });
  shell('/profile', h('header', { class: 'topbar' }, h('h2', null, t('profile.title')), langToggle()),
    h('div', { class: 'card col' },
      h('div', { class: 'row between' }, h('div', null, h('b', null, u.name), h('div', { class: 'muted' }, u.phone)), h('div', { class: 'center' }, h('div', { class: 'stars' }, u.rating != null ? stars(u.rating) : ''), h('div', { class: 'muted small' }, t('profile.as.pass') + ': ' + ratingText(u.rating, u.rating_count)))),
      h('label', { class: 'f', for: 'pname' }, t('profile.name'), name), save),
    S.driver ? h('div', { class: 'card col' },
      h('div', { class: 'row between' }, h('b', null, t('profile.driver')), h('span', { class: 'pill ' + (S.driver.status === 'approved' ? 'ok' : S.driver.status === 'suspended' || S.driver.status === 'rejected' ? 'bad' : 'warn') }, t('dst.' + S.driver.status))),
      h('div', { class: 'muted' }, `${S.driver.car_make} ${S.driver.car_model}, ${S.driver.plate}`),
      h('div', { class: 'small muted' }, t('profile.as.drv') + ': ' + ratingText(S.driver.rating, S.driver.rating_count)),
      h('a', { class: 'btn', href: '#/drive' }, t('profile.open.drive'))) : h('a', { class: 'btn block', href: '#/drive' }, t('profile.become')),
    h('div', { class: 'card col' }, h('b', null, t('profile.privacy.t')), h('p', { class: 'muted small' }, t('profile.privacy.d')),
      S.cfg?.support_phone ? h('p', null, t('profile.support'), ' ', h('a', { href: `tel:${S.cfg.support_phone}` }, S.cfg.support_phone)) : null),
    out);
}

/* ---------------------------------------------------------------- водитель */
function driverView() {
  const d = S.driver;
  if (!d) return driverApply();
  if (d.status === 'draft' || d.status === 'rejected') return driverVerification('registration');
  if (d.status === 'pending') return d.verification_pending ? driverWaiting() : driverVerification('registration', true);
  if (d.status === 'suspended') return shell('/drive', h('div', { class: 'card col' }, h('h2', null, t('drv.suspended')), h('p', { class: 'muted' }, t('drv.suspended.d'))));
  driverDashboard();
}

const CITIES = [...CITY_LIST, 'Другой город'];
const COLORS = ['белый', 'чёрный', 'серый', 'серебристый', 'синий', 'красный', 'зелёный', 'жёлтый', 'коричневый', 'бежевый', 'другой'];

function driverApply() {
  const f = {};
  const sel = (id, opts, tr) => h('select', { class: 'input', id, onchange: (e) => { f[id] = e.target.value; } }, h('option', { value: '' }, '—'), opts.map((o) => h('option', { value: o }, tr ? t(tr + o) : o)));
  const txt = (id, ph, max = 30) => h('input', { class: 'input', id, placeholder: ph, maxLength: max, oninput: (e) => { f[id] = e.target.value; } });
  const err = h('div', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn primary block' }, t('apply.next'));
  btn.onclick = guard(btn, async () => {
    err.textContent = '';
    try {
      const r = await api('POST', '/api/driver/apply', { city: f.city, car_make: f.make, car_model: f.model, car_year: Number(f.year), car_color: f.color, plate: f.plate, car_class: f.cls });
      S.driver = r.driver; route();
    } catch (e) { err.textContent = errText(e.code); }
  });
  const label = (id, key, el) => h('label', { class: 'f', for: id }, t(key), el);
  shell('/drive', h('header', { class: 'topbar' }, h('h2', null, t('apply.title')), langToggle()),
    h('div', { class: 'card col' }, h('p', { class: 'muted' }, t('apply.sub')),
      label('city', 'apply.city', sel('city', CITIES)),
      label('make', 'apply.make', txt('make', 'Toyota')), label('model', 'apply.model', txt('model', 'Camry')),
      label('year', 'apply.year', h('input', { class: 'input', id: 'year', inputMode: 'numeric', maxLength: 4, placeholder: '2019', oninput: (e) => { f.year = e.target.value; } })),
      label('color', 'apply.color', sel('color', COLORS)),
      label('plate', 'apply.plate', txt('plate', '123ABC02', 12)),
      label('cls', 'apply.class', h('select', { class: 'input', id: 'cls', onchange: (e) => { f.cls = e.target.value; } }, h('option', { value: '' }, '—'), ['economy', 'comfort', 'business', 'minivan'].map((c) => h('option', { value: c }, t('cls.' + c))))),
      err, btn));
}

/* Загрузка фото: уменьшаем на устройстве, хранятся только в памяти страницы и уходят на сервер одним запросом. */
async function toJpeg(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const draw = (maxSide, q) => {
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  };
  let out = draw(1400, 0.74);
  if (out.length * 0.75 > 800 * 1024) out = draw(1100, 0.62);
  bmp.close?.();
  return out;
}

function driverVerification(kind, expired = false) {
  const body = h('div', { class: 'col' });
  shell('/drive', h('header', { class: 'topbar' }, h('h2', null, kind === 'face' ? t('face.title') : t('ver.title')), langToggle()), body);
  body.append(h('p', { class: 'muted' }, t('common.loading')));
  api('GET', '/api/driver/verification').then(({ challenge, required, driver }) => {
    S.driver = driver;
    const keys = required[kind];
    const imgs = {};
    const tiles = keys.map((k) => {
      const cap = h('span', { class: 'cap' }, t('doc.' + k));
      const inp = h('input', { type: 'file', accept: 'image/*', 'aria-label': t('doc.' + k) });
      if (k === 'selfie_with_id') inp.setAttribute('capture', 'user');
      const tile = h('label', { class: 'tile' }, h('span', { class: 'small muted' }, t('doc.' + k + '.h')), cap, inp);
      inp.addEventListener('change', async () => {
        const file = inp.files[0]; if (!file) return;
        try {
          const url = await toJpeg(file);
          imgs[k] = url; tile.classList.add('done');
          tile.querySelector('img')?.remove(); tile.prepend(h('img', { src: url, alt: t('doc.' + k) }));
          refresh();
        } catch { toast(t('err.bad_image')); }
        inp.value = '';
      });
      return tile;
    });
    const consent = h('input', { type: 'checkbox', id: 'consent' });
    const err = h('div', { class: 'err', role: 'alert' });
    const send = h('button', { class: 'btn primary block', disabled: true }, t('ver.send'));
    const refresh = () => { send.disabled = !(keys.every((k) => imgs[k]) && consent.checked); };
    consent.addEventListener('change', refresh);
    send.onclick = guard(send, async () => {
      err.textContent = '';
      try {
        const r = await api('POST', '/api/driver/verification', { kind, consent: true, images: imgs });
        for (const k of Object.keys(imgs)) delete imgs[k]; // фото больше нигде не лежат
        S.driver = r.driver; toast(t('ver.sent')); route();
      } catch (e) { err.textContent = errText(e.code) + (e.data?.key ? `: ${t('doc.' + e.data.key)}` : ''); }
    });
    const rej = kind === 'registration' ? driver.reject_reason : driver.face_reject_reason;
    body.replaceChildren(
      expired ? h('div', { class: 'hint warn' }, t('ver.expired')) : null,
      rej ? h('div', { class: 'hint bad' }, t('ver.rejected', { reason: rej })) : null,
      h('div', { class: 'hint' }, kind === 'face' ? t('face.why', { h: S.cfg.face_check_hours }) : t('ver.intro')),
      h('div', { class: 'card col' }, h('b', null, t('ver.code.t')), h('div', { class: 'codebox', 'aria-label': t('ver.code.t') }, challenge), h('p', { class: 'muted small' }, t('ver.code.d'))),
      h('div', { class: 'tiles' }, tiles),
      h('div', { class: 'hint warn' }, t('ver.tips')),
      h('label', { class: 'row', for: 'consent', style: 'align-items:flex-start' }, consent, h('span', { class: 'small' }, t('ver.consent'))),
      err, send);
  }).catch((e) => body.replaceChildren(h('div', { class: 'hint bad' }, errText(e.code))));
}

function driverWaiting() {
  const d = S.driver;
  shell('/drive', h('header', { class: 'topbar' }, h('h2', null, t('ver.wait.t')), langToggle()),
    h('div', { class: 'card col center' }, h('div', { class: 'row', style: 'justify-content:center' }, h('span', { class: 'pulse' })),
      h('p', null, t('ver.wait.d')), h('p', { class: 'muted small' }, t('ver.wait.sent', { time: fmtDT(d.verification_pending.created_at) })),
      h('p', { class: 'muted small' }, t('ver.wait.keep'))),
    h('button', { class: 'btn', onclick: async () => { await loadMe(); route(); } }, t('common.refresh')));
  every(15000, async () => { await loadMe(); if (S.driver.status !== 'pending') route(); });
}

function startWatch() {
  if (S.watchId != null || !navigator.geolocation) return;
  S.watchId = navigator.geolocation.watchPosition((p) => {
    S.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (Date.now() - S.lastLocPost > 8000) {
      S.lastLocPost = Date.now();
      api('POST', '/api/driver/location', S.pos).catch((e) => { if (e.code === 'not_online') { S.driver.online = false; stopWatch(); } });
    }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function stopWatch() { if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }

function driverDashboard() {
  const d = S.driver;
  const top = h('div', { class: 'col' });
  const offersBox = h('div', { class: 'col' });
  const drive = h('div', { class: 'col' });
  const faceBox = h('div', { class: 'col' });
  const statsBox = h('div', { class: 'kpis' });
  shell('/drive', h('header', { class: 'topbar' }, h('h2', null, t('drv.title')), langToggle()), top, faceBox, drive, offersBox, statsBox,
    h('div', { class: 'hint ok' }, t('drv.nocomm', { p: S.cfg.commission_percent })));

  /* линия */
  const sw = h('input', { type: 'checkbox', id: 'online', checked: d.online, role: 'switch', 'aria-label': t('drv.online') });
  sw.addEventListener('change', async () => {
    sw.disabled = true;
    try {
      if (sw.checked) {
        const p = await getPosition(); S.pos = p;
        const r = await api('POST', '/api/driver/online', { online: true, ...p });
        S.driver = r.driver; S.offers = r.offers; startWatch(); toast(t('drv.online.on'));
      } else {
        const r = await api('POST', '/api/driver/online', { online: false });
        S.driver = r.driver; S.offers = []; stopWatch(); toast(t('drv.online.off'));
      }
    } catch (e) { sw.checked = !sw.checked; toast(errText(e.code)); }
    sw.disabled = false; route();
  });
  top.append(h('div', { class: 'card row between' },
    h('div', null, h('b', null, d.online ? t('drv.online.on') : t('drv.online.off')), h('div', { class: 'muted small' }, `${d.car_make} ${d.car_model} · ${d.plate} · ${t('cls.' + d.car_class)}`)),
    h('label', { class: 'switch' }, sw, h('i'))));
  if (d.online) startWatch();

  /* проверка лица */
  const left = d.face_valid_until - Date.now();
  const soon = left < 6 * 3600_000;
  faceBox.append(h('div', { class: 'card col' },
    h('div', { class: 'row between' }, h('b', null, t('face.card.t')), h('span', { class: 'pill ' + (left <= 0 ? 'bad' : soon ? 'warn' : 'ok') }, fmtLeft(left))),
    h('p', { class: 'muted small' }, left > 0 ? t('face.card.until', { time: fmtDT(d.face_valid_until) }) : t('face.card.expired')),
    d.face_reject_reason ? h('div', { class: 'hint bad' }, t('ver.rejected', { reason: d.face_reject_reason })) : null,
    d.verification_pending?.kind === 'face' ? h('div', { class: 'hint' }, t('face.pending'))
      : (soon || d.face_reject_reason) ? h('button', { class: 'btn primary block', onclick: () => driverVerification('face') }, t('face.go')) : null));
  every(60000, () => { if (currentPath() === '/drive') route(); });

  /* текущая поездка */
  const ad = S.activeDrive;
  if (ad) {
    const nav = (p) => h('a', { class: 'btn small', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving` }, t('drv.nav'));
    const act = (path, key, cls = 'primary') => { const b = h('button', { class: `btn ${cls} block` }, t(key)); b.onclick = guard(b, async () => { const r = await api('POST', `/api/rides/${ad.id}/${path}`); S.activeDrive = r.ride; route(); }); return b; };
    const rel = h('button', { class: 'btn danger block' }, t('drv.release'));
    rel.onclick = guard(rel, async () => { await api('POST', `/api/rides/${ad.id}/cancel`, {}); S.activeDrive = null; route(); });
    drive.append(h('div', { class: 'card col', style: 'border-color:var(--yellow);border-width:2px' },
      h('div', { class: 'row between' }, h('b', null, t('drv.current')), h('span', { class: 'pill' }, t('st.' + ad.status))),
      h('div', { class: 'row between' }, h('span', null, `${ad.passenger.name} · ${ratingText(ad.passenger.rating, ad.passenger.rating_count)}`), h('a', { class: 'btn small', href: `tel:${ad.passenger.phone}` }, t('ride.call'))),
      h('div', { class: 'addr' }, h('span', { class: 'dot a' }), ad.pickup.addr), h('div', { class: 'addr' }, h('span', { class: 'dot b' }), ad.drop.addr),
      ad.comment ? h('div', { class: 'hint' }, ad.comment) : null,
      h('div', { class: 'row between' }, h('span', { class: 'muted' }, t('drv.cash.get')), h('span', { class: 'price', style: 'font-size:24px' }, money(ad.price))),
      ad.status === 'in_progress' ? nav(ad.drop) : nav(ad.pickup),
      ad.status === 'accepted' ? act('arrived', 'drv.arrived') : null,
      ad.status === 'arrived' ? act('start', 'drv.start') : null,
      ad.status === 'in_progress' ? act('complete', 'drv.complete') : null,
      ['accepted', 'arrived'].includes(ad.status) ? rel : null));
  }

  /* заказы */
  renderOffers = () => {
    if (!d.online || S.activeDrive) { offersBox.replaceChildren(); return; }
    offersBox.replaceChildren(h('h3', null, t('drv.offers')),
      ...(S.offers.length ? S.offers.map((o) => {
        const b = h('button', { class: 'btn primary block' }, t('drv.accept', { price: money(o.price) }));
        b.onclick = guard(b, async () => { try { const r = await api('POST', `/api/rides/${o.id}/accept`); S.activeDrive = r.ride; S.offers = []; route(); } catch (e) { S.offers = S.offers.filter((x) => x.id !== o.id); renderOffers(); throw e; } });
        return h('div', { class: 'card col' },
          h('div', { class: 'row between' }, h('span', { class: 'pill' }, t('cls.' + o.car_class)), h('span', { class: 'price', style: 'font-size:20px' }, money(o.price))),
          h('div', { class: 'addr' }, h('span', { class: 'dot a' }), o.pickup.addr), h('div', { class: 'addr' }, h('span', { class: 'dot b' }), o.drop.addr),
          h('div', { class: 'muted small' }, t('drv.offer.meta', { km: o.distance_km, min: o.duration_min, to: o.to_pickup_km ?? '—' })),
          o.comment ? h('div', { class: 'hint' }, o.comment) : null, b);
      }) : [h('div', { class: 'card center muted' }, t('drv.offers.none'))]));
  };
  renderOffers();
  if (d.online) every(10000, async () => { try { S.offers = (await api('GET', '/api/driver/offers')).offers; renderOffers(); } catch { /* повторим */ } });

  /* статистика */
  api('GET', '/api/driver/stats').then((s) => {
    statsBox.replaceChildren(...[['today', 'stat.today'], ['week', 'stat.week'], ['month', 'stat.month']].map(([k, tk]) =>
      h('div', { class: 'kpi' }, h('span', null, t(tk)), h('b', null, money(s[k].earned)), h('span', null, t('stat.rides', { n: s[k].rides })))));
  }).catch(() => {});
}

boot();
