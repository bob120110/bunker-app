#!/usr/bin/env node
// One-off/maintenance: re-split already imported countries into map squares
// without downloading them again. Reads the single-file layout
// (data/osm/<cc>.geojson) or the existing squares, and rewrites them.
// Usage: node tools/resplit.mjs [CC ...]   (default: every imported country)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndex, writeCountry } from './lib/cells.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const layers = readIndex(ROOT).layers.filter((l) => l.id.startsWith('osm-'));
const byCountry = new Map();
for (const l of layers) {
  const cc = l.country || l.id.slice(4).toUpperCase();
  if (!byCountry.has(cc)) byCountry.set(cc, []);
  byCountry.get(cc).push(l);
}
const wanted = process.argv.slice(2).map((c) => c.toUpperCase());
for (const [cc, ls] of byCountry) {
  if (wanted.length && !wanted.includes(cc)) continue;
  const features = ls.flatMap((l) => JSON.parse(readFileSync(join(ROOT, l.file), 'utf8')).features);
  const out = writeCountry(ROOT, cc, features, { updated: ls[0].updated });
  console.log(`${cc}: ${features.length} bunkers in ${out.length} map squares`);
}
