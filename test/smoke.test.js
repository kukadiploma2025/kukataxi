import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.DEV_EXPOSE_CODE = '1';
process.env.ADMIN_PHONES = '+77010000000';
process.env.OSRM_URL = 'http://127.0.0.1:9';

let server, base;
before(async () => {
  const m = await import('../server/index.js');
  server = m.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-KUKA': '1', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), res };
  }
  async login(phone, name) {
    const r = await this.call('POST', '/api/auth/request', { phone });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = await this.call('POST', '/api/auth/verify', { phone, code: r.body.dev_code, name });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return v.body.user;
  }
}

const jpeg = () => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12000, 7)]).toString('base64');
const imgs = (keys) => Object.fromEntries(keys.map((k) => [k, jpeg()]));
const ASTANA = { addr: 'Байтерек, Астана', lat: 51.1283, lng: 71.4305 };
const KHAN = { addr: 'Хан Шатыр, Астана', lat: 51.1327, lng: 71.4035 };

test('безопасность: без заголовка и без входа нельзя', async () => {
  const c = new Client();
  assert.equal((await c.call('GET', '/api/me')).status, 401);
  assert.equal((await c.call('POST', '/api/auth/request', { phone: '+77011234567' }, { 'X-KUKA': '0' })).status, 403);
  assert.equal((await c.call('POST', '/api/auth/request', { phone: '12345' })).status, 400);
  assert.equal((await c.call('POST', '/api/auth/request', { phone: '+79161234567' })).status, 400, 'только номера Казахстана');
});

test('код: неверный код, лимит попыток, повторный запрос только через минуту', async () => {
  const c = new Client();
  const r = await c.call('POST', '/api/auth/request', { phone: '8 701 555 00 11' });
  assert.equal(r.status, 200);
  assert.equal(r.body.new_user, true);
  const again = await c.call('POST', '/api/auth/request', { phone: '+77015550011' });
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'cooldown');
  const wrong = await c.call('POST', '/api/auth/verify', { phone: '+77015550011', code: '000000', name: 'Тест' });
  assert.ok([400].includes(wrong.status) || r.body.dev_code === '000000');
  const noName = await c.call('POST', '/api/auth/verify', { phone: '+77015550011', code: r.body.dev_code });
  assert.equal(noName.body.error, 'name_required');
  const ok = await c.call('POST', '/api/auth/verify', { phone: '+77015550011', code: r.body.dev_code, name: 'Алия' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'Алия');
  const reuse = await c.call('POST', '/api/auth/verify', { phone: '+77015550011', code: r.body.dev_code });
  assert.equal(reuse.status, 400, 'код одноразовый');
  assert.equal((await c.call('GET', '/api/me')).body.user.phone, '+77015550011');
});

test('полный цикл: водитель, проверка админом, поездка, рейтинг, проверка лица', async () => {
  const pass = new Client(), drv = new Client(), adm = new Client();
  await pass.login('+77020000001', 'Айгерим');
  await drv.login('+77020000002', 'Ерлан Сериков');
  const admin = await adm.login('+77010000000', 'Админ');
  assert.equal(admin.is_admin, true);

  // водитель без допуска не выходит на линию
  const car = { city: 'Астана', car_make: 'Toyota', car_model: 'Camry', car_year: 2019, car_color: 'белый', plate: '123ABC02', car_class: 'comfort' };
  assert.equal((await drv.call('POST', '/api/driver/apply', car)).status, 200);
  assert.equal((await drv.call('POST', '/api/driver/online', { online: true, lat: 51.13, lng: 71.43 })).body.error, 'not_approved');

  // верификация: без согласия и с неполным набором фото нельзя
  const regKeys = (await drv.call('GET', '/api/driver/verification')).body.required.registration;
  assert.equal((await drv.call('POST', '/api/driver/verification', { kind: 'registration', images: imgs(regKeys) })).body.error, 'consent_required');
  assert.equal((await drv.call('POST', '/api/driver/verification', { kind: 'registration', consent: true, images: imgs(regKeys.slice(1)) })).body.error, 'bad_image');
  const sub = await drv.call('POST', '/api/driver/verification', { kind: 'registration', consent: true, images: imgs(regKeys) });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.driver.status, 'pending');

  // обычный пользователь не видит очередь
  assert.equal((await pass.call('GET', '/api/admin/verifications')).status, 403);
  const q = await adm.call('GET', '/api/admin/verifications');
  assert.equal(q.body.items.length, 1);
  const item = q.body.items[0];
  assert.equal(item.driver.plate, '123ABC02');
  assert.match(item.challenge, /^\d{4}$/);
  const img = await adm.call('GET', `/api/admin/verifications/${item.id}/image/id_front`);
  assert.equal(img.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/jpeg');
  assert.match(img.res.headers.get('cache-control'), /no-store/);

  // отказ требует причину, затем одобрение
  assert.equal((await adm.call('POST', `/api/admin/verifications/${item.id}/decision`, { approve: false })).body.error, 'reason_required');
  const ok = await adm.call('POST', `/api/admin/verifications/${item.id}/decision`, { approve: true });
  assert.equal(ok.body.driver.status, 'approved');
  // после решения фото исчезли из памяти
  assert.equal((await adm.call('GET', `/api/admin/verifications/${item.id}/image/id_front`)).status, 404);
  assert.equal((await adm.call('GET', '/api/admin/verifications')).body.items.length, 0);
  const until = ok.body.driver.face_valid_until;
  assert.ok(Math.abs(until - Date.now() - 34 * 3600_000) < 5000, 'проверка лица действует 34 часа');

  // на линию
  const on = await drv.call('POST', '/api/driver/online', { online: true, lat: 51.131, lng: 71.428 });
  assert.equal(on.status, 200);
  assert.equal(on.body.driver.online, true);

  // расчёт и заказ
  const quote = await pass.call('POST', '/api/quote', { pickup: ASTANA, drop: KHAN });
  assert.equal(quote.status, 200);
  assert.ok(quote.body.prices.economy >= 700 && quote.body.prices.business > quote.body.prices.economy);
  assert.equal((await pass.call('POST', '/api/rides', { pickup: ASTANA, drop: KHAN, car_class: 'business' })).status, 200);
  assert.equal((await pass.call('POST', '/api/rides', { pickup: ASTANA, drop: KHAN, car_class: 'economy' })).body.error, 'active_ride_exists');
  // у водителя comfort: заказ business ему не виден, пассажир отменяет и заказывает comfort
  assert.equal((await drv.call('GET', '/api/driver/offers')).body.offers.length, 0);
  const act = (await pass.call('GET', '/api/rides/active')).body.ride;
  assert.equal((await pass.call('POST', `/api/rides/${act.id}/cancel`, {})).status, 200);
  const created = await pass.call('POST', '/api/rides', { pickup: ASTANA, drop: KHAN, car_class: 'comfort', boost: 100, comment: 'Подъезд 2' });
  assert.equal(created.status, 200);
  const rideId = created.body.ride.id;
  assert.equal(created.body.ride.payment, 'cash');
  const offers = (await drv.call('GET', '/api/driver/offers')).body.offers;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].price, created.body.ride.price);
  assert.equal(offers[0].passenger, undefined, 'до принятия данные пассажира скрыты');

  assert.equal((await drv.call('POST', `/api/rides/${rideId}/start`)).body.error, 'not_found');
  const acc = await drv.call('POST', `/api/rides/${rideId}/accept`);
  assert.equal(acc.body.ride.status, 'accepted');
  assert.equal(acc.body.ride.passenger.name, 'Айгерим');
  assert.equal((await adm.call('POST', `/api/rides/${rideId}/accept`)).status, 403);
  const pv = (await pass.call('GET', '/api/rides/active')).body.ride;
  assert.equal(pv.driver.plate, '123ABC02');
  assert.equal((await drv.call('POST', `/api/rides/${rideId}/arrived`)).body.ride.status, 'arrived');
  assert.equal((await drv.call('POST', `/api/rides/${rideId}/start`)).body.ride.status, 'in_progress');
  assert.equal((await pass.call('POST', `/api/rides/${rideId}/cancel`, {})).body.error, 'cannot_cancel');
  assert.equal((await drv.call('POST', `/api/rides/${rideId}/complete`)).body.ride.status, 'completed');

  // оценки
  assert.equal((await pass.call('POST', `/api/rides/${rideId}/rate`, { stars: 6 })).body.error, 'bad_stars');
  assert.equal((await pass.call('POST', `/api/rides/${rideId}/rate`, { stars: 5, comment: 'Отлично' })).status, 200);
  assert.equal((await pass.call('POST', `/api/rides/${rideId}/rate`, { stars: 1 })).body.error, 'already_rated');
  assert.equal((await drv.call('POST', `/api/rides/${rideId}/rate`, { stars: 4 })).status, 200);
  const me = (await drv.call('GET', '/api/me')).body;
  assert.equal(me.driver.rating, 5);
  assert.equal((await pass.call('GET', '/api/me')).body.user.rating, 4);

  // кабинет: история и заработок без комиссии
  const hist = await pass.call('GET', '/api/rides');
  assert.equal(hist.body.rides.length, 2);
  const stats = (await drv.call('GET', '/api/driver/stats')).body;
  assert.equal(stats.today.rides, 1);
  assert.equal(stats.today.earned, created.body.ride.price, 'комиссия 0%: водитель получает всю сумму');
  assert.equal(stats.commission_percent, 0);

  // принудительная проверка лица: водитель уходит с линии, пока админ не одобрит
  assert.equal((await adm.call('POST', `/api/admin/drivers/${me.user.id}/face-reset`)).status, 200);
  assert.equal((await drv.call('POST', '/api/driver/online', { online: true, lat: 51.131, lng: 71.428 })).body.error, 'face_check_required');
  assert.equal((await drv.call('POST', '/api/driver/verification', { kind: 'face', consent: true, images: imgs(['selfie_with_id']) })).status, 200);
  const q2 = (await adm.call('GET', '/api/admin/verifications')).body.items;
  assert.equal(q2[0].kind, 'face');
  await adm.call('POST', `/api/admin/verifications/${q2[0].id}/decision`, { approve: true });
  assert.equal((await drv.call('POST', '/api/driver/online', { online: true, lat: 51.131, lng: 71.428 })).status, 200);

  // приостановка водителя
  await adm.call('POST', `/api/admin/drivers/${me.user.id}/status`, { status: 'suspended' });
  assert.equal((await drv.call('POST', '/api/driver/online', { online: true, lat: 51.131, lng: 71.428 })).body.error, 'not_approved');
});

test('два водителя: поездку принимает только один', async () => {
  const pass = new Client(), adm = new Client();
  await adm.login('+77010000000', 'Админ');
  await pass.login('+77020000010', 'Мадина');
  const drivers = [];
  for (let i = 0; i < 2; i++) {
    const d = new Client();
    await d.login(`+7702000002${i}`, `Водитель ${i}`);
    await d.call('POST', '/api/driver/apply', { city: 'Астана', car_make: 'Kia', car_model: 'Rio', car_year: 2018, car_color: 'серый', plate: `77${i}XYZ01`, car_class: 'economy' });
    await d.call('POST', '/api/driver/verification', { kind: 'registration', consent: true, images: imgs(['selfie_with_id', 'id_front', 'id_back', 'license_front', 'license_back', 'tech_passport', 'car_photo']) });
    drivers.push(d);
  }
  for (const it of (await adm.call('GET', '/api/admin/verifications')).body.items) await adm.call('POST', `/api/admin/verifications/${it.id}/decision`, { approve: true });
  for (const d of drivers) assert.equal((await d.call('POST', '/api/driver/online', { online: true, lat: 51.129, lng: 71.43 })).status, 200);
  const r = (await pass.call('POST', '/api/rides', { pickup: ASTANA, drop: KHAN, car_class: 'economy' })).body.ride;
  const results = await Promise.all(drivers.map((d) => d.call('POST', `/api/rides/${r.id}/accept`)));
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
});

test('админ-настройки и валидация', async () => {
  const adm = new Client();
  await adm.login('+77010000000', 'Админ');
  const s = (await adm.call('GET', '/api/admin/settings')).body;
  assert.equal(s.face_check_hours, 34);
  assert.equal(s.commission_percent, 0);
  assert.equal((await adm.call('PUT', '/api/admin/settings', { commission_percent: 99 })).body.error, 'bad_value');
  assert.equal((await adm.call('PUT', '/api/admin/settings', { face_check_hours: 24 })).status, 200);
  assert.equal((await adm.call('GET', '/api/admin/settings')).body.face_check_hours, 24);
  await adm.call('PUT', '/api/admin/settings', { face_check_hours: 34 });
});
