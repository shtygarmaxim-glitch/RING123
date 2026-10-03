"use strict";
/* Раздача статики со сжатием (brotli/gzip) и кэшированием в памяти.
   Без зависимостей: только встроенные fs/path/zlib.
   - html/js/css/json/svg > 1 КБ отдаются сжатыми (обычно в 4–6 раз меньше трафика и CPU на отдачу);
   - сжатие делается один раз (лениво, при первом запросе) и хранится в памяти;
   - ETag + 304: браузер проверяет версию, но не качает файл заново;
   - если файл на диске изменился — кэш обновится сам (проверка mtime не чаще раза в 10 сек).
   Всё остальное (картинки, mp3) отдаётся обычным express.static. */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};
const MIN_COMPRESS = 1024;

function createCompressedStatic(rootDir, { recheckMs = 10000 } = {}) {
  const root = path.resolve(rootDir);
  const cache = new Map(); // abs path -> entry

  function loadEntry(abs) {
    const now = Date.now();
    let e = cache.get(abs);
    if (e && now - e.checkedAt < recheckMs) return e;
    let st;
    try { st = fs.statSync(abs); } catch { cache.delete(abs); return null; }
    if (!st.isFile()) return null;
    if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) { e.checkedAt = now; return e; }
    const raw = fs.readFileSync(abs);
    e = {
      raw, mtimeMs: st.mtimeMs, size: st.size, checkedAt: now,
      etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      type: TYPES[path.extname(abs).toLowerCase()],
      br: null, gz: null
    };
    cache.set(abs, e);
    return e;
  }

  function variant(e, enc) {
    if (enc === "br") {
      if (!e.br) e.br = new Promise(res => zlib.brotliCompress(e.raw, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: e.raw.length }
      }, (err, buf) => res(err ? null : buf)));
      return e.br;
    }
    if (!e.gz) e.gz = new Promise(res => zlib.gzip(e.raw, { level: 9 }, (err, buf) => res(err ? null : buf)));
    return e.gz;
  }

  // Возвращает true, если ответ отправлен; false — пусть отдаёт кто-то другой.
  async function send(req, res, relPath) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let rel;
    try { rel = decodeURIComponent(relPath); } catch { return false; }
    if (rel.includes("\0")) return false;
    if (rel === "/" || rel === "") rel = "/index.html";
    const abs = path.join(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return false;
    if (!TYPES[path.extname(abs).toLowerCase()]) return false;
    const e = loadEntry(abs);
    if (!e) return false;

    const ext = path.extname(abs).toLowerCase();
    res.setHeader("Content-Type", e.type);
    res.setHeader("ETag", e.etag);
    res.setHeader("Vary", "Accept-Encoding");
    // svg-иконки меняются редко — можно кэшировать на сутки; код и стили всегда сверяем по ETag.
    res.setHeader("Cache-Control", ext === ".svg" ? "public, max-age=86400" : "no-cache");
    if (req.headers["if-none-match"] === e.etag) { res.statusCode = 304; res.end(); return true; }

    let body = e.raw, enc = null;
    if (e.raw.length >= MIN_COMPRESS) {
      const accept = String(req.headers["accept-encoding"] || "");
      const want = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
      if (want) {
        const buf = await variant(e, want === "br" ? "br" : "gz");
        if (buf) { body = buf; enc = want; }
      }
    }
    if (enc) res.setHeader("Content-Encoding", enc);
    res.setHeader("Content-Length", body.length);
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }

  function middleware(req, res, next) {
    send(req, res, req.path || String(req.url || "/").split("?")[0]).then(done => { if (!done) next(); }, () => next());
  }
  return { middleware, send };
}

module.exports = { createCompressedStatic };
