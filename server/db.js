import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'ru',
  is_admin INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drivers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  city TEXT NOT NULL DEFAULT '',
  car_make TEXT NOT NULL,
  car_model TEXT NOT NULL,
  car_year INTEGER NOT NULL,
  car_color TEXT NOT NULL,
  plate TEXT NOT NULL,
  car_class TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | pending | approved | rejected | suspended
  reject_reason TEXT NOT NULL DEFAULT '',
  face_reject_reason TEXT NOT NULL DEFAULT '',
  approved_at INTEGER,
  face_valid_until INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0,
  lat REAL, lng REAL, loc_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passenger_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL,                      -- searching | accepted | arrived | in_progress | completed | cancelled | expired
  pickup_addr TEXT NOT NULL, pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL,
  drop_addr TEXT NOT NULL, drop_lat REAL NOT NULL, drop_lng REAL NOT NULL,
  distance_km REAL NOT NULL,
  duration_min REAL NOT NULL,
  car_class TEXT NOT NULL,
  price INTEGER NOT NULL,
  boost INTEGER NOT NULL DEFAULT 0,
  payment TEXT NOT NULL DEFAULT 'cash',
  comment TEXT NOT NULL DEFAULT '',
  commission_percent REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER, arrived_at INTEGER, started_at INTEGER, finished_at INTEGER,
  cancel_by TEXT, cancel_reason TEXT,
  rating_for_driver INTEGER, comment_for_driver TEXT,
  rating_for_passenger INTEGER, comment_for_passenger TEXT
);
CREATE INDEX IF NOT EXISTS idx_rides_passenger ON rides(passenger_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Журнал решений по верификации. Фото и документы здесь НЕ хранятся, только факт решения.
CREATE TABLE IF NOT EXISTS verification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                        -- registration | face
  decision TEXT NOT NULL,                    -- approved | rejected
  reason TEXT NOT NULL DEFAULT '',
  admin_id INTEGER NOT NULL,
  valid_until INTEGER,
  decided_at INTEGER NOT NULL
);
`);

export const DEFAULTS = {
  face_check_hours: 34,
  commission_percent: 0,
  offer_radius_km: 10,
  verification_ttl_hours: 12,
  // Стартовые тарифы-заглушки, их нужно подогнать под ваш рынок в админ-панели.
  tariffs: {
    economy: { base: 400, per_km: 90, per_min: 10, min: 700 },
    comfort: { base: 550, per_km: 115, per_min: 13, min: 900 },
    business: { base: 800, per_km: 160, per_min: 18, min: 1400 },
    minivan: { base: 650, per_km: 135, per_min: 15, min: 1100 },
  },
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : DEFAULTS[key];
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

export function ratingFor(userId, as) {
  const sql = as === 'driver'
    ? 'SELECT AVG(rating_for_driver) a, COUNT(rating_for_driver) c FROM rides WHERE driver_id=?'
    : 'SELECT AVG(rating_for_passenger) a, COUNT(rating_for_passenger) c FROM rides WHERE passenger_id=?';
  const r = db.prepare(sql).get(userId);
  return { rating: r.c ? Math.round(r.a * 10) / 10 : null, count: r.c };
}
