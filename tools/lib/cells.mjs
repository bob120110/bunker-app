// Shared helpers for writing imported country data as map-grid files.
//
// Each country is split into CELL°×CELL° squares, one GeoJSON file per square
// (data/osm/<cc>/<cell>.geojson), each listed in data/index.json with its
// box, count and centre. The app then downloads only the squares on screen,
// and when zoomed out it draws one count bubble per square instead.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const CELL = 2; // degrees; ~150-220 km in Europe

const cellName = (x, y) => `${x < 0 ? 'w' : 'e'}${Math.abs(x)}${y < 0 ? 's' : 'n'}${Math.abs(y)}`;

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

export function readIndex(root) {
  const path = join(root, 'data/index.json');
  return existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { layers: [{ id: 'curated', file: 'data/bunkers.geojson' }] };
}

const isCountryLayer = (l, cc) => l.country === cc || l.id === `osm-${cc.toLowerCase()}`;

// Ids already published for other countries (objects on a border are
// returned by Overpass for both countries).
export function otherCountryIds(root, cc) {
  const ids = new Set();
  for (const l of readIndex(root).layers) {
    if (l.id === 'curated' || isCountryLayer(l, cc)) continue;
    try {
      for (const f of JSON.parse(readFileSync(join(root, l.file), 'utf8')).features) ids.add(f.properties.id);
    } catch { /* missing file: nothing to skip */ }
  }
  return ids;
}

export function writeCountry(root, cc, features, { updated }) {
  const lc = cc.toLowerCase();
  const dir = `data/osm/${lc}`;
  // Replace this country's previous files completely.
  rmSync(join(root, dir), { recursive: true, force: true });
  rmSync(join(root, `data/osm/${lc}.geojson`), { force: true }); // old single-file layout
  mkdirSync(join(root, dir), { recursive: true });

  const groups = new Map();
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates;
    const x = Math.floor(lng / CELL) * CELL;
    const y = Math.floor(lat / CELL) * CELL;
    const key = `${x}:${y}`;
    if (!groups.has(key)) groups.set(key, { x, y, features: [] });
    groups.get(key).features.push(f);
  }

  const layers = [];
  for (const { x, y, features: fs } of [...groups.values()].sort((a, b) => a.x - b.x || a.y - b.y)) {
    fs.sort((a, b) => a.properties.id.localeCompare(b.properties.id));
    const file = `${dir}/${cellName(x, y)}.geojson`;
    // One feature per line: readable diffs between imports, still valid JSON.
    writeFileSync(join(root, file),
      '{"type":"FeatureCollection","features":[\n' + fs.map((f) => JSON.stringify(f)).join(',\n') + '\n]}\n');
    const center = [0, 1].map((i) => round(fs.reduce((s, f) => s + f.geometry.coordinates[i], 0) / fs.length, 3));
    layers.push({
      id: `osm-${lc}-${cellName(x, y)}`,
      country: cc,
      file,
      bbox: [x, y, x + CELL, y + CELL],
      center,
      count: fs.length,
      attribution: '© OpenStreetMap contributors (ODbL)',
      updated,
    });
  }

  const index = readIndex(root);
  index.layers = index.layers.filter((l) => !isCountryLayer(l, cc)).concat(layers);
  writeFileSync(join(root, 'data/index.json'), JSON.stringify(index, null, 2) + '\n');
  return layers;
}
