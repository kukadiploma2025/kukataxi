/* Админ-панель KUKA TAXI: ручная проверка водителей, список водителей, поездки, настройки. */
const root = document.getElementById('root');
// Пустые значения (null/false) не должны превращаться в текст "null".
for (const m of ['replaceChildren', 'append', 'prepend']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
}

const money = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₸`;
const fmt = (ms) => (ms ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms) : '—');

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'disabled', 'type', 'placeholder', 'id', 'inputMode', 'maxLength', 'rows', 'min', 'max', 'step'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const ERR = {
  unauthorized: 'Войдите снова.', forbidden: 'Нет прав администратора. Ваш номер должен быть в ADMIN_PHONES.', reason_required: 'Укажите причину отказа.',
  bad_value: 'Недопустимое значение.', wrong_code: 'Неверный код.', code_expired: 'Код устарел.', cooldown: 'Подождите перед повтором.', bad_phone: 'Введите казахстанский номер.',
  send_failed: 'Код не отправился в WhatsApp.', too_many_requests: 'Слишком много попыток.', not_found: 'Заявка уже обработана или удалена.', name_required: 'Укажите имя.',
};
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'X-KUKA': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* пусто */ }
  if (!res.ok) { const e = new Error(data?.error || 'generic'); e.code = data?.error || 'generic'; e.status = res.status; throw e; }
  return data;
}
const errMsg = (e) => ERR[e.code] || 'Ошибка: ' + e.code;
function toast(msg) { document.querySelector('.toast')?.remove(); const el = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(el); setTimeout(() => el.remove(), 3500); }

let es = null; let tab = 'queue'; let me = null; let queueSize = 0;

/* ---------- вход ---------- */
function login() {
  let phone = '';
  const box = h('div', { class: 'card col' });
  root.replaceChildren(h('div', { class: 'adm', style: 'max-width:480px' }, h('a', { class: 'logo', href: '/' }, 'KUKA', h('small', null, 'ADMIN')), box));
  const stepPhone = () => {
    const inp = h('input', { class: 'input', id: 'p', type: 'tel', inputMode: 'tel', placeholder: '701 234 56 78' });
    const err = h('div', { class: 'err', role: 'alert' });
    const btn = h('button', { class: 'btn primary block' }, 'Получить код в WhatsApp');
    btn.onclick = async () => {
      btn.disabled = true; err.textContent = '';
      let d = inp.value.replace(/\D/g, ''); if (d.length === 11 && /^[78]/.test(d)) d = d.slice(1); phone = '+7' + d;
      try { const r = await api('POST', '/api/auth/request', { phone }); stepCode(r.dev_code, r.new_user); }
      catch (e) { if (e.code === 'cooldown') stepCode(); else { err.textContent = errMsg(e); btn.disabled = false; } }
    };
    box.replaceChildren(h('h2', null, 'Вход администратора'), h('label', { class: 'f', for: 'p' }, 'Телефон', inp), err, btn);
    inp.focus();
  };
  const stepCode = (dev, isNew) => {
    const code = h('input', { class: 'input code-input', id: 'c', inputMode: 'numeric', maxLength: 6, autocomplete: 'one-time-code' });
    const name = isNew ? h('input', { class: 'input', placeholder: 'Ваше имя' }) : null;
    const err = h('div', { class: 'err', role: 'alert' });
    const btn = h('button', { class: 'btn primary block' }, 'Войти');
    btn.onclick = async () => {
      btn.disabled = true; err.textContent = '';
      try { await api('POST', '/api/auth/verify', { phone, code: code.value.trim(), name: name?.value.trim() }); start(); }
      catch (e) { err.textContent = errMsg(e); btn.disabled = false; }
    };
    box.replaceChildren(h('h2', null, 'Код из WhatsApp'), dev ? h('div', { class: 'hint warn' }, 'DEV: ' + dev) : null, name, h('label', { class: 'f', for: 'c' }, 'Код', code), err, btn);
    (name || code).focus();
  };
  stepPhone();
}

/* ---------- каркас ---------- */
const root2 = h('div', { class: 'adm' });
function frame(content) {
  const names = [['queue', `Очередь${queueSize ? ` (${queueSize})` : ''}`], ['drivers', 'Водители'], ['rides', 'Поездки'], ['settings', 'Настройки']];
  root.replaceChildren(h('div', { class: 'adm' },
    h('div', { class: 'row between wrap' }, h('a', { class: 'logo', href: '/' }, 'KUKA', h('small', null, 'ADMIN')),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, me?.name), h('button', { class: 'btn small', onclick: async () => { await api('POST', '/api/auth/logout', {}); es?.close(); login(); } }, 'Выйти'))),
    h('div', { class: 'tabs', role: 'tablist' }, names.map(([k, label]) => h('button', { class: 'btn small' + (tab === k ? ' on' : ''), role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; render(); } }, label))),
    content));
}

async function render() {
  const holder = h('div', { class: 'col' }, h('p', { class: 'muted' }, 'Загрузка…'));
  frame(holder);
  try {
    const view = await ({ queue: queueView, drivers: driversView, rides: ridesView, settings: settingsView }[tab])();
    holder.replaceChildren(view);
  } catch (e) { holder.replaceChildren(h('div', { class: 'hint bad' }, errMsg(e))); }
}

/* ---------- очередь проверки ---------- */
const CHECKS = {
  registration: [
    'Лицо на селфи совпадает с фото в удостоверении личности',
    'В кадре селфи виден лист с кодом, он совпадает с кодом ниже',
    'Удостоверение личности действительно, данные читаются',
    'Водительское удостоверение действительно и нужной категории (B)',
    'ФИО в правах совпадает с ФИО в удостоверении',
    'Техпаспорт: марка, модель и госномер совпадают с анкетой',
    'На фото автомобиля виден тот же госномер, авто в нормальном состоянии',
  ],
  face: ['Лицо совпадает с ранее проверенным водителем', 'В кадре виден лист с кодом, он совпадает с кодом ниже', 'Фото сделано сейчас, без маски, очков и фильтров'],
};
const LABEL = { selfie_with_id: 'Селфи с удостоверением', id_front: 'Удостоверение, лицо', id_back: 'Удостоверение, оборот', license_front: 'Права, лицо', license_back: 'Права, оборот', tech_passport: 'Техпаспорт', car_photo: 'Фото авто' };

let selected = null;
async function queueView() {
  const { items } = await api('GET', '/api/admin/verifications');
  queueSize = items.length;
  const wrap = h('div', { class: 'split' });
  const list = h('div', { class: 'col' });
  const detail = h('div', { class: 'card col' });
  if (!items.find((i) => i.id === selected)) selected = items[0]?.id || null;

  const showDetail = () => {
    const it = items.find((i) => i.id === selected);
    if (!it) { detail.replaceChildren(h('p', { class: 'muted center' }, 'Очередь пуста. Новые заявки появятся здесь сами.')); return; }
    const d = it.driver;
    const checks = CHECKS[it.kind].map((c, i) => h('label', null, h('input', { type: 'checkbox', class: 'chk' }), h('span', null, c)));
    const reason = h('textarea', { class: 'input', rows: 2, maxLength: 200, placeholder: 'Причина отказа (увидит водитель)' });
    const ok = h('button', { class: 'btn primary' }, it.kind === 'face' ? 'Лицо подтверждено' : 'Допустить к работе');
    const no = h('button', { class: 'btn danger' }, 'Отказать');
    const decide = (approve) => async (btn) => {
      if (approve && ![...detail.querySelectorAll('.chk')].every((c) => c.checked)) return toast('Отметьте все пункты проверки');
      btn.disabled = true;
      try { await api('POST', `/api/admin/verifications/${it.id}/decision`, { approve, reason: reason.value.trim() }); toast(approve ? 'Допущен' : 'Отказ отправлен'); render(); }
      catch (e) { toast(errMsg(e)); btn.disabled = false; if (e.code === 'not_found') render(); }
    };
    ok.onclick = () => decide(true)(ok); no.onclick = () => decide(false)(no);
    detail.replaceChildren(
      h('div', { class: 'row between wrap' }, h('h2', null, d.name || 'Водитель'), h('span', { class: 'pill ' + (it.kind === 'face' ? 'warn' : '') }, it.kind === 'face' ? 'Проверка лица' : 'Регистрация')),
      h('div', { class: 'muted' }, `${d.phone} · ${d.city || ''}`),
      h('div', null, `${d.car || ''} · `, h('span', { class: 'plate', style: 'font-size:14px' }, d.plate || ''), ` · класс: ${d.car_class || ''}`),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Код на листе:'), h('b', { class: 'price', style: 'font-size:28px;letter-spacing:.15em' }, it.challenge)),
      h('div', { class: 'photos' }, it.keys.map((k) => {
        const src = `/api/admin/verifications/${it.id}/image/${k}`;
        const img = h('img', { src, alt: LABEL[k], loading: 'lazy' });
        img.onclick = () => { const big = h('div', { class: 'big', onclick: () => big.remove() }, h('img', { src, alt: LABEL[k] })); document.body.append(big); };
        return h('figure', null, img, h('figcaption', null, LABEL[k]));
      })),
      h('div', { class: 'checks' }, checks),
      reason, h('div', { class: 'row wrap' }, ok, no),
      h('p', { class: 'muted small' }, 'После решения фото удаляются из памяти сервера. Запросить их повторно нельзя, водитель отправит новые.'));
  };

  const renderList = () => list.replaceChildren(...(items.length ? items.map((it) => h('button', { class: 'qitem', 'aria-pressed': String(it.id === selected), onclick: () => { selected = it.id; renderList(); showDetail(); } },
    h('b', null, it.driver.name || 'Водитель'), h('span', { class: 'muted small' }, `${it.kind === 'face' ? 'Проверка лица' : 'Регистрация'} · ${fmt(it.createdAt)}`), h('span', { class: 'muted small' }, it.driver.plate || ''))) : [h('div', { class: 'card muted center' }, 'Нет заявок')]));
  renderList(); showDetail();
  wrap.append(list, detail);
  return wrap;
}

/* ---------- водители ---------- */
async function driversView() {
  const { drivers } = await api('GET', '/api/admin/drivers');
  const stats = await api('GET', '/api/admin/stats');
  const kpi = (l, v) => h('div', { class: 'kpi' }, h('span', null, l), h('b', null, v));
  const act = (label, path, body, cls = '') => h('button', { class: 'btn small ' + cls, onclick: async (e) => { e.target.disabled = true; try { await api('POST', path, body); render(); } catch (er) { toast(errMsg(er)); e.target.disabled = false; } } }, label);
  const st = { draft: 'анкета', pending: 'на проверке', approved: 'допущен', rejected: 'отклонён', suspended: 'приостановлен' };
  return h('div', { class: 'col' },
    h('div', { class: 'kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(140px,1fr))' }, kpi('Пользователей', stats.users), kpi('Водителей допущено', stats.drivers_approved), kpi('Сейчас на линии', stats.drivers_online), kpi('Поездок сегодня', `${stats.rides_completed_today}/${stats.rides_today}`)),
    h('div', { class: 'card pad0 tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Водитель', 'Телефон', 'Авто', 'Статус', 'Лицо до', 'Рейтинг', 'Поездок', ''].map((x) => h('th', null, x)))),
      h('tbody', null, drivers.length ? drivers.map((d) => h('tr', null,
        h('td', null, d.name), h('td', null, d.phone), h('td', null, `${d.car_make} ${d.car_model} · ${d.plate}`),
        h('td', null, h('span', { class: 'pill ' + (d.status === 'approved' ? 'ok' : d.status === 'suspended' || d.status === 'rejected' ? 'bad' : 'warn') }, st[d.status] || d.status), d.online ? ' ' : '', d.online ? h('span', { class: 'pill ok' }, 'на линии') : null),
        h('td', null, d.face_valid_until ? fmt(d.face_valid_until) : '—'), h('td', null, d.rating ?? '—'), h('td', null, d.rides),
        h('td', null, h('div', { class: 'row gap8' },
          d.status === 'approved' ? act('Сверить лицо', `/api/admin/drivers/${d.id}/face-reset`, {}) : null,
          d.status === 'approved' ? act('Приостановить', `/api/admin/drivers/${d.id}/status`, { status: 'suspended' }, 'danger') : null,
          d.status === 'suspended' ? act('Вернуть доступ', `/api/admin/drivers/${d.id}/status`, { status: 'approved' }) : null)))) : [h('tr', null, h('td', { colspan: 8, class: 'muted' }, 'Водителей пока нет')) ]))));
}

/* ---------- поездки ---------- */
async function ridesView() {
  const { rides } = await api('GET', '/api/admin/rides');
  const st = { searching: 'поиск', accepted: 'едет', arrived: 'на месте', in_progress: 'в пути', completed: 'завершена', cancelled: 'отменена', expired: 'без водителя' };
  return h('div', { class: 'card pad0 tablewrap' }, h('table', null,
    h('thead', null, h('tr', null, ['№', 'Время', 'Пассажир', 'Водитель', 'Маршрут', 'Км', 'Цена', 'Статус', 'Оценки'].map((x) => h('th', null, x)))),
    h('tbody', null, rides.length ? rides.map((r) => h('tr', null, h('td', null, r.id), h('td', null, fmt(r.created_at)), h('td', null, r.passenger_name), h('td', null, r.driver_name || '—'),
      h('td', { style: 'white-space:normal;min-width:240px' }, `${r.pickup.addr} → ${r.drop.addr}`), h('td', null, r.distance_km), h('td', null, money(r.price)),
      h('td', null, h('span', { class: 'pill ' + (r.status === 'completed' ? 'ok' : ['cancelled', 'expired'].includes(r.status) ? 'bad' : '') }, st[r.status])),
      h('td', null, `${r.rating_for_driver ?? '·'} / ${r.rating_for_passenger ?? '·'}`))) : [h('tr', null, h('td', { colspan: 9, class: 'muted' }, 'Поездок пока нет'))])));
}

/* ---------- настройки ---------- */
async function settingsView() {
  const s = await api('GET', '/api/admin/settings');
  const num = (id, v, step = 1) => h('input', { class: 'input', id, type: 'number', value: v, step, min: 0 });
  const face = num('face', s.face_check_hours), com = num('com', s.commission_percent, 0.5), rad = num('rad', s.offer_radius_km);
  const names = { economy: 'Эконом', comfort: 'Комфорт', business: 'Бизнес', minivan: 'Минивэн' };
  const tf = {};
  const rows = Object.keys(names).map((c) => {
    tf[c] = { base: num('b' + c, s.tariffs[c].base), per_km: num('k' + c, s.tariffs[c].per_km), per_min: num('m' + c, s.tariffs[c].per_min), min: num('n' + c, s.tariffs[c].min) };
    return h('tr', null, h('td', null, names[c]), ...['base', 'per_km', 'per_min', 'min'].map((k) => h('td', null, tf[c][k])));
  });
  const save = h('button', { class: 'btn primary' }, 'Сохранить');
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api('PUT', '/api/admin/settings', {
        face_check_hours: Number(face.value), commission_percent: Number(com.value), offer_radius_km: Number(rad.value),
        tariffs: Object.fromEntries(Object.keys(names).map((c) => [c, Object.fromEntries(Object.entries(tf[c]).map(([k, el]) => [k, Number(el.value)]))])),
      });
      toast('Сохранено');
    } catch (e) { toast(errMsg(e)); }
    save.disabled = false;
  };
  return h('div', { class: 'col' },
    h('div', { class: 'card col' }, h('h3', null, 'Правила'),
      h('div', { class: 'grid3' }, h('label', { class: 'f', for: 'face' }, 'Проверка лица каждые, часов', face), h('label', { class: 'f', for: 'com' }, 'Комиссия с водителей, %', com), h('label', { class: 'f', for: 'rad' }, 'Радиус рассылки заказов, км', rad)),
      h('p', { class: 'muted small' }, 'Комиссия записывается в каждую новую поездку на момент заказа. Изменение не затрагивает уже созданные поездки.')),
    h('div', { class: 'card col' }, h('h3', null, 'Тарифы, ₸'),
      h('p', { class: 'muted small' }, 'Цена = посадка + км × цена за км + минуты × цена за минуту, но не меньше минимальной. Стартовые числа примерные, подгоните под ваш город.'),
      h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Класс', 'Посадка', 'За км', 'За минуту', 'Минимум'].map((x) => h('th', null, x)))), h('tbody', null, rows)))),
    save);
}

/* ---------- старт ---------- */
async function start() {
  try { me = (await api('GET', '/api/me')).user; } catch { return login(); }
  if (!me.is_admin) { root.replaceChildren(h('div', { class: 'adm', style: 'max-width:480px' }, h('div', { class: 'card col' }, h('h2', null, 'Нет доступа'), h('p', { class: 'muted' }, 'Этот номер не указан как администратор (ADMIN_PHONES).'), h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/auth/logout', {}); login(); } }, 'Выйти')))); return; }
  es?.close();
  es = new EventSource('/api/stream');
  es.addEventListener('queue', (e) => { try { queueSize = JSON.parse(e.data).size; } catch { /* ok */ } render(); });
  render();
}
start();
