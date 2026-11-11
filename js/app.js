import { CATEGORIES, PERIODS, STATUSES, RELIABILITY, APPROX_GRID, BASEMAPS } from './config.js';

const DATA_URL = 'data/bunkers.geojson';
const $ = (sel) => document.querySelector(sel);

const state = {
  all: [],                                   // prepared features
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

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

function categoryColorExpr() {
  const expr = ['match', ['get', 'category']];
  for (const [k, v] of Object.entries(CATEGORIES)) expr.push(k, v.color);
  expr.push('#888');
  return expr;
}

// ---------- map ----------

function buildStyle() {
  const sources = {};
  const layers = [];
  for (const [key, b] of Object.entries(BASEMAPS)) {
    sources[`base-${key}`] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
    layers.push({ id: `base-${key}`, type: 'raster', source: `base-${key}`, layout: { visibility: key === 'streets' ? 'visible' : 'none' } });
  }
  return { version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf', sources, layers };
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
    for (const k of Object.keys(BASEMAPS)) {
      this.map.setLayoutProperty(`base-${k}`, 'visibility', k === key ? 'visible' : 'none');
    }
    this.el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.key === key));
  }
  onRemove() { this.el.remove(); }
}

function addBunkerLayers(map) {
  map.addSource('bunkers', {
    type: 'geojson',
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
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Open Sans Semibold'], 'text-size': 12 },
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

  map.on('click', 'clusters', async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource('bunkers').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  map.on('click', 'points', (e) => select(e.features[0].properties.id, { fly: false }));
  for (const layer of ['clusters', 'points']) {
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
  fill($('#filter-status'), STATUSES);
  $('#filter-period').addEventListener('change', (e) => { state.period = e.target.value; refresh(); });
  $('#filter-status').addEventListener('change', (e) => { state.status = e.target.value; refresh(); });
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; refresh(); });
}

function renderResults(list) {
  $('#result-count').textContent = list.length;
  const ul = $('#results');
  ul.innerHTML = '';
  const sorted = [...list].sort((a, b) => a.properties.name.localeCompare(b.properties.name, 'it'));
  for (const f of sorted) {
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
      ${row('Origine', [p.country, p.builder].filter(Boolean).join(' – '))}
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
  const f = state.all.find((x) => x.properties.id === id);
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
    style: buildStyle(),
    center: [12, 45],
    zoom: 3,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  map.addControl(new BasemapControl(), 'top-left');

  const [fc] = await Promise.all([
    fetch(DATA_URL).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
    new Promise((res) => map.on('load', res)),
  ]);
  state.all = prepare(fc);
  addBunkerLayers(map);
  refresh();

  const selectFromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && id !== state.selectedId) select(id, { fly: true });
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
