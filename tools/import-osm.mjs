#!/usr/bin/env node
// Imports bunkers for one country from OpenStreetMap into data/osm/<cc>.geojson
// and registers the file in data/index.json.
//
// Usage:
//   node tools/import-osm.mjs IT
//   node tools/import-osm.mjs IT --bunkers raw-bunkers.json --places raw-places.json
//
// With --bunkers/--places it reads saved Overpass responses instead of
// downloading (handy when the public Overpass server is busy).
//
// Safety rules from the brief, applied here so they hold in the public files:
//   - anything inside a landuse=military area is dropped (likely still in use)
//   - access=private/no/military → stored only to 2 decimals (~1 km) and
//     flagged "approximate" (the app blurs these further, to ~5 km)
//
// OSM data is © OpenStreetMap contributors, ODbL. The output keeps a link to
// every source object and must stay under the ODbL (open, with attribution).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'BunkerAtlasImport/0.1 (open data project)';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// ---------- args ----------

const args = process.argv.slice(2);
const cc = (args[0] || '').toUpperCase();
if (!/^[A-Z]{2}$/.test(cc)) {
  console.error('Usage: node tools/import-osm.mjs <ISO country code> [--bunkers f] [--places f]');
  process.exit(2);
}
const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };

// ---------- Overpass ----------

const BUNKER_QUERY = `[out:json][timeout:300];
area["ISO3166-1"="${cc}"][admin_level=2]->.c;
(
  nwr["military"="bunker"](area.c);
  nwr["building"="bunker"](area.c);
  nwr["disused:military"="bunker"](area.c);
  nwr["abandoned:military"="bunker"](area.c);
  nwr["historic"="bunker"](area.c);
)->.b;
(way["landuse"="military"](area.c); relation["landuse"="military"](area.c);)->.mil;
.mil map_to_area->.milarea;
nwr.b(area.milarea)->.inmil;
(.b; - .inmil;)->.keep;
.keep out center tags;`;

const PLACE_QUERY = `[out:json][timeout:300];
area["ISO3166-1"="${cc}"][admin_level=2]->.c;
node["place"~"^(city|town|village)$"]["name"](area.c);
out qt;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let wait = 30_000;
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        const text = await res.text();
        if (!res.ok) { console.warn(`  ${url}: HTTP ${res.status}`); continue; }
        const json = JSON.parse(text);
        // Overpass answers HTTP 200 even when the query died half-way; the
        // error is only in "remark". A partial answer must never be imported.
        if (/error|timed out|out of memory/i.test(json.remark || '')) {
          console.warn(`  ${url}: ${json.remark.slice(0, 120)}`);
          continue;
        }
        if (!json.elements?.length) { console.warn(`  ${url}: empty answer`); continue; }
        return json;
      } catch (err) {
        console.warn(`  ${url}: ${err.message}`);
      }
    }
    console.warn(`  Overpass busy, retrying in ${wait / 1000}s…`);
    await sleep(wait);
    wait *= 2;
  }
  throw new Error('Overpass unavailable, try again later or pass saved files');
}

const load = async (file, query, label) => {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  console.log(`Downloading ${label} from Overpass…`);
  return overpass(query);
};

// ---------- tag mapping ----------

const BUNKER_TYPES = {
  pillbox: ['fortification', 'Postazione fortificata (pillbox)'],
  gun_emplacement: ['fortification', 'Postazione d\'artiglieria'],
  casemate: ['fortification', 'Casamatta'],
  blockhouse: ['fortification', 'Fortino (blockhouse)'],
  mg_nest: ['fortification', 'Nido di mitragliatrice'],
  tobruk: ['fortification', 'Postazione tipo Tobruk'],
  personnel_shelter: ['military', 'Ricovero per il personale'],
  air_raid_shelter: ['civil_shelter', 'Rifugio antiaereo'],
  bomb_shelter: ['civil_shelter', 'Rifugio antiaereo'],
  munitions: ['underground', 'Deposito munizioni'],
  technical: ['underground', 'Bunker tecnico'],
  command: ['underground', 'Posto di comando'],
  hardened_aircraft_shelter: ['military', 'Ricovero corazzato per aerei'],
  observation: ['other', 'Osservatorio'],
  'observation post': ['other', 'Osservatorio'],
  '14-18': ['military', 'Postazione della Prima guerra mondiale'],
  lookout: ['other', 'Posto di osservazione'],
};

const UNNAMED = {
  military: 'Bunker',
  civil_shelter: 'Rifugio',
  fortification: 'Postazione fortificata',
  underground: 'Installazione sotterranea',
  other: 'Struttura militare',
};

// Names that are really a date or a generic word ("14-18", "Entrata", "Bunker").
const JUNK_NAME = /^(\d{2,4}\s*-\s*\d{2,4}|entrata|entr[ée]e|ingresso|eingang|vhod|bunker|bunkr|fortino|casamatta|postazione|blockhaus|casemate|abri|unterstand|bunker allemand|deutscher bunker)$/i;
const cleanName = (n) => (n && !JUNK_NAME.test(n.trim()) ? n.trim() : '');

const lifecycle = (t, key) => t[key] ?? t[`disused:${key}`] ?? t[`abandoned:${key}`];

function category(t) {
  const bt = lifecycle(t, 'bunker_type');
  if (bt && BUNKER_TYPES[bt]) return BUNKER_TYPES[bt][0];
  if (t.shelter_type === 'air_raid' || /antiaere/i.test(t.name || '')) return 'civil_shelter';
  if (t.location === 'underground') return 'underground';
  return 'military';
}

function period(t) {
  const hp = (t['historic:period'] || t['historic:era'] || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (/world_war_(ii|2)|ww_?(ii|2)\b|second_world_war/.test(hp)) return 'ww2';
  if (/world_war_(i|1)\b|ww_?(i|1)\b|first_world_war|great_war|grande_guerra/.test(hp)) return 'ww1';
  if (/cold_war|guerra_fredda/.test(hp)) return 'cold_war';
  if (lifecycle(t, 'bunker_type') === '14-18') return 'ww1';
  // Mappers often put the period in the name ("14-18", "Bunker WWI", "… Seconda Guerra Mondiale").
  const name = t.name || '';
  if (/\bwwii\b|\bww2\b|seconda guerra|seconde guerre|zweite[rn]? weltkrieg|druga svetovna|\b(19)?39\s*-\s*(19)?45\b|atlantikwall|mur de l.atlantique|regelbau|\bwn\s?\d|\bstp\s?\d/i.test(name)) return 'ww2';
  if (/\b(19)?1[45]\s*-\s*(19)?18\b|\bwwi\b|\bww1\b|grande guerra|prima guerra|grande guerre|premi[eè]re guerre|erste[rn]? weltkrieg|prva svetovna|soška fronta|isonzo/i.test(name)) return 'ww1';
  if (/guerra fredda|guerre froide|kalte[rn]? krieg|hladna vojna/i.test(name)) return 'cold_war';
  if (/maginot|vallo alpino|ligne alpine|rupnik/i.test(name)) return 'interwar';
  const m = String(t.start_date || t.construction_date || hp).match(/\b(1[89]\d\d|20\d\d)\b/);
  if (m) {
    const y = +m[1];
    if (y >= 1914 && y <= 1918) return 'ww1';
    if (y >= 1919 && y <= 1938) return 'interwar';
    if (y >= 1939 && y <= 1945) return 'ww2';
    if (y >= 1946 && y <= 1991) return 'cold_war';
    return 'other';
  }
  return 'unknown';
}

function status(t) {
  if (t.tourism === 'museum' || t.museum) return 'museum';
  if (t.ruins === 'yes' || t.historic === 'ruins' || t.abandoned === 'yes' || t['abandoned:military']) return 'abandoned';
  if (t.disused === 'yes' || t['disused:military']) return 'abandoned';
  return 'unknown';
}

const PRIVATE = new Set(['private', 'no', 'military', 'restricted']);

function accessText(t) {
  if (t.tourism === 'museum') return t.opening_hours ? `Museo – orari: ${t.opening_hours}` : 'Museo';
  if (PRIVATE.has(t.access)) return 'Proprietà privata o accesso vietato';
  if (t.access === 'yes' || t.access === 'permissive') return 'Accessibile';
  return '';
}

function sources(e, t) {
  const type = { node: 'node', way: 'way', relation: 'relation' }[e.type];
  const out = [{ title: `OpenStreetMap – ${type}/${e.id}`, url: `https://www.openstreetmap.org/${type}/${e.id}` }];
  const wp = (t.wikipedia || '').match(/^([a-z-]{2,12}):(.+)$/);
  if (wp) out.push({ title: `Wikipedia (${wp[1]}) – ${wp[2]}`, url: `https://${wp[1]}.wikipedia.org/wiki/${encodeURIComponent(wp[2].replace(/ /g, '_'))}` });
  if (/^Q\d+$/.test(t.wikidata || '')) out.push({ title: `Wikidata – ${t.wikidata}`, url: `https://www.wikidata.org/wiki/${t.wikidata}` });
  return out;
}

const COUNTRY_NAME = (() => {
  try { return new Intl.DisplayNames(['it'], { type: 'region' }).of(cc) || cc; } catch { return cc; }
})();

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- nearest town ----------

function placeIndex(places) {
  const grid = new Map();
  const key = (lat, lon) => `${Math.floor(lat * 5)}:${Math.floor(lon * 5)}`; // 0.2° cells
  for (const p of places.elements) {
    if (!p.tags?.name) continue;
    const k = key(p.lat, p.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  return (lat, lon) => {
    let best = null; let bestD = Infinity;
    const cy = Math.floor(lat * 5); const cx = Math.floor(lon * 5);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const p of grid.get(`${cy + dy}:${cx + dx}`) || []) {
        const d = metres([lon, lat], [p.lon, p.lat]);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    return best && bestD < 20_000 ? best.tags.name : null;
  };
}

function metres(a, b) {
  const r = (x) => x * Math.PI / 180;
  const h = Math.sin(r(b[1] - a[1]) / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ---------- main ----------

const raw = await load(opt('--bunkers'), BUNKER_QUERY, 'bunkers');
const places = await load(opt('--places'), PLACE_QUERY, 'town names');
const nearest = placeIndex(places);

const curated = JSON.parse(readFileSync(join(ROOT, 'data/bunkers.geojson'), 'utf8')).features;
const nearCurated = (c) => curated.some((f) => metres(c, f.geometry.coordinates) < 150);

// Objects on a border are returned for both countries: keep the first copy.
const ownFile = `data/osm/${cc.toLowerCase()}.geojson`;
const otherLayers = existsSync(join(ROOT, 'data/index.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'data/index.json'), 'utf8')).layers.filter((l) => l.id !== 'curated' && l.file !== ownFile)
  : [];
const inOtherCountry = new Set(otherLayers.flatMap((l) => {
  try { return JSON.parse(readFileSync(join(ROOT, l.file), 'utf8')).features.map((f) => f.properties.id); } catch { return []; }
}));

const stats = { total: 0, noCoords: 0, nearCurated: 0, approximate: 0, otherCountry: 0 };
const seen = new Set();
const features = [];

for (const e of raw.elements) {
  if (!['node', 'way', 'relation'].includes(e.type)) continue;
  const id = `osm-${e.type[0]}${e.id}`;
  if (seen.has(id)) continue;
  seen.add(id);
  if (inOtherCountry.has(id)) { stats.otherCountry++; continue; }
  stats.total++;

  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat == null || lon == null) { stats.noCoords++; continue; }
  if (nearCurated([lon, lat])) { stats.nearCurated++; continue; }

  const approximate = PRIVATE.has(t.access);
  if (approximate) stats.approximate++;
  const coords = approximate ? [round(lon, 2), round(lat, 2)] : [round(lon, 6), round(lat, 6)];

  const cat = category(t);
  const bt = lifecycle(t, 'bunker_type');
  const town = nearest(lat, lon);
  const name = cleanName(t.name) || cleanName(t['name:it']);
  const alt = [t['name:de'], t['name:en'], t.alt_name, t.old_name].filter((n) => n && n !== name);
  const description = (t.description || t['description:it'] || '').slice(0, 300);

  const props = {
    id,
    name: name || `${UNNAMED[cat]}${town ? ` presso ${town}` : ''}`,
    unnamed: !name || undefined,
    alt_names: [...new Set(alt)],
    place: town ? `${town}` : '',
    country: cc,
    builder: t.operator || '',
    category: cat,
    period: period(t),
    built: t.start_date || t.construction_date || '',
    function: description || (bt && BUNKER_TYPES[bt]?.[1]) || '',
    dimensions: '',
    status: status(t),
    access: accessText(t),
    visibility: approximate ? 'approximate' : 'public',
    reliability: 'partial',
    origin: 'osm',
    sources: sources(e, t),
  };
  if (!props.place) props.place = COUNTRY_NAME;
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: props });
}

features.sort((a, b) => a.properties.id.localeCompare(b.properties.id));
if (!features.length) {
  console.error(`${cc}: no bunkers found — not writing anything (Overpass problem?)`);
  process.exit(1);
}

// ---------- write ----------

const outRel = `data/osm/${cc.toLowerCase()}.geojson`;
mkdirSync(join(ROOT, 'data/osm'), { recursive: true });
// One feature per line: readable diffs between imports, still valid JSON.
writeFileSync(join(ROOT, outRel),
  '{"type":"FeatureCollection","features":[\n' + features.map((f) => JSON.stringify(f)).join(',\n') + '\n]}\n');

// Areas the layer covers, as one box per occupied 5°×5° cell. A single bbox
// would span half the globe for countries with overseas territories (France),
// and then the app would download the file wherever the map is.
const CELL = 5;
const cells = new Set(features.map((f) => {
  const [x, y] = f.geometry.coordinates;
  return `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
}));
const bboxes = [...cells].sort().map((k) => {
  const [cx, cy] = k.split(':').map(Number);
  return [cx * CELL, cy * CELL, (cx + 1) * CELL, (cy + 1) * CELL];
});

const indexPath = join(ROOT, 'data/index.json');
const index = existsSync(indexPath)
  ? JSON.parse(readFileSync(indexPath, 'utf8'))
  : { layers: [{ id: 'curated', file: 'data/bunkers.geojson' }] };
index.layers = index.layers.filter((l) => l.id !== `osm-${cc.toLowerCase()}`);
index.layers.push({
  id: `osm-${cc.toLowerCase()}`,
  file: outRel,
  bboxes,
  count: features.length,
  attribution: '© OpenStreetMap contributors (ODbL)',
  updated: (raw.osm3s?.timestamp_osm_base || new Date().toISOString()).slice(0, 10),
});
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

const by = (k) => Object.entries(features.reduce((m, f) => ((m[f.properties[k]] = (m[f.properties[k]] || 0) + 1), m), {}))
  .sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ');
console.log(`${cc}: ${features.length} bunkers written to ${outRel}`);
console.log(`  skipped: ${stats.noCoords} without coordinates, ${stats.nearCurated} duplicates of curated sites, ${stats.otherCountry} already in another country's file`);
console.log(`  approximate (private access): ${stats.approximate}`);
console.log(`  named: ${features.filter((f) => !f.properties.unnamed).length}`);
console.log(`  category: ${by('category')}`);
console.log(`  period: ${by('period')}`);
console.log(`  status: ${by('status')}`);
