#!/usr/bin/env node
// Descarga los datos de iptv-org, verifica cada stream y genera
// public/data/channels.json solo con los canales accesibles.
//
// Uso: node scripts/build.mjs [--limit N] [--concurrency N] [--timeout MS]
//                             [--iptv-dir RUTA] [--no-check]
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const LIMIT = Number(opt('limit', 0));
const CONCURRENCY = Number(opt('concurrency', 64));
const TIMEOUT = Number(opt('timeout', 12000));
const IPTV_DIR = opt('iptv-dir', '');
const NO_CHECK = args.includes('--no-check');

const API_MIRRORS = [
  'https://iptv-org.github.io/api',
  'https://raw.githubusercontent.com/iptv-org/api/gh-pages',
];
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchApi(name) {
  let lastErr;
  for (const base of API_MIRRORS) {
    try {
      const res = await fetch(`${base}/${name}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.warn(`  ${base}/${name}.json falló: ${e.message}`);
    }
  }
  throw lastErr;
}

// Mapa url -> país usando los nombres de archivo de iptv-org/iptv/streams
// (ej. "ar.m3u", "us_pluto.m3u"). Sirve para los streams sin canal asociado.
async function loadPlaylistCountries(dir) {
  const map = new Map();
  const streamsDir = path.join(dir, 'streams');
  if (!dir || !existsSync(streamsDir)) return map;
  for (const file of await readdir(streamsDir)) {
    if (!file.endsWith('.m3u')) continue;
    const code = file.split(/[_.]/)[0].toUpperCase();
    const text = await readFile(path.join(streamsDir, file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (l && !l.startsWith('#')) map.set(l, code === 'UK' ? 'GB' : code);
    }
  }
  return map;
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

async function readHead(res, maxBytes = 256 * 1024) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function request(url, stream) {
  const headers = { 'User-Agent': stream.user_agent || DEFAULT_UA, Origin: 'https://example.org' };
  if (stream.referrer) headers.Referer = stream.referrer;
  return fetch(url, { headers, redirect: 'follow', signal: timeoutSignal(TIMEOUT) });
}

// Devuelve { ok, cors, reason }
export async function checkStream(stream) {
  try {
    const res = await request(stream.url, stream);
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const cors = res.headers.get('access-control-allow-origin') != null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const isHls = /\.m3u8?(\?|$)/i.test(stream.url) || type.includes('mpegurl');
    if (!isHls) {
      res.body?.cancel().catch(() => {});
      return { ok: true, cors };
    }
    const body = await readHead(res);
    if (!body.trimStart().startsWith('#EXTM3U')) return { ok: false, reason: 'no es m3u8' };

    // Lista maestra: comprobar que la primera variante también responde.
    if (body.includes('#EXT-X-STREAM-INF')) {
      const lines = body.split(/\r?\n/);
      const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
      const variant = lines.slice(idx + 1).find((l) => l.trim() && !l.startsWith('#'));
      if (variant) {
        const vUrl = new URL(variant.trim(), res.url).href;
        const vRes = await request(vUrl, stream);
        const vBody = vRes.ok ? await readHead(vRes, 64 * 1024) : '';
        if (!vRes.ok) return { ok: false, reason: `variante HTTP ${vRes.status}` };
        if (!vBody.trimStart().startsWith('#EXTM3U')) return { ok: false, reason: 'variante inválida' };
      }
    } else if (!body.includes('#EXTINF') && !body.includes('#EXT-X-TARGETDURATION')) {
      return { ok: false, reason: 'lista vacía' };
    }
    return { ok: true, cors };
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message };
  }
}

async function runPool(items, worker, concurrency) {
  let next = 0;
  let done = 0;
  const results = new Array(items.length);
  const t0 = Date.now();
  async function loop() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
      if (++done % 250 === 0 || done === items.length) {
        const s = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  verificados ${done}/${items.length} (${s}s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, loop));
  return results;
}

async function main() {
  console.log('Descargando datos de iptv-org…');
  const [channels, streams, countries, categories, logos] = await Promise.all(
    ['channels', 'streams', 'countries', 'categories', 'logos'].map(fetchApi),
  );
  const playlistCountry = await loadPlaylistCountries(IPTV_DIR);
  if (playlistCountry.size) console.log(`  ${playlistCountry.size} URLs con país desde iptv-org/iptv`);

  const channelById = new Map(channels.map((c) => [c.id, c]));
  const logoByChannel = new Map();
  for (const l of logos) {
    if (l.feed || !l.in_use) continue;
    const prev = logoByChannel.get(l.channel);
    // Preferimos logos más anchos (normalmente mejor calidad).
    if (!prev || (l.width || 0) > (prev.width || 0)) logoByChannel.set(l.channel, l);
  }

  let candidates = streams.filter((s) => {
    const ch = s.channel && channelById.get(s.channel);
    if (ch?.is_nsfw || ch?.categories?.includes('xxx')) return false;
    if (ch?.closed) return false;
    return /^https?:\/\//i.test(s.url);
  });
  // Eliminar URLs duplicadas
  const seen = new Set();
  candidates = candidates.filter((s) => !seen.has(s.url) && seen.add(s.url));
  if (LIMIT) candidates = candidates.slice(0, LIMIT);

  console.log(`Verificando ${candidates.length} streams (concurrencia ${CONCURRENCY}, timeout ${TIMEOUT}ms)…`);
  const checks = NO_CHECK
    ? candidates.map(() => ({ ok: true, cors: true }))
    : await runPool(candidates, checkStream, CONCURRENCY);

  const reasons = {};
  const out = new Map(); // key -> canal
  candidates.forEach((s, i) => {
    const r = checks[i];
    if (!r.ok) {
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      return;
    }
    const ch = s.channel ? channelById.get(s.channel) : null;
    const key = ch ? ch.id : `url:${s.url}`;
    let entry = out.get(key);
    if (!entry) {
      entry = {
        id: key,
        name: ch?.name || s.title || 'Sin nombre',
        country: ch?.country || playlistCountry.get(s.url) || 'XX',
        categories: ch?.categories?.length ? ch.categories : ['undefined'],
        logo: (ch && logoByChannel.get(ch.id)?.url) || null,
        website: ch?.website || null,
        streams: [],
      };
      out.set(key, entry);
    }
    const st = { url: s.url, cors: r.cors };
    if (s.title && s.title !== entry.name) st.title = s.title;
    if (s.quality) st.quality = s.quality;
    if (s.labels?.length) st.labels = s.labels;
    if (s.user_agent) st.user_agent = s.user_agent;
    if (s.referrer) st.referrer = s.referrer;
    entry.streams.push(st);
  });

  const qualityNum = (q) => parseInt(q, 10) || 0;
  const result = [...out.values()];
  for (const c of result) {
    // Primero los compatibles con navegador (https + CORS) y de mayor calidad.
    c.streams.sort(
      (a, b) =>
        Number(b.cors && b.url.startsWith('https:')) - Number(a.cors && a.url.startsWith('https:')) ||
        qualityNum(b.quality) - qualityNum(a.quality),
    );
  }
  result.sort((a, b) => a.name.localeCompare(b.name));

  const usedCountries = new Set(result.map((c) => c.country));
  const usedCats = new Set(result.flatMap((c) => c.categories));
  const meta = {
    updated: new Date().toISOString(),
    checked: candidates.length,
    working: checks.filter((r) => r.ok).length,
    removed: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    countries: [
      ...countries.filter((c) => usedCountries.has(c.code)).map(({ code, name, flag }) => ({ code, name, flag })),
      ...(usedCountries.has('XX') ? [{ code: 'XX', name: 'Desconocido / Internacional', flag: '🌐' }] : []),
    ],
    categories: [
      ...categories.filter((c) => usedCats.has(c.id)).map(({ id, name }) => ({ id, name })),
      ...(usedCats.has('undefined') ? [{ id: 'undefined', name: 'Sin categoría' }] : []),
    ],
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'channels.json'), JSON.stringify({ meta, channels: result }));
  await writeFile(path.join(OUT_DIR, 'playlist.m3u'), toM3u(result, meta));
  console.log(
    `Listo: ${meta.working}/${meta.checked} streams funcionan → ${result.length} canales en ${meta.countries.length} países.`,
  );
  console.log('Motivos de eliminación:', meta.removed);
}

function toM3u(channels, meta) {
  const country = new Map(meta.countries.map((c) => [c.code, c.name]));
  const cat = new Map(meta.categories.map((c) => [c.id, c.name]));
  const lines = ['#EXTM3U'];
  for (const c of channels) {
    for (const s of c.streams) {
      const group = `${country.get(c.country) || c.country};${cat.get(c.categories[0]) || c.categories[0]}`;
      const logo = c.logo ? ` tvg-logo="${c.logo}"` : '';
      const ua = s.user_agent ? ` http-user-agent="${s.user_agent}"` : '';
      const ref = s.referrer ? ` http-referrer="${s.referrer}"` : '';
      const q = s.quality ? ` (${s.quality})` : '';
      lines.push(`#EXTINF:-1 tvg-id="${c.id}" tvg-country="${c.country}"${logo}${ua}${ref} group-title="${group}",${c.name}${q}`);
      if (s.referrer) lines.push(`#EXTVLCOPT:http-referrer=${s.referrer}`);
      if (s.user_agent) lines.push(`#EXTVLCOPT:http-user-agent=${s.user_agent}`);
      lines.push(s.url);
    }
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
