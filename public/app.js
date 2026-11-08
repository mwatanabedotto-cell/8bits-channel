// Visor IPTV: carga data/channels.json (generado y verificado por scripts/build.mjs),
// lo agrupa por país / enfoque y elimina automáticamente en el navegador los
// streams que no se pueden reproducir.

const BROKEN_KEY = 'iptv.broken.v1';
const PREFS_KEY = 'iptv.prefs.v1';
const LAST_KEY = 'iptv.last.v1';
const FAVS_KEY = 'iptv.favs.v1';
const BROKEN_TTL = 3 * 24 * 3600 * 1000; // se reintenta a los 3 días
const PLAY_TIMEOUT = 20000;
const PAGE = window.Capacitor?.isNativePlatform?.() ? 96 : 200; // menos tarjetas por tanda en TV/móvil
// Dentro de la APK (Capacitor) los datos se descargan de la web publicada,
// que se actualiza a diario; la copia incluida en la APK es el respaldo.
const IS_APP = !!window.Capacitor?.isNativePlatform?.();
const SITE_URL = 'https://mwatanabedotto-cell.github.io/8bits-channel/';
const DATA_URLS = IS_APP ? [SITE_URL + 'data/channels.json', 'data/channels.json'] : ['data/channels.json'];

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
  lineup: [],
  byNum: new Map(),
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
    favOnly: !!p.favOnly,
    favs: new Set(store.get(FAVS_KEY, [])),
  };
}
function savePrefs() {
  store.set(PREFS_KEY, { country: state.country, cats: [...state.cats], group: state.group, browserOnly: state.browserOnly, favOnly: state.favOnly });
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
  if (state.favOnly && !state.favs.has(ch.id)) return false;
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
      li.tabIndex = 0; // navegable con teclado / mando de TV
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.onclick(); } };
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
  const result = [...groups.entries()]
    .sort((a, b) => sortKey(a[0]).localeCompare(sortKey(b[0]), 'es'))
    .map(([k, subs]) => ({
      title: label(k),
      count: new Set([...subs.values()].flat()).size,
      subs: [...subs.entries()]
        .sort((a, b) => subSortKey(a[0]).localeCompare(subSortKey(b[0]), 'es'))
        .map(([s, chs]) => ({ title: subLabel(s), channels: chs })),
    }));
  // ★ Favoritos siempre arriba (y primeros al hacer zapping)
  const favs = list.filter((ch) => state.favs.has(ch.id)).sort((a, b) => a._num - b._num);
  if (favs.length && !state.favOnly) {
    result.unshift({ title: '★ Favoritos', count: favs.length, subs: [{ title: 'Mis canales', channels: favs }] });
  }
  if (state.favOnly) return [{ title: '★ Favoritos', count: favs.length, subs: [{ title: 'Mis canales', channels: favs }] }];
  return result;
}

// ---------- Favoritos ----------
function toggleFav(ch) {
  if (state.favs.has(ch.id)) state.favs.delete(ch.id);
  else state.favs.add(ch.id);
  store.set(FAVS_KEY, [...state.favs]);
  const fav = state.favs.has(ch.id);
  toast(fav ? `★ AÑADIDO A FAVORITOS · ${ch.name}` : `☆ QUITADO DE FAVORITOS · ${ch.name}`, fav ? 'ok' : '');
  updateFavBtn();
  const top = $('main').scrollTop;
  update();
  $('main').scrollTop = top;
}
function updateFavBtn() {
  const fav = playing && state.favs.has(playing.channel.id);
  $('#favBtn').textContent = fav ? '★' : '☆';
  $('#favBtn').classList.toggle('on', !!fav);
  $('#favBtn').title = fav ? 'Quitar de favoritos (*)' : 'Añadir a favoritos (*)';
  $('#favCount').textContent = state.favs.size;
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
    state.lineup = [];
    return;
  }
  const lineup = new Set();
  for (const g of buildGroups(list)) {
    renderQueue.push({ type: 'group', title: g.title, count: g.count });
    for (const sg of g.subs) for (const ch of sg.channels) lineup.add(ch);
    for (const s of g.subs) {
      renderQueue.push({ type: 'sub', title: s.title, count: s.channels.length });
      for (const ch of s.channels) renderQueue.push({ type: 'card', ch });
    }
  }
  state.lineup = [...lineup]; // orden de zapping = orden en pantalla
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
  const num = document.createElement('span');
  num.className = 'chnum';
  num.textContent = fmtNum(ch._num);
  logo.append(num);
  if (state.favs.has(ch.id)) {
    const star = document.createElement('span');
    star.className = 'favstar';
    star.textContent = '★';
    logo.append(star);
  }
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

const fmtNum = (n) => String(n).padStart(3, '0');

function play(ch, index = 0, { dir = 0, skips = 0 } = {}) {
  stopPlayback();
  const streams = ch._usable.slice();
  playing = { channel: ch, streams, index, dir, skips };
  store.set(LAST_KEY, ch.id);
  showOsd(ch);
  document.querySelectorAll('.card.playing').forEach((c) => c.classList.remove('playing'));
  document.querySelector(`.card[data-id="${CSS.escape(ch.id)}"]`)?.classList.add('playing');

  $('#player').hidden = false;
  $('#playerName').textContent = ch.name;
  updateFavBtn();
  $('#playerMeta').textContent = `${countryFlag(ch.country)} ${countryName(ch.country)} · ${ch.categories.map(catName).join(', ')}`;
  $('#playerLogo').onerror = () => { $('#playerLogo').hidden = true; };
  $('#playerLogo').src = ch.logo || '';
  $('#playerLogo').hidden = !ch.logo;
  const sel = $('#streamSelect');
  sel.replaceChildren(...streams.map((s, i) => new Option(
    `Fuente ${i + 1}${s.quality ? ` · ${s.quality}` : ''}${browserPlayable(s) ? '' : ' (externa)'}`, i)));
  sel.value = index;
  sel.hidden = streams.length < 2;
  if (!document.fullscreenElement) $('main').scrollTo({ top: 0, behavior: 'smooth' });
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
  // Siempre se intenta con sonido. Solo si el sistema bloquea el autoplay con
  // sonido se reproduce en silencio y se muestra «Activar sonido».
  const tryPlay = () => {
    if (autoMuted) { video.muted = false; autoMuted = false; }
    video.play().then(updateSoundHint).catch(() => {
      video.muted = true;
      autoMuted = true;
      updateSoundHint();
      video.play().catch(() => { if (playing === p) showMsg('Pulsa ▶ para reproducir'); });
    });
  };
  p.failed = false;
  p.timer = setTimeout(() => fail('tiempo de espera agotado'), PLAY_TIMEOUT);
  video.onplaying = ok;
  video.onloadeddata = ok;

  if (window.Hls?.isSupported()) {
    const hls = new Hls({
      manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2,
      // Más ligero para TV Box y móviles modestos
      lowLatencyMode: false,
      capLevelToPlayerSize: true, // no decodifica 1080p si la pantalla no lo necesita
      maxBufferLength: 20,
      backBufferLength: 10,
    });
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
  const removedIdx = state.lineup.indexOf(p.channel);
  state.lineup = state.lineup.filter((c) => c._usable.length);
  renderSidebar();
  // Haciendo zapping, como en una TV: se salta solo al siguiente canal.
  if (p.dir && p.skips < 15 && state.lineup.length) {
    setTimeout(() => {
      if (playing !== p) return;
      const i = p.dir > 0 ? removedIdx : removedIdx - 1;
      const next = state.lineup[(i + state.lineup.length) % state.lineup.length];
      play(next, 0, { dir: p.dir, skips: p.skips + 1 });
    }, 1200);
  }
}

// ---------- Sonido ----------
let autoMuted = false; // silenciado por el bloqueo de autoplay (no por el usuario)
function updateSoundHint() {
  $('#soundBtn').hidden = !autoMuted;
}
function unmute() {
  const v = $('#video');
  if (!autoMuted) return;
  autoMuted = false;
  v.muted = false;
  if (v.volume === 0) v.volume = 1;
  v.play().catch(() => {});
  updateSoundHint();
}

// ---------- Zapping estilo TV ----------
function zap(delta) {
  const list = state.lineup;
  if (!list.length) return;
  let i = playing ? list.indexOf(playing.channel) : -1;
  if (i === -1) i = delta > 0 ? -1 : 0;
  const next = list[(i + delta + list.length) % list.length];
  play(next, 0, { dir: delta });
}

let osdTimer;
function showOsd(ch, typed) {
  const osd = $('#osd');
  osd.querySelector('.osd-num').textContent = typed ?? fmtNum(ch._num);
  osd.querySelector('.osd-name').textContent = typed ? '' : ch.name;
  osd.querySelector('.osd-meta').textContent = typed
    ? 'Introduce el número de canal'
    : `${countryFlag(ch.country)} ${countryName(ch.country)} · ${ch.categories.map(catName).join(', ')}`;
  osd.hidden = false;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => { osd.hidden = true; }, typed ? 2500 : 3500);
}

// Teclear el número de canal con el mando o el teclado (como en la TV)
let numBuf = '';
let numTimer;
function typeDigit(d) {
  numBuf = (numBuf + d).slice(-4);
  $('#player').hidden = false;
  showOsd(null, numBuf.padEnd(3, '_'));
  clearTimeout(numTimer);
  numTimer = setTimeout(() => {
    const n = Number(numBuf);
    numBuf = '';
    const ch = state.byNum.get(n);
    if (ch && ch._usable.length) play(ch);
    else { toast(`CANAL ${fmtNum(n)} NO DISPONIBLE`); if (playing) showOsd(playing.channel); else $('#player').hidden = true; }
  }, 1500);
}

function toggleFullscreen() {
  const wrap = $('.video-wrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap.requestFullscreen?.().catch(() => {});
}

function onKey(e) {
  const t = e.target;
  const typing = t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
  if (typing) return;
  const full = !!document.fullscreenElement;
  const videoFocused = t.closest?.('.video-wrap') || t === document.body;
  const k = e.key;
  const code = e.keyCode;
  unmute(); // cualquier tecla del mando cuenta como interacción: activar sonido
  // Teclas de canal del mando (KEYCODE_CHANNEL_UP/DOWN = 166/167) y Re Pág / Av Pág
  const chUp = k === 'ChannelUp' || k === 'PageUp' || code === 166;
  const chDown = k === 'ChannelDown' || k === 'PageDown' || code === 167;
  // Flechas ▲▼: cambian canal en pantalla completa o con el foco en el vídeo
  const arrowZap = playing && (full || (videoFocused && !$('#sidebar').classList.contains('open')));
  if (chUp || (arrowZap && k === 'ArrowUp')) { e.preventDefault(); zap(+1); return; }
  if (chDown || (arrowZap && k === 'ArrowDown')) { e.preventDefault(); zap(-1); return; }
  if (/^[0-9]$/.test(k)) { e.preventDefault(); typeDigit(k); return; }
  if (playing && (k === '*' || k === 'Bookmark' || k === 'ColorF2Yellow' || code === 174)) { e.preventDefault(); toggleFav(playing.channel); return; }
  if (playing && (k === 'i' || k === 'Info' || (full && k === 'Enter'))) { e.preventDefault(); showOsd(playing.channel); return; }
  if (playing && (k === 'f' || k === 'F')) { e.preventDefault(); toggleFullscreen(); }
}

// Deslizar arriba/abajo sobre el vídeo cambia de canal (móvil)
function setupSwipe() {
  const wrap = $('.video-wrap');
  let y0 = null;
  let x0 = null;
  wrap.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0;
    const dx = e.changedTouches[0].clientX - x0;
    y0 = null;
    if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.5) zap(dy < 0 ? +1 : -1);
  }, { passive: true });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
function toast(text, kind = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function closeMenu() { $('#sidebar').classList.remove('open'); }

function closePlayer() {
  if (document.fullscreenElement) document.exitFullscreen();
  stopPlayback();
  playing = null;
  $('#player').hidden = true;
  document.querySelectorAll('.card.playing').forEach((c) => c.classList.remove('playing'));
}

// Ajustes propios de la APK de Android
function setupApp() {
  document.documentElement.classList.add('is-app');
  document.querySelector('.toggle').lastChild.textContent = ' Solo canales reproducibles en la app';
  const m3u = document.querySelector('a[href="data/playlist.m3u"]');
  if (m3u) { m3u.href = SITE_URL + 'data/playlist.m3u'; m3u.removeAttribute('download'); m3u.target = '_blank'; }
  // Botón «atrás»: cierra pantalla completa, menú o reproductor antes de salir.
  window.Capacitor.Plugins?.App?.addListener('backButton', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if ($('#sidebar').classList.contains('open')) closeMenu();
    else if (playing) closePlayer();
    else window.Capacitor.Plugins.App.exitApp();
  });
}

// ---------- Caché de la lista (la app arranca al instante) ----------
// Se usa la última lista guardada y se descarga la nueva en segundo plano
// para el próximo arranque.
const CACHE_NAME = '8bits-data-v1';
async function loadCachedData() {
  try {
    const res = await (await caches.open(CACHE_NAME)).match(DATA_URLS[0]);
    return res ? await res.json() : null;
  } catch { return null; }
}
async function saveCachedData(res) {
  try { await (await caches.open(CACHE_NAME)).put(DATA_URLS[0], res); } catch { /* sin Cache API */ }
}
function refreshDataInBackground() {
  setTimeout(async () => {
    try {
      const res = await fetch(DATA_URLS[0], { cache: 'no-cache' });
      if (res.ok) await saveCachedData(res);
    } catch { /* sin conexión: se queda la copia */ }
  }, 8000);
}

// ---------- Inicio ----------
async function init() {
  $('#list').innerHTML = '<p class="empty"><b class="tuning">CARGANDO</b>Recibiendo la lista de canales…</p>';
  let data = IS_APP ? await loadCachedData() : null;
  if (data) refreshDataInBackground();
  for (const url of data ? [] : DATA_URLS) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const clone = res.clone();
      data = await res.json();
      if (IS_APP && url.startsWith('http')) saveCachedData(clone);
      break;
    } catch (e) {
      console.warn('No se pudo cargar', url, e);
    }
  }
  if (!data) {
    $('#list').innerHTML = IS_APP
      ? '<p class="empty"><b>SIN SEÑAL</b>No se pudo descargar la lista de canales. Revisa tu conexión a Internet.</p>'
      : '<p class="empty"><b>SIN SEÑAL</b>No se pudo cargar data/channels.json. Ejecuta <code>npm run build</code>.</p>';
    return;
  }
  if (IS_APP) setupApp();
  state.countries = new Map(data.meta.countries.map((c) => [c.code, { ...c, name: localCountryName(c.code, c.name) }]));
  state.categories = new Map(data.meta.categories.map((c) => [c.id, { ...c, name: CAT_ES[c.id] || c.name }]));
  state.updated = new Date(data.meta.updated).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
  state.channels = data.channels.map((ch) => ({
    ...ch,
    _search: `${ch.name} ${ch.streams.map((s) => s.title || '').join(' ')}`.toLowerCase(),
  }));
  if (state.country && !state.countries.has(state.country)) state.country = null;
  // Números de canal fijos (por país, enfoque y nombre), como en una TV.
  const order = state.channels.slice().sort((a, b) =>
    countryName(a.country).localeCompare(countryName(b.country), 'es') ||
    catName(a.categories[0]).localeCompare(catName(b.categories[0]), 'es') ||
    a.name.localeCompare(b.name, 'es'));
  state.byNum = new Map();
  order.forEach((ch, i) => { ch._num = i + 1; state.byNum.set(i + 1, ch); });
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
  $('#closePlayer').onclick = closePlayer;
  $('#chUp').onclick = $('#zapUp').onclick = () => zap(+1);
  $('#chDown').onclick = $('#zapDown').onclick = () => zap(-1);
  $('#fullBtn').onclick = toggleFullscreen;
  $('#favBtn').onclick = () => playing && toggleFav(playing.channel);
  $('#soundBtn').onclick = unmute;
  document.addEventListener('pointerdown', unmute, true);
  $('#favOnly').checked = state.favOnly;
  $('#favOnly').onchange = (e) => { state.favOnly = e.target.checked; update(); };
  $('#favCount').textContent = state.favs.size;
  $('.video-wrap').tabIndex = 0;
  $('.video-wrap').ondblclick = toggleFullscreen;
  document.addEventListener('keydown', onKey);
  setupSwipe();
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && renderQueue.length) renderMore();
  }, { root: $('main'), rootMargin: '800px' }).observe($('#sentinel'));

  update();

  // Al abrir se continúa con el último canal visto, como una TV.
  const lastId = store.get(LAST_KEY, null);
  const last = lastId && state.channels.find((c) => c.id === lastId);
  if (last && last._usable.length) play(last);
}

init();
