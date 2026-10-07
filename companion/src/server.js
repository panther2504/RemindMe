'use strict';

const http = require('http');

const DEFAULT_PORT = 47321;
const MAX_BODY = 2 * 1024 * 1024;

/**
 * Local HTTP bridge used by the Chrome extension. Listens on 127.0.0.1 only.
 *
 * Access control: every request must come from a chrome-extension:// origin
 * (optionally restricted to specific extension IDs) and carry the
 * `X-RemindMe-Client` header. Web pages cannot forge the Origin header, and
 * the custom header forces a CORS preflight, so ordinary websites cannot read
 * or modify reminders.
 */
function createServer({ store, version, onTest, allowedExtensionIds = [] }) {
  function originAllowed(origin) {
    const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin || '');
    if (!m) return false;
    return allowedExtensionIds.length === 0 || allowedExtensionIds.includes(m[1]);
  }

  function send(res, status, body, origin) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Payload too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return send(res, 403, { error: 'Forbidden' });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-RemindMe-Client',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin',
      });
      return res.end();
    }
    if (!req.headers['x-remindme-client']) return send(res, 403, { error: 'Forbidden' }, origin);

    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(res, 200, { ok: true, app: 'remindme-companion', version }, origin);
      }
      if (req.method === 'GET' && url.pathname === '/api/reminders') {
        return send(res, 200, { reminders: store.all() }, origin);
      }
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const body = await readJson(req);
        if (!Array.isArray(body.reminders)) return send(res, 400, { error: 'reminders[] required' }, origin);
        return send(res, 200, { reminders: store.sync(body.reminders) }, origin);
      }
      if (req.method === 'POST' && url.pathname === '/api/test') {
        if (onTest) onTest();
        return send(res, 200, { ok: true }, origin);
      }
      return send(res, 404, { error: 'Not found' }, origin);
    } catch (err) {
      return send(res, err.status || 500, { error: err.message }, origin);
    }
  });

  return server;
}

module.exports = { createServer, DEFAULT_PORT };
