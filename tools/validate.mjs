#!/usr/bin/env node
// Validates the published data before it goes online.
// Usage: node tools/validate.mjs            (every layer in data/index.json)
//        node tools/validate.mjs <file>     (a single GeoJSON file)
import { readFileSync } from 'node:fs';
import { CATEGORIES, PERIODS, STATUSES, RELIABILITY } from '../js/config.js';

const ROOT = new URL('../', import.meta.url);
const files = process.argv[2]
  ? [process.argv[2]]
  : JSON.parse(readFileSync(new URL('data/index.json', ROOT), 'utf8')).layers.map((l) => new URL(l.file, ROOT));
const errors = [];
let total = 0;
const ids = new Set();
const VISIBILITY = ['public', 'approximate', 'hidden'];
const REQUIRED = ['id', 'name', 'place', 'country', 'category', 'period', 'status', 'visibility', 'reliability'];

const decimals = (n) => (String(n).split('.')[1] || '').length;

for (const file of files) {
const fc = JSON.parse(readFileSync(file, 'utf8'));
const name = String(file).split('/').slice(-2).join('/');
total += fc.features.length;
fc.features.forEach((f, i) => {
  const p = f.properties || {};
  const where = `${name} #${i} (${p.id || 'no id'})`;
  const err = (m) => errors.push(`${where}: ${m}`);

  for (const k of REQUIRED) if (!p[k]) err(`missing "${k}"`);
  if (p.id && ids.has(p.id)) err('duplicate id');
  ids.add(p.id);

  if (f.geometry?.type !== 'Point') err('geometry must be a Point');
  const [lng, lat] = f.geometry?.coordinates || [];
  if (!(lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90)) err('coordinates out of range');

  if (p.category && !CATEGORIES[p.category]) err(`unknown category "${p.category}"`);
  if (p.period && !PERIODS[p.period]) err(`unknown period "${p.period}"`);
  if (p.status && !STATUSES[p.status]) err(`unknown status "${p.status}"`);
  if (p.reliability && !RELIABILITY[p.reliability]) err(`unknown reliability "${p.reliability}"`);
  if (p.visibility && !VISIBILITY.includes(p.visibility)) err(`unknown visibility "${p.visibility}"`);

  // The raw file is public: protected entries must never carry precise data.
  if (p.visibility === 'hidden') err('"hidden" entries must not be in the published file');
  if (p.visibility === 'approximate' && (decimals(lng) > 2 || decimals(lat) > 2)) {
    err('"approximate" entries must be stored with at most 2 decimals');
  }
  if (p.status === 'active') err('currently active installations must not be published');

  // Brief: every entry needs at least one source.
  const srcs = p.sources || [];
  if (!srcs.length) err('at least one source is required');
  srcs.forEach((s) => { if (s.url && !/^https?:\/\//.test(s.url)) err(`invalid source url ${s.url}`); });
});
}

if (errors.length) {
  const shown = errors.slice(0, 50);
  console.error(`✗ ${errors.length} problem(s):\n  ${shown.join('\n  ')}${errors.length > 50 ? '\n  …' : ''}`);
  process.exit(1);
}
console.log(`✓ ${total} entries OK in ${files.length} file(s)`);
