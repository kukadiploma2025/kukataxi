import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import { sha256, parseCookies } from './security.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export class HttpError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

export function clientIp(req) {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie || '').kuka_session;
  if (!token || token.length > 100) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
    .get(sha256(token), Date.now());
  return row && !row.blocked ? row : null;
}

export class App {
  constructor() { this.routes = []; }
  route(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, rx, keys, opts: { auth: 'none', maxBody: 64 * 1024, ...opts }, handler });
  }
  get(p, o, h) { this.route('GET', p, o, h); }
  post(p, o, h) { this.route('POST', p, o, h); }
  patch(p, o, h) { this.route('PATCH', p, o, h); }
  put(p, o, h) { this.route('PUT', p, o, h); }

  async handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await this.api(req, res, url);
      return this.static(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return this.json(res, e.status, { error: e.code, ...e.extra });
      console.error('Unhandled error:', e?.message);
      return this.json(res, 500, { error: 'server_error' });
    }
  }

  json(res, status, obj, headers = {}) {
    if (res.headersSent) return;
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  async api(req, res, url) {
    const method = req.method;
    let matched = null;
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.rx.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found');
    const { r, params } = matched;

    const user = sessionUser(req);
    if (r.opts.auth !== 'none' && !user) throw new HttpError(401, 'unauthorized');
    if (r.opts.auth === 'admin' && !user.is_admin) throw new HttpError(403, 'forbidden');

    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      // Защита от CSRF: кастомный заголовок нельзя отправить с чужого сайта без CORS-разрешения.
      if (req.headers['x-kuka'] !== '1') throw new HttpError(403, 'csrf');
      const raw = await readBody(req, r.opts.maxBody);
      if (raw.length) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'json_required');
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'bad_json'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json');
      }
    }

    const ctx = {
      req, res, user, params, body,
      query: Object.fromEntries(url.searchParams),
      ip: clientIp(req),
      json: (status, obj, headers) => this.json(res, status, obj, headers),
      raw: false,
    };
    const result = await r.handler(ctx);
    if (ctx.raw || res.headersSent) return; // обработчик ответил сам (SSE, картинки)
    this.json(res, 200, result ?? { ok: true });
  }

  static(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    if (p === '/admin') p = '/admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': config.isProd ? 'public, max-age=300' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  listen() {
    return http.createServer((req, res) => this.handle(req, res));
  }
}
