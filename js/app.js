import {
  CATEGORIES, PERIODS, STATUSES, RELIABILITY, APPROX_GRID, BASEMAPS, STREET_STYLE, MAP_FONT, FALLBACK_STREETS,
} from './config.js';

const INDEX_URL = 'data/index.json';
const LIST_LIMIT = 200;
// Below this zoom, imported squares are shown as one count bubble each and
// their details are not downloaded (the whole of Europe would be megabytes).
const DETAIL_ZOOM = 5;
const $ = (sel) => document.querySelector(sel);

const state = {
  all: [],                                   // prepared features, all loaded layers
  byId: new Map(),
  layers: [],                                // entries of data/index.json
  requested: new Set(),                      // layer ids being fetched or fetched
  loaded: new Set(),                         // layer ids fully loaded
  categories: new Set(Object.keys(CATEGORIES)),
  period: '',
  status: '',
  query: '',
  selectedId: null,
};

// ---------- data ----------

// Applies the publication levels from the brief:
//   public      → shown as-is
//   approximate → snapped to a coarse grid and flagged
//   hidden      → never loaded into the map
// NOTE: in this static version the raw file is downloadable, so "approximate"
// entries must ALSO be stored already rounded (tools/validate.mjs enforces it).
function prepare(fc) {
  return fc.features
    .filter((f) => f.properties.visibility !== 'hidden')
    .map((f) => {
      const p = { ...f.properties };
      let [lng, lat] = f.geometry.coordinates;
      if (p.visibility === 'approximate') {
        lng = Math.round(lng / APPROX_GRID) * APPROX_GRID;
        lat = Math.round(lat / APPROX_GRID) * APPROX_GRID;
      }
      p._search = [p.name, ...(p.alt_names || []), p.place, p.country].join(' ').toLowerCase();
      return { type: 'Feature', id: p.id, geometry: { type: 'Point', coordinates: [lng, lat] }, properties: p };
    });
}

function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.all.filter((f) => {
    const p = f.properties;
    return state.categories.has(p.category)
      && (!state.period || p.period === state.period)
      && (!state.status || p.status === state.status)
      && (!q || p._search.includes(q));
  });
}

// Data is split into layers (data/index.json): the curated list plus one file
// per imported country. A layer with a bbox is fetched only once the map view
// touches it, so adding countries doesn't slow down the first load.
async function loadLayer(layer) {
  if (state.requested.has(layer.id)) return;
  state.requested.add(layer.id);
  try {
    const res = await fetch(layer.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feats = prepare(await res.json()).filter((f) => !state.byId.has(f.properties.id));
    feats.forEach((f) => state.byId.set(f.properties.id, f));
    state.all = state.all.concat(feats);
    state.loaded.add(layer.id); // only now: until then its bubble and count stay
  } catch (err) {
    state.requested.delete(layer.id);
    console.error(`Impossibile caricare ${layer.file}:`, err);
  }
}

const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const layerBoxes = (l) => l.bboxes || (l.bbox ? [l.bbox] : null);

// Filters and text search must see every site, so they load all squares
// (once; afterwards the files come from the offline cache).
const filtersActive = () => state.categories.size < Object.keys(CATEGORIES).length
  || !!state.period || !!state.status || state.query.trim().length >= 3;

async function loadVisibleLayers({ all = false } = {}) {
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const detail = map.getZoom() >= DETAIL_ZOOM;
  const wanted = (l) => {
    const boxes = layerBoxes(l);
    if (!boxes) return true; // curated list: always
    return detail && boxes.some((bb) => intersects(bb, view));
  };
  const todo = state.layers.filter((l) => !state.requested.has(l.id) && (all || filtersActive() || wanted(l)));
  if (!todo.length) return false;
  await Promise.all(todo.map(loadLayer));
  refresh();
  return true;
}

// One bubble per square that isn't downloaded yet, at its centre, with its count.
function updateSummary() {
  const features = state.layers
    .filter((l) => l.center && l.count && !state.loaded.has(l.id))
    .map((l) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: l.center }, properties: { count: l.count } }));
  map.getSource('summary')?.setData({ type: 'FeatureCollection', features });
}

const unloadedCount = () => state.layers
  .filter((l) => l.count && !state.loaded.has(l.id))
  .reduce((s, l) => s + l.count, 0);

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['it'], { type: 'region' }); } catch { /* old browser */ }
const countryName = (cc) => { try { return regionNames?.of(cc) || cc; } catch { return cc; } };

const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

function categoryColorExpr() {
  const expr = ['match', ['get', 'category']];
  for (const [k, v] of Object.entries(CATEGORIES)) expr.push(k, v.color);
  expr.push('#888');
  return expr;
}

// ---------- map ----------

// Street map = OpenFreeMap's vector style. Topographic/satellite are raster
// layers appended on top of it, hidden until chosen. If the style can't be
// fetched, fall back to plain OSM raster tiles so the map still works.
async function buildStyle() {
  let style;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(STREET_STYLE, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    style = await res.json();
  } catch (err) {
    console.warn('Mappa stradale non disponibile, uso il ripiego raster:', err);
    style = {
      version: 8,
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: { 'base-streets': { type: 'raster', tileSize: 256, ...FALLBACK_STREETS } },
      layers: [{ id: 'base-streets', type: 'raster', source: 'base-streets' }],
    };
  }
  for (const [key, b] of Object.entries(BASEMAPS)) {
    if (!b.tiles) continue;
    style.sources[`base-${key}`] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
    style.layers.push({ id: `base-${key}`, type: 'raster', source: `base-${key}`, layout: { visibility: 'none' } });
  }
  return style;
}

class BasemapControl {
  onAdd(map) {
    this.map = map;
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-ctrl';
    for (const [key, b] of Object.entries(BASEMAPS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.dataset.key = key;
      btn.setAttribute('aria-pressed', key === 'streets');
      btn.onclick = () => this.select(key);
      this.el.appendChild(btn);
    }
    return this.el;
  }
  select(key) {
    // The street map is always underneath; the others are overlays.
    for (const [k, b] of Object.entries(BASEMAPS)) {
      if (b.tiles) this.map.setLayoutProperty(`base-${k}`, 'visibility', k === key ? 'visible' : 'none');
    }
    this.el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.key === key));
  }
  onRemove() { this.el.remove(); }
}

function addBunkerLayers(map, attribution) {
  map.addSource('bunkers', {
    type: 'geojson',
    attribution,
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterRadius: 45,
    clusterMaxZoom: 12,
    promoteId: 'id',
  });

  map.addLayer({
    id: 'clusters', type: 'circle', source: 'bunkers', filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#1c2833',
      'circle-opacity': 0.85,
      'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });
  map.addLayer({
    id: 'cluster-count', type: 'symbol', source: 'bunkers', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': [MAP_FONT], 'text-size': 12 },
    paint: { 'text-color': '#fff' },
  });
  // Halo for entries whose position is deliberately blurred.
  map.addLayer({
    id: 'approx-halo', type: 'circle', source: 'bunkers',
    filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'visibility'], 'approximate']],
    paint: { 'circle-color': categoryColorExpr(), 'circle-opacity': 0.15, 'circle-radius': 22 },
  });
  map.addLayer({
    id: 'points', type: 'circle', source: 'bunkers', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': categoryColorExpr(),
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 5, 12, 8],
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 4, 2],
      'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#f1c40f', '#fff'],
    },
  });

  // Count bubbles for squares not downloaded yet (same look as clusters).
  // Nearby squares merge into one bubble showing the summed count.
  map.addSource('summary', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterRadius: 50,
    clusterProperties: { total: ['+', ['get', 'count']] },
  });
  const n = ['coalesce', ['get', 'total'], ['get', 'count']];
  map.addLayer({
    id: 'summary', type: 'circle', source: 'summary',
    paint: {
      'circle-color': '#1c2833', 'circle-opacity': 0.85,
      'circle-radius': ['step', n, 14, 10, 18, 100, 22, 1000, 26, 5000, 30],
      'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
    },
  });
  map.addLayer({
    id: 'summary-count', type: 'symbol', source: 'summary',
    layout: {
      'text-field': ['case', ['>=', n, 1000], ['concat', ['to-string', ['/', ['round', ['/', n, 100]], 10]], 'k'], ['to-string', n]],
      'text-font': [MAP_FONT], 'text-size': 12, 'text-allow-overlap': true,
    },
    paint: { 'text-color': '#fff' },
  });
  map.on('click', 'summary', (e) => {
    map.easeTo({ center: e.features[0].geometry.coordinates, zoom: Math.max(map.getZoom() + 2, DETAIL_ZOOM + 1) });
  });

  map.on('click', 'clusters', async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource('bunkers').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  map.on('click', 'points', (e) => select(e.features[0].properties.id, { fly: false }));
  for (const layer of ['clusters', 'points', 'summary']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
}

// ---------- UI ----------

function buildFilters() {
  const box = $('#filter-category');
  for (const [key, c] of Object.entries(CATEGORIES)) {
    const label = document.createElement('label');
    label.className = 'check';
    label.innerHTML = `<input type="checkbox" value="${key}" checked>
      <span class="swatch" style="background:${c.color}"></span>
      <span><strong>${esc(c.label)}</strong><small>${esc(c.hint)}</small></span>`;
    label.querySelector('input').addEventListener('change', (e) => {
      e.target.checked ? state.categories.add(key) : state.categories.delete(key);
      refresh();
    });
    box.appendChild(label);
  }
  const fill = (sel, dict) => {
    for (const [k, v] of Object.entries(dict)) sel.add(new Option(v, k));
  };
  fill($('#filter-period'), PERIODS);
  fill($('#filter-status'), Object.fromEntries(Object.entries(STATUSES).filter(([k]) => k !== 'active')));
  $('#filter-period').addEventListener('change', (e) => { state.period = e.target.value; refresh(); });
  $('#filter-status').addEventListener('change', (e) => { state.status = e.target.value; refresh(); });
  setupSearch();
}

// ---------- search: bunkers by name + places (Photon) ----------
//
// Typing filters the bunkers by name/town as before. In parallel, places
// (regions, valleys, cities…) are looked up with Photon, a free OpenStreetMap
// geocoder. Choosing a place clears the text filter and moves the map there.
// Only the typed text and the current map centre are sent to Photon.

const PHOTON_URL = 'https://photon.komoot.io/api/';
const PLACE_TYPES = {
  country: 'Paese', state: 'Regione', county: 'Provincia o distretto', city: 'Città',
  district: 'Quartiere o località', locality: 'Località', street: 'Strada', house: 'Edificio', other: 'Luogo',
};
const PLACE_ZOOM = { country: 5, state: 7, county: 9, city: 12, district: 13, locality: 13, street: 15, house: 16 };

let placeAbort = null;

async function findPlaces(text) {
  placeAbort?.abort();
  placeAbort = new AbortController();
  const c = map.getCenter();
  // Areas only (regions, towns, valleys, peaks…): shops and street names just
  // crowd out the places people actually look for. Weak bias to the map view.
  const params = new URLSearchParams({
    q: text, limit: '6', lang: 'default',
    lat: c.lat.toFixed(2), lon: c.lng.toFixed(2), zoom: String(Math.round(map.getZoom())), location_bias_scale: '0.1',
  });
  for (const l of ['country', 'state', 'county', 'city', 'district', 'locality', 'other']) params.append('layer', l);
  const res = await fetch(`${PHOTON_URL}?${params}`, { signal: placeAbort.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const seen = new Set();
  return (await res.json()).features.filter((f) => {
    const p = f.properties;
    const key = `${p.name}|${p.state}|${p.country}`;
    if (!p.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

function goToPlace(f) {
  const p = f.properties;
  if (Array.isArray(p.extent) && p.extent.length === 4) {
    const [w, n, e, s] = p.extent;
    map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 14 });
  } else {
    map.flyTo({ center: f.geometry.coordinates, zoom: PLACE_ZOOM[p.type] || 11 });
  }
}

function setupSearch() {
  const input = $('#search');
  const box = $('#search-suggest');
  let options = [];       // [{ el, run }]
  let active = -1;
  let places = [];
  let timer;
  let enterPending = false; // Enter pressed while places were still loading

  const open = (yes) => {
    box.hidden = !yes;
    input.setAttribute('aria-expanded', String(yes));
  };
  const setActive = (i) => {
    active = i;
    options.forEach((o, k) => {
      o.el.classList.toggle('active', k === i);
      o.el.setAttribute('aria-selected', String(k === i));
    });
    if (options[i]) options[i].el.scrollIntoView({ block: 'nearest' });
  };

  function render(text, { loading = false, error = null } = {}) {
    const matches = filtered().length;
    options = [];
    active = -1;
    box.innerHTML = '';
    const add = (html, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.setAttribute('role', 'option');
      b.innerHTML = html;
      // mousedown, not click: fires before the input loses focus.
      b.addEventListener('mousedown', (e) => { e.preventDefault(); run(); });
      box.appendChild(b);
      options.push({ el: b, run });
    };
    const heading = (label) => { const h = document.createElement('h3'); h.textContent = label; box.appendChild(h); };
    const msg = (m) => { const d = document.createElement('div'); d.className = 'msg'; d.textContent = m; box.appendChild(d); };

    heading('Bunker');
    if (matches) {
      add(`<strong>${matches.toLocaleString('it-IT')} con “${esc(text)}” nel nome o nella località</strong><small>Mostra sulla mappa</small>`, () => {
        open(false);
        fitTo(filtered());
      });
    } else {
      msg(`Nessun bunker con “${text}” nel nome.`);
    }

    heading('Luoghi');
    if (!navigator.onLine) msg('Ricerca dei luoghi non disponibile offline.');
    else if (loading) msg('Cerco…');
    else if (error) msg('Ricerca dei luoghi non disponibile al momento.');
    else if (!places.length) msg('Nessun luogo trovato.');
    for (const f of places) {
      const p = f.properties;
      const where = [p.city !== p.name ? p.city : null, p.county, p.state, p.country]
        .filter((x, i, arr) => x && x !== p.name && arr.indexOf(x) === i).join(', ');
      add(`<strong>${esc(p.name)}</strong><small>${esc(PLACE_TYPES[p.type] || 'Luogo')}${where ? ` · ${esc(where)}` : ''}</small>`, () => {
        input.value = '';
        state.query = '';
        open(false);
        refresh();
        goToPlace(f);
        input.blur();
      });
    }
    if (places.length) {
      const c = document.createElement('div');
      c.className = 'credit';
      c.innerHTML = 'Luoghi: <a href="https://photon.komoot.io" target="_blank" rel="noopener noreferrer">Photon</a> · © OpenStreetMap';
      box.appendChild(c);
    }
    open(true);
  }

  input.addEventListener('input', () => {
    enterPending = false;
    clearTimeout(timer);
    // Debounced: refiltering thousands of sites on every keystroke feels sluggish,
    // and Photon asks clients not to send a request per letter.
    timer = setTimeout(async () => {
      const text = input.value.trim();
      state.query = text;
      refresh();
      if (text.length < 3) { places = []; open(false); return; }
      places = [];
      render(text, { loading: navigator.onLine });
      if (!navigator.onLine) return;
      try {
        places = await findPlaces(text);
        if (input.value.trim() === text) {
          render(text);
          // Enter was pressed before places arrived and no bunker matched: take the first place.
          if (enterPending && !filtered().length) options[0]?.run();
          enterPending = false;
        }
      } catch (err) {
        if (err.name !== 'AbortError' && input.value.trim() === text) render(text, { error: err });
      }
    }, 300);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (box.hidden || box.querySelector('.msg')?.textContent === 'Cerco…')) {
      e.preventDefault();
      enterPending = true; // answered as soon as the results are in
      return;
    }
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(active + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter with nothing highlighted: the first choice (bunkers if any match, else the first place).
      (options[active] || options[0])?.run();
    } else if (e.key === 'Escape') { open(false); }
  });
  input.addEventListener('blur', () => setTimeout(() => open(false), 150));
  input.addEventListener('focus', () => { if (input.value.trim().length >= 3 && box.childElementCount) open(true); });
}

// The list shows what is inside the current map view (named sites first),
// capped so thousands of imported points don't flood the sidebar.
function renderResults(list) {
  const pending = unloadedCount();
  // A filter applies to every site, so until all squares are in, any number would be wrong.
  const loadingAll = pending && filtersActive();
  $('#result-count').textContent = loadingAll ? '…' : (list.length + pending).toLocaleString('it-IT');
  const ul = $('#results');
  ul.innerHTML = '';
  const bounds = map.getBounds();
  const inView = list.filter((f) => bounds.contains(f.geometry.coordinates));
  const sorted = inView.sort((a, b) => (!!a.properties.unnamed - !!b.properties.unnamed)
    || a.properties.name.localeCompare(b.properties.name, 'it'));
  const shown = sorted.slice(0, LIST_LIMIT);
  $('#results-note').textContent = loadingAll
    ? 'Carico i dati di tutte le zone per applicare il filtro…'
    : pending && map.getZoom() < DETAIL_ZOOM
    ? 'Elenco parziale: ingrandisci la mappa su una zona per vedere tutti i bunker.'
    : inView.length === list.length + pending
      ? ''
      : `${inView.length.toLocaleString('it-IT')} nella zona visibile${inView.length > LIST_LIMIT ? `, ne mostro ${LIST_LIMIT}` : ''}. Sposta o ingrandisci la mappa per vederne altre.`;
  for (const f of shown) {
    const p = f.properties;
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" data-id="${esc(p.id)}" class="${p.id === state.selectedId ? 'active' : ''}">
      <span class="swatch" style="background:${CATEGORIES[p.category]?.color || '#888'}"></span>
      <span><strong>${esc(p.name)}</strong><small>${esc(p.place)}</small></span></button>`;
    li.querySelector('button').onclick = () => select(p.id, { fly: true });
    ul.appendChild(li);
  }
}

function row(label, value) {
  return value ? `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>` : '';
}

function renderDetail(f) {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const approx = p.visibility === 'approximate';
  const coords = approx
    ? `≈ ${lat.toFixed(2)}, ${lng.toFixed(2)} (posizione approssimativa)`
    : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const sources = (p.sources || []).map((s) => {
    const url = safeUrl(s.url);
    return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || url)}</a>` : esc(s.title)}</li>`;
  }).join('');

  $('#detail-body').innerHTML = `
    <p class="kicker" style="color:${CATEGORIES[p.category]?.color || '#888'}">${esc(CATEGORIES[p.category]?.label)}</p>
    <h2>${esc(p.name)}</h2>
    ${p.alt_names?.length ? `<p class="alt">${p.alt_names.map(esc).join(' · ')}</p>` : ''}
    <p class="badge rel-${esc(p.reliability)}">${esc(RELIABILITY[p.reliability] || p.reliability)}</p>
    ${approx ? '<p class="note">Per sicurezza o tutela della proprietà, questa struttura è mostrata solo in modo approssimativo.</p>' : ''}
    <dl>
      ${row('Località', p.place)}
      ${row('Coordinate', coords)}
      ${row('Periodo', PERIODS[p.period])}
      ${row('Costruzione', p.built)}
      ${row('Origine', [countryName(p.country), p.builder].filter(Boolean).join(' – '))}
      ${row('Funzione originaria', p.function)}
      ${row('Dimensioni', p.dimensions)}
      ${row('Stato', STATUSES[p.status])}
      ${row('Visite e accessibilità', p.access)}
    </dl>
    <h3>Fonti</h3>
    ${sources ? `<ul class="sources">${sources}</ul>` : '<p class="note">Nessuna fonte indicata.</p>'}
  `;
  $('#detail').hidden = false;
}

// ---------- wiring ----------

let map;

function setSelectedState(id, value) {
  if (id != null) map.setFeatureState({ source: 'bunkers', id }, { selected: value });
}

function select(id, { fly } = {}) {
  const f = state.byId.get(id);
  if (!f) return;
  setSelectedState(state.selectedId, false);
  state.selectedId = id;
  setSelectedState(id, true);
  renderDetail(f);
  renderResults(filtered());
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  if (fly) {
    // Keep the pin clear of the detail card (right side on desktop, bottom sheet on phones).
    const mobile = window.matchMedia('(max-width: 720px)').matches;
    const padding = mobile ? { top: 0, left: 0, right: 0, bottom: Math.round(innerHeight * 0.5) } : { top: 0, left: 0, bottom: 0, right: 380 };
    map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 13), padding });
  }
}

function closeDetail() {
  setSelectedState(state.selectedId, false);
  state.selectedId = null;
  $('#detail').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
  renderResults(filtered());
}

function fitTo(list) {
  if (!list.length) return;
  const b = new maplibregl.LngLatBounds();
  list.forEach((f) => b.extend(f.geometry.coordinates));
  map.fitBounds(b, { padding: 60, maxZoom: 13 });
}

function refresh() {
  // A filter or search needs every site: fetch the remaining squares first.
  if (filtersActive() && unloadedCount()) { loadVisibleLayers({ all: true }); }
  updateSummary();
  const list = filtered();
  map.getSource('bunkers').setData({ type: 'FeatureCollection', features: list });
  renderResults(list);
  // setData drops feature-state; re-apply the highlight.
  if (state.selectedId) map.once('idle', () => setSelectedState(state.selectedId, true));
}

async function main() {
  buildFilters();

  map = new maplibregl.Map({
    container: 'map',
    style: await buildStyle(),
    center: [12, 45],
    zoom: 3,
    attributionControl: { compact: true },
  });
  window.bunkerAtlas = { map, state }; // handy for debugging in the browser console
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  map.addControl(new BasemapControl(), 'top-left');

  const [index] = await Promise.all([
    fetch(INDEX_URL).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
    new Promise((res) => map.on('load', res)),
  ]);
  state.layers = index.layers;
  const attribution = [...new Set(index.layers.map((l) => l.attribution).filter(Boolean))].join(' · ');
  addBunkerLayers(map, attribution);
  await loadVisibleLayers();
  map.on('moveend', () => {
    loadVisibleLayers().then((changed) => { if (!changed) renderResults(filtered()); });
  });

  const selectFromHash = async () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id || id === state.selectedId) return;
    // A link may point to a site in a layer that isn't loaded yet.
    if (!state.byId.has(id)) await loadVisibleLayers({ all: true });
    select(id, { fly: true });
  };
  selectFromHash();
  window.addEventListener('hashchange', selectFromHash);

  $('#close-detail').onclick = closeDetail;
  $('#fit-results').onclick = () => fitTo(filtered());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
  $('#toggle-sidebar').onclick = (e) => {
    const open = document.body.classList.toggle('sidebar-closed') === false;
    e.currentTarget.setAttribute('aria-expanded', open);
    setTimeout(() => map.resize(), 250);
  };
  if (window.matchMedia('(max-width: 720px)').matches) $('#toggle-sidebar').click();
}

main().catch((err) => {
  console.error(err);
  $('#detail-body').innerHTML = `<p class="note">Impossibile caricare i dati: ${esc(err.message)}</p>`;
  $('#detail').hidden = false;
});

// ---------- PWA: offline + install ----------

function setupPwa() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker non registrato:', err));
  }

  const banner = $('#offline-banner');
  const updateOnline = () => { banner.hidden = navigator.onLine; };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return;

  // Chrome/Edge/Android: show our own "Installa" button.
  let deferred = null;
  const btn = $('#install-app');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
  };
  window.addEventListener('appinstalled', () => { btn.hidden = true; });

  // iPhone/iPad Safari has no install prompt: show a one-time hint instead.
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let dismissed = false;
  try { dismissed = localStorage.getItem('iosHintDismissed') === '1'; } catch { /* storage blocked */ }
  if (ios && !dismissed) {
    $('#ios-install-hint').hidden = false;
    $('#ios-hint-close').onclick = () => {
      $('#ios-install-hint').hidden = true;
      try { localStorage.setItem('iosHintDismissed', '1'); } catch { /* ignore */ }
    };
  }
}

setupPwa();
