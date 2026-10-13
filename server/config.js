// Настройки читаются из переменных окружения (файл .env подхватывается автоматически).
try { process.loadEnvFile(); } catch { /* .env необязателен */ }
import crypto from 'node:crypto';

const env = process.env;
const flag = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  // Казахстан: +7 6xx / +7 7xx
  if (!/^7[67]\d{9}$/.test(d)) return null;
  return '+' + d;
}

const isProd = env.NODE_ENV === 'production';
if (isProd && (!env.APP_SECRET || env.APP_SECRET.length < 32)) {
  console.error('APP_SECRET обязателен в production (минимум 32 символа).');
  process.exit(1);
}

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  secret: env.APP_SECRET || crypto.randomBytes(32).toString('hex'),
  dbPath: env.DB_PATH || './data/kuka.db',
  trustProxy: flag(env.TRUST_PROXY),
  baseUrl: env.BASE_URL || '',
  contactEmail: env.CONTACT_EMAIL || 'admin@example.com',
  supportPhone: env.SUPPORT_PHONE || '',
  otp: {
    provider: env.OTP_PROVIDER || 'console', // console | greenapi | meta
    ttlMs: 5 * 60 * 1000,
    cooldownMs: 60 * 1000,
    maxAttempts: 5,
    // Только для разработки и тестов: вернуть код в ответе API. В production игнорируется.
    exposeDevCode: !isProd && flag(env.DEV_EXPOSE_CODE),
  },
  greenapi: {
    url: env.GREEN_API_URL || 'https://api.green-api.com',
    id: env.GREEN_ID || '',
    token: env.GREEN_TOKEN || '',
  },
  meta: {
    phoneNumberId: env.WA_PHONE_NUMBER_ID || '',
    token: env.WA_TOKEN || '',
    template: env.WA_TEMPLATE || 'kuka_otp',
    templateLang: env.WA_TEMPLATE_LANG || 'ru',
    version: env.WA_API_VERSION || 'v20.0',
  },
  adminPhones: (env.ADMIN_PHONES || '').split(',').map((s) => normalizePhone(s.trim())).filter(Boolean),
  geo: {
    nominatim: env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    osrm: env.OSRM_URL || 'https://router.project-osrm.org',
  },
};
