// Prueba la lógica de verificación contra un servidor HTTP local.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkStream, applyGeoRule } from '../scripts/build.mjs';

let server;
let base;
const routes = {
  '/ok.m3u8': [200, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n', true],
  '/master.m3u8': [200, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant/ok.m3u8\n', true],
  '/variant/ok.m3u8': [200, '#EXTM3U\n#EXTINF:6,\nseg.ts\n', true],
  '/broken-master.m3u8': [200, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmissing.m3u8\n', true],
  '/html.m3u8': [200, '<html>nope</html>', false],
  '/nocors.m3u8': [200, '#EXTM3U\n#EXTINF:6,\nseg.ts\n', false],
  '/needs-ref.m3u8': [200, '#EXTM3U\n#EXTINF:6,\nseg.ts\n', true],
};

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/slow.m3u8') return; // nunca responde
    if (req.url === '/needs-ref.m3u8' && req.headers.referer !== 'https://ref.example/') {
      res.writeHead(403).end();
      return;
    }
    const r = routes[req.url];
    if (!r) return res.writeHead(404).end();
    const h = { 'content-type': 'application/vnd.apple.mpegurl' };
    if (r[2]) h['access-control-allow-origin'] = '*';
    res.writeHead(r[0], h).end(r[1]);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const check = (p, extra = {}) => checkStream({ url: base + p, ...extra });

test('stream válido con CORS', async () => assert.deepEqual(await check('/ok.m3u8'), { ok: true, cors: true }));
test('lista maestra con variante válida', async () => assert.equal((await check('/master.m3u8')).ok, true));
test('lista maestra con variante rota', async () => assert.equal((await check('/broken-master.m3u8')).ok, false));
test('404', async () => assert.deepEqual(await check('/nope.m3u8'), { ok: false, reason: 'HTTP 404' }));
test('contenido que no es m3u8', async () => assert.equal((await check('/html.m3u8')).ok, false));
test('sin CORS se marca', async () => assert.deepEqual(await check('/nocors.m3u8'), { ok: true, cors: false }));
test('envía referrer', async () => {
  assert.equal((await check('/needs-ref.m3u8')).ok, false);
  assert.equal((await check('/needs-ref.m3u8', { referrer: 'https://ref.example/' })).ok, true);
});

test('geo-bloqueado con 403 se conserva; sin etiqueta se elimina', () => {
  const fail403 = { ok: false, reason: 'HTTP 403' };
  assert.equal(applyGeoRule({ labels: ['Geo-blocked'] }, fail403).ok, true);
  assert.equal(applyGeoRule({ labels: [] }, fail403).ok, false);
  assert.equal(applyGeoRule({ labels: ['Geo-blocked'] }, { ok: false, reason: 'ENOTFOUND' }).ok, false);
});
test('timeout', async () => {
  const r = await checkStream({ url: base + '/slow.m3u8' });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
});
