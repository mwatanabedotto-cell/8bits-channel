// Visor IPTV: carga data/channels.json (generado y verificado por scripts/build.mjs),
// lo agrupa por país / enfoque y elimina automáticamente en el navegador los
// streams que no se pueden reproducir.

const BROKEN_KEY = 'iptv.broken.v1';
const PREFS_KEY = 'iptv.prefs.v1';
const BROKEN_TTL = 3 * 24 * 3600 * 1000; // se reintenta a los 3 días
const PLAY_TIMEOUT = 20000;
const PAGE = 240;

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const state = {
  channels: [],
  countries: new Map(),
  categories: new Map(),
  broken: loadBroken(),
  q: '',
  country: null,
  cats: new Set(),
  group: 'country',
  browserOnly: true,
  ...restorePrefs(),
};
let renderQueue = [];
let currentGrid = null;
let playing = null; // { channel, streams, index, hls, timer }

function restorePrefs() {
  const p = store.get(PREFS_KEY, {});
  return {
    country: p.country ?? null,
    cats: new Set(p.cats || []),
    group: p.group === 'category' ? 'category' : 'country',
    browserOnly: p.browserOnly ?? true,
  };
}
function savePrefs() {
  store.set(PREFS_KEY, { country: state.country, cats: [...state.cats], group: state.group, browserOnly: state.browserOnly });
}
function loadBroken() {
  const now = Date.now();
  const raw = store.get(BROKEN_KEY, {});
  return new Map(Object.entries(raw).filter(([, t]) => now - t < BROKEN_TTL));
}
function saveBroken() { store.set(BROKEN_KEY, Object.fromEntries(state.broken)); }

// ---------- Filtros ----------
const pageIsHttps = location.protocol === 'https:';
function browserPlayable(s) {
  if (!s.cors || s.user_agent || s.referrer) return false; // el navegador no puede enviar estas cabeceras
  if (/\.mpd(\?|$)/i.test(s.url)) return false;
  if (pageIsHttps && s.url.startsWith('http:')) return false; // contenido mixto bloqueado
  return true;
}
function usableStreams(ch) {
  return ch.streams.filter((s) => !state.broken.has(s.url) && (!state.browserOnly || browserPlayable(s)));
}
function matches(ch, { country = true, cats = true } = {}) {
  if (!ch._usable.length) return false;
  if (state.q && !ch._search.includes(state.q)) return false;
  if (country && state.country && ch.country !== state.country) return false;
  if (cats && state.cats.size && !ch.categories.some((c) => state.cats.has(c))) return false;
  return true;
}
function refreshUsable() {
  for (const ch of state.channels) ch._usable = usableStreams(ch);
}

// ---------- Render ----------
const CAT_ES = {
  auto: 'Motor', animation: 'Animación', business: 'Negocios', classic: 'Clásicos', comedy: 'Comedia',
  cooking: 'Cocina', culture: 'Cultura', documentary: 'Documentales', education: 'Educación',
  entertainment: 'Entretenimiento', family: 'Familia', general: 'Generalista', interactive: 'Interactivo',
  kids: 'Infantil', legislative: 'Legislativo', lifestyle: 'Estilo de vida', movies: 'Cine', music: 'Música',
  news: 'Noticias', outdoor: 'Aire libre', public: 'Público', relax: 'Relax', religious: 'Religión',
  series: 'Series', science: 'Ciencia', shop: 'Compras', sports: 'Deportes', travel: 'Viajes',
  weather: 'Meteorología', undefined: 'Sin categoría',
};
let regionNames;
try { regionNames = new Intl.DisplayNames([navigator.language, 'es'], { type: 'region' }); } catch { /* sin Intl */ }
function localCountryName(code, fallback) {
  if (code === 'XX') return fallback;
  try { return regionNames?.of(code) || fallback; } catch { return fallback; }
}
const countryName = (c) => state.countries.get(c)?.name || c;
const countryFlag = (c) => state.countries.get(c)?.flag || '🏳️';
const catName = (c) => state.categories.get(c)?.name || c;

function renderSidebar() {
  // Países: conteo aplicando todos los filtros menos el de país
  const cCount = new Map();
  const kCount = new Map();
  for (const ch of state.channels) {
    if (matches(ch, { country: false })) cCount.set(ch.country, (cCount.get(ch.country) || 0) + 1);
    if (matches(ch, { cats: false })) for (const c of ch.categories) kCount.set(c, (kCount.get(c) || 0) + 1);
  }
  const filter = $('#countrySearch').value.trim().toLowerCase();
  const countries = [...state.countries.values()]
    .filter((c) => cCount.get(c.code) || c.code === state.country)
    .filter((c) => !filter || c.name.toLowerCase().includes(filter) || c.code.toLowerCase() === filter)
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  $('#countries').replaceChildren(
    ...countries.map((c) => {
      const li = document.createElement('li');
      li.className = c.code === state.country ? 'active' : '';
      li.innerHTML = '<span></span><span class="name"></span><small></small>';
      const [flag, nm, count] = li.children;
      flag.textContent = c.flag;
      nm.textContent = c.name;
      count.textContent = cCount.get(c.code) || 0;
      li.onclick = () => { state.country = state.country === c.code ? null : c.code; update(); closeMenu(); };
      return li;
    }),
  );
  const cats = [...state.categories.values()]
    .filter((c) => kCount.get(c.id) || state.cats.has(c.id))
    .sort((a, b) => (kCount.get(b.id) || 0) - (kCount.get(a.id) || 0));
  $('#categories').replaceChildren(
    ...cats.map((c) => {
      const b = document.createElement('button');
      b.className = 'chip' + (state.cats.has(c.id) ? ' active' : '');
      b.innerHTML = ` <small>${kCount.get(c.id) || 0}</small>`;
      b.prepend(c.name);
      b.onclick = () => { state.cats.has(c.id) ? state.cats.delete(c.id) : state.cats.add(c.id); update(); };
      return b;
    }),
  );
  $('#brokenInfo').textContent = state.broken.size
    ? `${state.broken.size} fuentes eliminadas automáticamente en este navegador por no ser accesibles.`
    : '';
  $('#resetBroken').hidden = !state.broken.size;
}

function buildGroups(list) {
  const groups = new Map();
  const add = (key, sub, ch) => {
    if (!groups.has(key)) groups.set(key, new Map());
    const g = groups.get(key);
    if (!g.has(sub)) g.set(sub, []);
    g.get(sub).push(ch);
  };
  for (const ch of list) {
    if (state.group === 'country') {
      const sub = (state.cats.size && ch.categories.find((c) => state.cats.has(c))) || ch.categories[0];
      add(ch.country, sub, ch);
    } else {
      const cats = state.cats.size ? ch.categories.filter((c) => state.cats.has(c)) : ch.categories;
      for (const c of cats) add(c, ch.country, ch);
    }
  }
  const label = state.group === 'country'
    ? (k) => `${countryFlag(k)} ${countryName(k)}`
    : (k) => catName(k);
  const subLabel = state.group === 'country' ? catName : (k) => `${countryFlag(k)} ${countryName(k)}`;
  const sortKey = state.group === 'country' ? countryName : catName;
  const subSortKey = state.group === 'country' ? catName : countryName;
  return [...groups.entries()]
    .sort((a, b) => sortKey(a[0]).localeCompare(sortKey(b[0]), 'es'))
    .map(([k, subs]) => ({
      title: label(k),
      count: new Set([...subs.values()].flat()).size,
      subs: [...subs.entries()]
        .sort((a, b) => subSortKey(a[0]).localeCompare(subSortKey(b[0]), 'es'))
        .map(([s, chs]) => ({ title: subLabel(s), channels: chs })),
    }));
}

function renderList() {
  const list = state.channels.filter((ch) => matches(ch));
  const total = state.channels.filter((ch) => ch._usable.length).length;
  $('#stats').textContent = `${list.length} de ${total} canales · actualizado ${state.updated}`;
  const root = $('#list');
  root.replaceChildren();
  renderQueue = [];
  currentGrid = null;
  if (!list.length) {
    root.innerHTML = '<p class="empty"><b>SIN SEÑAL</b>No hay canales con estos filtros.</p>';
    return;
  }
  for (const g of buildGroups(list)) {
    renderQueue.push({ type: 'group', title: g.title, count: g.count });
    for (const s of g.subs) {
      renderQueue.push({ type: 'sub', title: s.title, count: s.channels.length });
      for (const ch of s.channels) renderQueue.push({ type: 'card', ch });
    }
  }
  renderMore();
}

function renderMore() {
  const root = $('#list');
  let cards = 0;
  const frag = document.createDocumentFragment();
  while (renderQueue.length && cards < PAGE) {
    const item = renderQueue.shift();
    if (item.type === 'group') {
      const h = document.createElement('h2');
      h.className = 'group-title';
      h.textContent = `${item.title} · ${item.count}`;
      frag.append(h);
    } else if (item.type === 'sub') {
      const h = document.createElement('h3');
      h.className = 'sub-title';
      h.textContent = `${item.title} (${item.count})`;
      currentGrid = document.createElement('div');
      currentGrid.className = 'grid';
      frag.append(h, currentGrid);
    } else {
      currentGrid.append(card(item.ch));
      cards++;
    }
  }
  root.append(frag);
}

function card(ch) {
  const b = document.createElement('button');
  b.className = 'card' + (playing?.channel === ch ? ' playing' : '');
  b.dataset.id = ch.id;
  const logo = document.createElement('div');
  logo.className = 'logo';
  if (ch.logo) {
    const img = new Image();
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.src = ch.logo;
    img.onerror = () => { logo.textContent = '📺'; };
    logo.append(img);
  } else logo.textContent = '📺';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = ch.name;
  name.title = ch.name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const q = ch._usable.map((s) => s.quality).filter(Boolean)[0];
  const badge = (t) => { const e = document.createElement('span'); e.className = 'badge'; e.textContent = t; meta.append(e); };
  if (q) badge(q);
  if (ch._usable.some((s) => s.geo || s.labels?.includes('Geo-blocked'))) badge('geo');
  meta.append(`${countryFlag(ch.country)} ${ch.categories.map(catName).join(', ')}`);
  b.append(logo, name, meta);
  b.onclick = () => play(ch);
  return b;
}

function update() {
  savePrefs();
  renderSidebar();
  renderList();
  $('main').scrollTop = playing ? $('main').scrollTop : 0;
}

// ---------- Reproductor ----------
function stopPlayback() {
  if (!playing) return;
  clearTimeout(playing.timer);
  playing.hls?.destroy();
  playing.hls = null;
  const v = $('#video');
  v.onplaying = v.onloadeddata = v.onerror = null;
  v.removeAttribute('src');
  v.load();
}

function play(ch, index = 0) {
  stopPlayback();
  const streams = ch._usable.slice();
  playing = { channel: ch, streams, index };
  document.querySelectorAll('.card.playing').forEach((c) => c.classList.remove('playing'));
  document.querySelector(`.card[data-id="${CSS.escape(ch.id)}"]`)?.classList.add('playing');

  $('#player').hidden = false;
  $('#playerName').textContent = ch.name;
  $('#playerMeta').textContent = `${countryFlag(ch.country)} ${countryName(ch.country)} · ${ch.categories.map(catName).join(', ')}`;
  $('#playerLogo').onerror = () => { $('#playerLogo').hidden = true; };
  $('#playerLogo').src = ch.logo || '';
  $('#playerLogo').hidden = !ch.logo;
  const sel = $('#streamSelect');
  sel.replaceChildren(...streams.map((s, i) => new Option(
    `Fuente ${i + 1}${s.quality ? ` · ${s.quality}` : ''}${browserPlayable(s) ? '' : ' (externa)'}`, i)));
  sel.value = index;
  sel.hidden = streams.length < 2;
  $('main').scrollTo({ top: 0, behavior: 'smooth' });
  startStream();
}

function showMsg(html) {
  const m = $('#playerMsg');
  m.hidden = !html;
  m.innerHTML = html ? `<div>${html}</div>` : '';
}

function startStream() {
  const p = playing;
  const s = p.streams[p.index];
  const video = $('#video');
  video.onplaying = video.onloadeddata = video.onerror = null;
  if (!browserPlayable(s)) {
    showMsg(`Esta fuente no se puede reproducir en el navegador.<br>
      Ábrela en VLC: <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">enlace del stream</a>`);
    return;
  }
  showMsg('<span class="tuning">SINTONIZANDO SEÑAL</span>');
  // El stream se considera accesible en cuanto llega vídeo, aunque el navegador
  // bloquee la reproducción automática (eso no es culpa del canal).
  const ok = () => { clearTimeout(p.timer); if (playing === p) showMsg(''); };
  const fail = (why) => { if (playing === p && !p.failed) { p.failed = true; onStreamFail(p, why); } };
  const tryPlay = () => video.play().catch(() => {
    video.muted = true; // autoplay con sonido bloqueado: reintentar en silencio
    video.play().catch(() => { if (playing === p) showMsg('Pulsa ▶ para reproducir'); });
  });
  p.failed = false;
  p.timer = setTimeout(() => fail('tiempo de espera agotado'), PLAY_TIMEOUT);
  video.onplaying = ok;
  video.onloadeddata = ok;

  if (window.Hls?.isSupported()) {
    const hls = new Hls({ manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2 });
    p.hls = hls;
    let recovered = false;
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal || playing !== p || p.hls !== hls) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
        recovered = true;
        hls.recoverMediaError();
        return;
      }
      fail(d.details);
    });
    hls.on(Hls.Events.FRAG_BUFFERED, ok);
    hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
    hls.loadSource(s.url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // HLS nativo (Safari / iOS). onerror solo aquí: con hls.js los errores
    // del elemento <video> se gestionan por Hls.Events.ERROR.
    video.onerror = () => fail('error del reproductor');
    video.src = s.url;
    tryPlay();
  } else {
    // Sin soporte HLS: no es culpa del canal, así que no se elimina.
    clearTimeout(p.timer);
    showMsg('Tu navegador no puede reproducir HLS. Usa la lista M3U en VLC.');
  }
}

function onStreamFail(p, why) {
  clearTimeout(p.timer);
  p.hls?.destroy();
  p.hls = null;
  const s = p.streams[p.index];
  // Si el usuario está sin conexión no culpamos al canal.
  if (!navigator.onLine) {
    showMsg('Sin conexión a Internet.');
    return;
  }
  state.broken.set(s.url, Date.now());
  saveBroken();
  console.warn('Fuente eliminada', s.url, why);
  if (p.index + 1 < p.streams.length) {
    p.index++;
    $('#streamSelect').value = p.index;
    startStream();
    return;
  }
  // Ninguna fuente funciona: el canal se elimina de la lista.
  refreshUsable();
  showMsg(`<b class="nosignal">SIN SEÑAL</b><br>${escapeHtml(p.channel.name)} no está accesible y se ha eliminado de la lista.`);
  toast(`✕ ELIMINADO · ${p.channel.name} (no accesible)`);
  document.querySelector(`.card[data-id="${CSS.escape(p.channel.id)}"]`)?.remove();
  renderSidebar();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function closeMenu() { $('#sidebar').classList.remove('open'); }

// ---------- Inicio ----------
async function init() {
  $('#list').innerHTML = '<p class="empty"><b class="tuning">CARGANDO</b>Recibiendo la lista de canales…</p>';
  let data;
  try {
    const res = await fetch('data/channels.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch (e) {
    $('#list').innerHTML = '<p class="empty">No se pudo cargar data/channels.json. Ejecuta <code>npm run build</code>.</p>';
    return;
  }
  state.countries = new Map(data.meta.countries.map((c) => [c.code, { ...c, name: localCountryName(c.code, c.name) }]));
  state.categories = new Map(data.meta.categories.map((c) => [c.id, { ...c, name: CAT_ES[c.id] || c.name }]));
  state.updated = new Date(data.meta.updated).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
  state.channels = data.channels.map((ch) => ({
    ...ch,
    _search: `${ch.name} ${ch.streams.map((s) => s.title || '').join(' ')}`.toLowerCase(),
  }));
  if (state.country && !state.countries.has(state.country)) state.country = null;
  refreshUsable();

  $('#browserOnly').checked = state.browserOnly;
  document.querySelector(`input[name="group"][value="${state.group}"]`).checked = true;

  let t;
  $('#search').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); update(); }, 150);
  };
  $('#countrySearch').oninput = renderSidebar;
  $('#browserOnly').onchange = (e) => { state.browserOnly = e.target.checked; refreshUsable(); update(); };
  document.querySelectorAll('input[name="group"]').forEach((r) => {
    r.onchange = () => { state.group = r.value; update(); };
  });
  $('#clearCats').onclick = () => { state.cats.clear(); update(); };
  $('#clearCountry').onclick = () => { state.country = null; update(); };
  $('#resetBroken').onclick = () => { state.broken.clear(); saveBroken(); refreshUsable(); update(); };
  $('#streamSelect').onchange = (e) => { stopPlayback(); playing.index = Number(e.target.value); startStream(); };
  $('#closePlayer').onclick = () => { stopPlayback(); playing = null; $('#player').hidden = true;
    document.querySelectorAll('.card.playing').forEach((c) => c.classList.remove('playing')); };
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && renderQueue.length) renderMore();
  }, { root: $('main'), rootMargin: '800px' }).observe($('#sentinel'));

  update();
}

init();
