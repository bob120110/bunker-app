#!/usr/bin/env node
// Fills in the period of imported sites that have none, using rules that are
// reasonably safe, and marks every guess so the app can show it as "probabile".
//
// Usage:
//   node tools/infer-periods.mjs                 dry run: counts + samples, no changes
//   node tools/infer-periods.mjs --apply         write the results into data/osm/
//   --coast <geojson> --borders <geojson>        enable the location rules
//                                                (Natural Earth 10m coastline and
//                                                 admin-0 land boundary lines)
//   --no-wikidata                                skip the Wikidata lookup
//
// Order of precedence (first match wins):
//   1. Wikidata: construction/opening date on the linked item → period_source "wikidata"
//   2. Name rules: words that identify a fortification line or building type
//   3. Location rules: Atlantic Wall coast, Westwall and Maginot border zones
// Rules 2-3 set period_source "inferred:<rule>" (shown as "probabile").
// Periods that came from OpenStreetMap are never touched. Periods this tool set
// earlier (period_source present) are recalculated from scratch on every run,
// so improved rules also fix earlier guesses.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndex } from './lib/cells.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const UA = 'BunkerAtlasDataCheck/0.6 (open data project)';

// ---------- rules ----------

const text = (p) => [p.name, ...(p.alt_names || []), p.function].filter(Boolean).join(' | ').toLowerCase();
const inNE = ([lng, lat]) => lng > 5.3 && lat > 47.3; // north-eastern France
const inEurope = ([lng, lat]) => lng > -11 && lng < 32 && lat > 41 && lat < 72; // mainland Europe, not overseas territories
// Older fortresses (pre-1914) sit in the same zones; never date them by location.
const OLD_FORT = /\b(fort|forte|feste|festung|redoute|citadelle|zitadelle|ch[âa]teau|tour|tower|martello|castle|vestvold\w*)\b/;

const NAME_RULES = [
  // WWI
  { id: 'hollandstellung', period: 'ww1', countries: ['BE'], re: /hollandstellung/, why: 'Hollandstellung, linea tedesca 1916–18' },
  { id: 'linea-cadorna', period: 'ww1', countries: ['IT'], re: /linea cadorna/, why: 'Linea Cadorna, 1916–18' },
  { id: 'weltkrieg-1', period: 'ww1', re: /\b(1\.|i\.|erster)\s*weltkrieg/, why: '"1. Weltkrieg" nel nome' },
  // Interwar fortification lines
  { id: 'westwall-name', period: 'interwar', countries: ['DE'], re: /westwall|siegfried/, why: 'Westwall (Linea Sigfrido), 1936–40' },
  { id: 'neckar-enz', period: 'interwar', countries: ['DE'], re: /neckar-enz/, why: 'Neckar-Enz-Stellung, 1935–38' },
  { id: 'pfl', period: 'interwar', countries: ['BE'], re: /pfl|position fortifi[ée]e de li[èe]ge/, why: 'Posizione fortificata di Liegi, anni 1930' },
  { id: 'deveze', period: 'interwar', countries: ['BE'], re: /dev[èe]ze/, why: 'Linea Devèze, 1934–35' },
  { id: 'vallo-alpino', period: 'interwar', countries: ['IT'], re: /\b(werk|opera|op[ée]ra)\s*\d+/, why: '"Opera/Werk N": Vallo Alpino, 1931–42' },
  { id: 'maginot-name', period: 'interwar', countries: ['FR'], re: /\b(ouvrage|bloc|casemate|observatoire)\b/, where: inNE, why: 'Ouvrage/bloc/casemate nel nord-est: Linea Maginot, 1929–40' },
  { id: 'ijssellinie', period: 'cold_war', countries: ['NL'], re: /ijssellinie/, why: 'IJssellinie, 1951–64' },
  { id: 'dutch-lines', period: 'interwar', countries: ['NL'], re: /groepsschuilplaats|\bkazemat|grebbe|peel-raam|waterlinie/, why: 'Linee difensive olandesi, 1918–40' },
  { id: 'rupnik', period: 'interwar', countries: ['SI'], re: /alpsk\w* zid|rupnik/, why: 'Vallo Alpino / Linea Rupnik, 1931–41' },
  // WWII
  { id: 'tobruk', period: 'ww2', re: /tobruk|tobrouk|ringstand|ringstellung/, why: 'Postazione "Tobruk", 1942–45' },
  { id: 'weltkrieg-2', period: 'ww2', re: /\b(2\.|ii\.|zweiter)\s*weltkrieg/, why: '"2. Weltkrieg" nel nome' },
  { id: 'luftschutz', period: 'ww2', countries: ['DE', 'AT'], re: /hochbunker|tiefbunker|luftschutz|winkelturm|splitterschutz|spitzbunker|einmannbunker|flakturm|\bflak|flastg|schirachbunker|flugwache/, why: 'Rifugio antiaereo o postazione contraerea tedesca, 1940–45' },
  { id: 'atlantikwall-name', period: 'ww2', countries: ['FR', 'BE', 'NL', 'DK', 'NO'], re: /\bflak\b|encuvement|\bcuve\b|deutscher|\bwn\s?\d|\bwr\s?\d|\bstp\b|st[üu]tzpunkt|widerstandsnest|regelbau|\br\s?6\d\d\b|w[üu]rzburg|freya|mammut|maultier|seeburg|stellung/, why: 'Termini del Vallo Atlantico (Regelbau, WN, Flak…), 1942–44' },
  { id: 'rifugio-antiaereo', period: 'ww2', countries: ['IT'], re: /antiaere/, why: 'Rifugio antiaereo, 1940–45' },
  { id: 'swiss-army', period: 'ww2', countries: ['CH'], re: /infanteriebunker|infanteriewerk|artilleriewerk|\blmg\b|unterstand|felsenwerk|infanteriekanonen/, why: 'Fortificazioni svizzere del Ridotto nazionale, per lo più 1937–45' },
  // Central and Eastern Europe
  { id: 'peter-fortress', period: 'ww1', countries: ['EE'], re: /peeter suure merekindlus/, why: 'Fortezza navale di Pietro il Grande, 1912–17' },
  { id: 'latvian-riflemen', period: 'ww1', countries: ['LV'], re: /str[ēe]lnieku/, why: 'Fucilieri lettoni, 1915–17' },
  { id: 'cs-fortification-code', period: 'interwar', countries: ['CZ', 'SK'], re: /^[^/]{1,10}\/\d+[a-z]?\/|\b[a-zžř]{1,3}-[a-zž]{1,3}\s?\d|řop|lehk[éeý] opevn|t[ěe]žk[éeý] opevn|škvorov/, why: 'Sigla delle fortificazioni cecoslovacche (es. "A-160", "K-S 14"), 1935–38' },
  { id: 'polish-lines', period: 'interwar', countries: ['PL'], re: /wa[łl] pomorsk|pommernstellung|\bowś\b|obszar warown|\bm\.?\s?r\.?\s?u\b|mi[ęe]dzyrzeck|ostwall|pz\.?\s?w\.?\s?\d|panzerwerk/, why: 'Vallo di Pomerania, Ostwall/MRU, Area fortificata della Slesia, 1932–39' },
  { id: 'baltic-interwar', period: 'interwar', countries: ['LV'], re: /starpkaru/, why: '"Starpkaru" (tra le due guerre) nel nome' },
  { id: 'molotov-line', period: 'ww2', countries: ['PL', 'LT', 'LV', 'EE'], re: /mo[łl]otov|mo[łl]otow/, why: 'Linea Molotov, 1940–41' },
  { id: 'kochbunker', period: 'ww2', countries: ['PL'], re: /kochbunker|koch-bunker/, why: 'Kochbunker, 1944–45' },
  { id: 'snp', period: 'ww2', countries: ['SK'], re: /\bsnp\b|povstalec/, why: 'Insurrezione nazionale slovacca, 1944' },
  { id: 'baltic-partisans', period: 'cold_war', countries: ['EE', 'LV', 'LT'], re: /metsaven|partizan|apygardos/, why: 'Partigiani antisovietici ("Fratelli della foresta"), 1944–53' },
  { id: 'missile-base', period: 'cold_war', countries: ['EE', 'LV', 'LT', 'PL', 'CZ', 'SK'], re: /raket|rakeet|raķe|r-12\b|r-14\b|branduolin|jadern/, why: 'Base missilistica o deposito nucleare sovietico, 1958–91' },
  { id: 'cs-civil-defence', period: 'cold_war', countries: ['CZ', 'SK'], re: /kryt civiln|\bco\b|čsla|civiln[ií] obrany/, why: 'Protezione civile cecoslovacca (CO) o Esercito popolare (ČSLA), 1950–89' },
  // Greece and the former Yugoslavia
  { id: 'bizani', period: 'other', countries: ['GR'], re: /μπιζαν/, why: 'Forti di Bizani, guerre balcaniche 1912–13' },
  { id: 'metaxas-line', period: 'interwar', countries: ['GR'], re: /οχυρ|metaxas|μεταξ/, where: ([, lat]) => lat > 40.9, why: 'Forte nel nord della Grecia: Linea Metaxas, 1936–41' },
  { id: 'german-gr', period: 'ww2', countries: ['GR'], re: /γερμαν/, why: '"Tedesco" nel nome: occupazione 1941–44' },
  { id: 'jna', period: 'cold_war', countries: ['SI', 'HR', 'BA', 'RS', 'ME', 'MK', 'XK'], re: /\bjna\b|narodn\w* armij|karaul/, why: 'Esercito popolare jugoslavo (JNA) o posto di frontiera, 1945–91' },
  // A year in the name
  { id: 'year-ww2', period: 'ww2', re: /\b19(39|4[0-5])\b/, why: 'Anno 1939–45 nel nome' },
  { id: 'year-ww1', period: 'ww1', re: /\b191[4-8]\b/, why: 'Anno 1914–18 nel nome' },
  // Western and Northern Europe
  { id: 'world-war-words', period: 'ww2', re: /segunda guerra mundial|second world war|world war (ii|2)\b|\bww ?ii\b|seconde guerre mondiale|andre verdenskrig|anden verdenskrig|andra världskriget|toisen maailmansodan/, why: '"Seconda guerra mondiale" nel nome o nella descrizione' },
  { id: 'uk-older', period: 'other', countries: ['GB', 'IE'], re: /victorian|napoleonic|palmerston|martello|georgian|\b1[78]\d\d\b/, why: 'Difese vittoriane o napoleoniche, prima del 1914' },
  { id: 'uk-cold-war', period: 'cold_war', countries: ['GB'], re: /\broc\b|royal observer corps|monitoring post|nuclear|\brsg\b|regional seat|rgh?q|emergency cent|war room/, why: 'Royal Observer Corps o bunker antiatomico britannico, 1955–91' },
  { id: 'uk-1940', period: 'ww2', countries: ['GB'], re: /pillbox|\bfw3|type 2[2-8]\b|spigot|home guard|battle h\.?q|anti-?tank|stop line|chain home|gun emplacement|blockhouse/, why: 'Pillbox e difese britanniche anti-invasione, 1940–41' },
  { id: 'dk-old', period: 'other', countries: ['DK'], re: /vestvold|voldpunkt|befæstning|krudtmagasin/, why: 'Fortificazioni di Copenaghen, 1886–1918' },
  { id: 'dk-cold-war', period: 'cold_war', countries: ['DK', 'NO', 'SE', 'FI'], re: /regeringsanl|\brrgc\b|stril|bunker for regjering|ledningsbunker/, why: 'Bunker governativo o radar della Guerra fredda, 1950–90' },
  { id: 'per-albin', period: 'ww2', countries: ['SE'], re: /per albin|korvlinje|skånelinje/, why: 'Linea Per Albin (Svezia), 1939–45' },
  { id: 'salpa', period: 'ww2', countries: ['FI'], re: /salpa|\bkorsu|ter[äa]spes[äa]ke|kk-pes[äa]ke|virolahti|mannerheim/, why: 'Linea Salpa / Mannerheim, ricoveri "korsu", 1939–44' },
  { id: 'linea-p', period: 'cold_war', countries: ['ES'], re: /l[íi]nea p\b|organizaci[óo]n defensiva de los pirineos|\bodp\b/, why: 'Linea P dei Pirenei, 1944–59' },
  { id: 'spanish-civil-war', period: 'interwar', countries: ['ES'], re: /guerra civil|republican|trinchera|frente\b|refugi|antiaeri|nacional/, why: 'Guerra civile spagnola, 1936–39' },
  // Hardened aircraft shelters: a 1960s–80s design everywhere.
  { id: 'aircraft-shelter', period: 'cold_war', re: /ricovero corazzato per aerei/, why: 'Ricovero corazzato per aerei: tipico 1965–90' },
  // Cold War
  { id: 'cold-war-military', period: 'cold_war', re: /\bmace\b|\bnike\b|\bhawk\b|pershing|raketenstellung|\bnato\b|\botan\b|bundeswehr|u\.?s\.? army|nva\b/, why: 'Basi missilistiche e militari NATO/Bundeswehr, 1950–90' },
  { id: 'civil-defence', period: 'cold_war', countries: ['CH', 'DE', 'AT'], re: /zivilschutz|schutzraum|atombunker|abc-schutz|regierungsbunker/, why: 'Protezione civile/antiatomica, 1950–90' },
  // Albania: the Hoxha programme built bunkers everywhere (1967–86); older
  // structures are rare enough that "probabile" is a fair label for any site.
  { id: 'albania-hoxha', period: 'cold_war', countries: ['AL'], re: /(?:)/, why: 'Albania: programma di bunkerizzazione di Hoxha, 1967–86' },
];

// ---------- geometry (optional) ----------

function loadLines(file, keep = () => true) {
  const segs = [];
  for (const f of JSON.parse(readFileSync(file, 'utf8')).features) {
    if (!keep(f.properties || {})) continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const l of lines) for (let i = 1; i < l.length; i++) segs.push([l[i - 1], l[i]]);
  }
  // Grid index, 0.25° cells, each segment registered in every cell its box touches.
  const grid = new Map();
  for (const s of segs) {
    const [x0, x1] = [Math.min(s[0][0], s[1][0]), Math.max(s[0][0], s[1][0])];
    const [y0, y1] = [Math.min(s[0][1], s[1][1]), Math.max(s[0][1], s[1][1])];
    for (let x = Math.floor(x0 * 4); x <= Math.floor(x1 * 4); x++) for (let y = Math.floor(y0 * 4); y <= Math.floor(y1 * 4); y++) {
      const k = `${x}:${y}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s);
    }
  }
  return { count: segs.length, grid };
}

// Distance in km from a point to the nearest indexed segment, searching up to `maxKm`.
function distKm(idx, [lng, lat], maxKm) {
  const kx = 111.32 * Math.cos(lat * Math.PI / 180); const ky = 110.57;
  const r = Math.ceil((maxKm / 111) * 4) + 1;
  let best = Infinity;
  const cx = Math.floor(lng * 4); const cy = Math.floor(lat * 4);
  for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
    for (const [[ax, ay], [bx, by]] of idx.grid.get(`${x}:${y}`) || []) {
      const ux = (bx - ax) * kx; const uy = (by - ay) * ky;
      const px = (lng - ax) * kx; const py = (lat - ay) * ky;
      const t = Math.max(0, Math.min(1, (px * ux + py * uy) / (ux * ux + uy * uy || 1)));
      const d = Math.hypot(px - t * ux, py - t * uy);
      if (d < best) best = d;
    }
  }
  return best;
}

const GEO_RULES = [];
const coastFile = opt('--coast'); const bordersFile = opt('--borders');
if (coastFile) {
  const coast = loadLines(coastFile);
  GEO_RULES.push({ id: 'atlantikwall-coast', period: 'ww2', countries: ['FR', 'BE', 'NL', 'DK', 'NO', 'GB'], why: 'Entro 2 km dalla costa: Vallo Atlantico, Vallo Mediterraneo o difese costiere britanniche, 1940–45', test: (c) => inEurope(c) && distKm(coast, c, 2) <= 2 });
}
if (bordersFile) {
  const pair = (a, list) => (p) => {
    const l = p.ADM0_A3_L || p.adm0_a3_l; const r = p.ADM0_A3_R || p.adm0_a3_r;
    return (l === a && list.includes(r)) || (r === a && list.includes(l));
  };
  // The Westwall ended near Kleve: the Dutch border north of it had none.
  const westwallAll = loadLines(bordersFile, pair('DEU', ['FRA', 'LUX', 'BEL', 'NLD']));
  const westwall = { grid: new Map([...westwallAll.grid].map(([k, segs]) => [k, segs.filter((sg) => sg[0][1] < 51.9 && sg[1][1] < 51.9)])) };
  const maginot = loadLines(bordersFile, pair('FRA', ['DEU', 'LUX']));
  GEO_RULES.push({ id: 'westwall-zone', period: 'interwar', countries: ['DE'], why: 'Entro 25 km dal confine occidentale tedesco: Westwall, 1936–40', test: (c) => distKm(westwall, c, 25) <= 25 });
  GEO_RULES.push({ id: 'maginot-zone', period: 'interwar', countries: ['FR'], why: 'Entro 15 km dal confine con Germania/Lussemburgo: Linea Maginot, 1929–40', test: (c) => c[1] > 47.4 && distKm(maginot, c, 15) <= 15 });
}

// ---------- Wikidata ----------

const yearToPeriod = (y) => (y >= 1914 && y <= 1918 ? 'ww1' : y >= 1919 && y <= 1938 ? 'interwar'
  : y >= 1939 && y <= 1945 ? 'ww2' : y >= 1946 && y <= 1991 ? 'cold_war' : 'other');

async function wikidataYears(qids) {
  const out = new Map();
  for (let i = 0; i < qids.length; i += 25) {
    const ids = qids.slice(i, i + 25).join('|');
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&maxlag=5&ids=${ids}`;
    let j = null;
    for (let a = 0; a < 8 && !j; a++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        const body = r.ok ? await r.json() : null;
        if (body?.entities) j = body; // an "error" answer (e.g. maxlag) has no entities
      } catch { /* network error: retry */ }
      if (!j) await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * 2 ** a)));
    }
    if (!j) {
      console.error(`Wikidata unavailable for ${ids}: aborting so no site is dated inconsistently.`);
      process.exit(1);
    }
    for (const [q, e] of Object.entries(j?.entities || {})) {
      for (const prop of ['P571', 'P580', 'P1619', 'P729']) { // inception, start, opening, service entry
        const t = e.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value?.time;
        const m = t && t.match(/^\+(\d{4})/);
        if (m) { out.set(q, { year: +m[1], prop }); break; }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

// ---------- run ----------

const layers = readIndex(ROOT).layers.filter((l) => l.country);
const files = layers.map((l) => ({ l, fc: JSON.parse(readFileSync(join(ROOT, l.file), 'utf8')) }));
const undated = files.flatMap(({ fc }) => fc.features)
  .filter((f) => f.properties.period === 'unknown' || f.properties.period_source);
const previous = new Map(undated.map((f) => [f.properties.id, f.properties.period]));

const wd = new Map();
if (!args.includes('--no-wikidata')) {
  const qids = [...new Set(undated.flatMap((f) => f.properties.sources.map((s) => s.url.match(/wikidata\.org\/wiki\/(Q\d+)/)?.[1]).filter(Boolean)))];
  console.log(`Wikidata: looking up ${qids.length} linked items…`);
  for (const [k, v] of await wikidataYears(qids)) wd.set(k, v);
}

const hits = new Map(); // rule id → { rule, list }
const record = (rule, f, period) => {
  if (!hits.has(rule.id)) hits.set(rule.id, { rule, list: [] });
  hits.get(rule.id).list.push({ f, period });
};
const WD_RULE = { id: 'wikidata', why: 'Data di costruzione/apertura su Wikidata' };

for (const f of undated) {
  const p = f.properties; const c = f.geometry.coordinates;
  const q = p.sources.map((s) => s.url.match(/wikidata\.org\/wiki\/(Q\d+)/)?.[1]).find((x) => x && wd.has(x));
  if (q) { record(WD_RULE, f, yearToPeriod(wd.get(q).year)); continue; }
  const t = text(p);
  const nr = NAME_RULES.find((r) => (!r.countries || r.countries.includes(p.country)) && (!r.where || r.where(c)) && r.re.test(t));
  if (nr) { record(nr, f, nr.period); continue; }
  if (!p.unnamed && OLD_FORT.test(t)) continue;
  const gr = GEO_RULES.find((r) => (!r.countries || r.countries.includes(p.country)) && r.test(c));
  if (gr) record(gr, f, gr.period);
}

// ---------- report ----------

const LABEL = { ww1: 'WWI', interwar: 'interbellico', ww2: 'WWII', cold_war: 'Guerra fredda', other: 'altro' };
let total = 0;
console.log(`\nUndated sites: ${undated.length.toLocaleString('en')}\n`);
for (const { rule, list } of hits.values()) {
  total += list.length;
  const periods = Object.entries(list.reduce((m, h) => ((m[h.period] = (m[h.period] || 0) + 1), m), {}))
    .map(([k, n]) => `${LABEL[k]} ${n}`).join(', ');
  const byCc = Object.entries(list.reduce((m, h) => ((m[h.f.properties.country] = (m[h.f.properties.country] || 0) + 1), m), {}))
    .map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`${rule.id.padEnd(20)} ${String(list.length).padStart(6)}  → ${periods}   [${byCc}]`);
  console.log(`${''.padEnd(28)}${rule.why}`);
  const named = list.filter((h) => !h.f.properties.unnamed);
  const pool = named.length ? named : list;
  const step = Math.max(1, Math.floor(pool.length / 4));
  for (const h of pool.filter((_, i) => i % step === 0).slice(0, 4)) {
    console.log(`${''.padEnd(28)}e.g. ${h.f.properties.name} (${h.f.properties.place}, ${h.f.properties.id})`);
  }
}
if (!coastFile || !bordersFile) console.log('\n(location rules skipped: pass --coast and --borders to enable them)');
console.log(`\nWould date ${total.toLocaleString('en')} of ${undated.length.toLocaleString('en')} undated sites; ${(undated.length - total).toLocaleString('en')} stay "Non specificato".`);

// What changes compared with the periods already in the files.
const changed = [...hits.values()].flatMap(({ list }) => list).filter(({ f, period }) => previous.get(f.properties.id) !== period);
const reset = undated.filter((f) => f.properties.period_source && ![...hits.values()].some(({ list }) => list.some((h) => h.f === f)));
console.log(`Compared with the current files: ${changed.length.toLocaleString('en')} sites get a new or different period, ${reset.length} earlier guesses go back to "Non specificato".`);
const moves = changed.reduce((m, { f, period }) => { const k = `${previous.get(f.properties.id)} → ${period}`; m[k] = (m[k] || 0) + 1; return m; }, {});
for (const [k, n] of Object.entries(moves).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

if (APPLY) {
  for (const f of undated) {
    delete f.properties.period_source;
    delete f.properties.period_note;
    f.properties.period = 'unknown';
  }
  for (const { rule, list } of hits.values()) {
    for (const { f, period } of list) {
      f.properties.period = period;
      f.properties.period_source = rule.id === 'wikidata' ? 'wikidata' : `inferred:${rule.id}`;
      f.properties.period_note = rule.why;
    }
  }
  for (const { l, fc } of files) {
    writeFileSync(join(ROOT, l.file),
      '{"type":"FeatureCollection","features":[\n' + fc.features.map((f) => JSON.stringify(f)).join(',\n') + '\n]}\n');
  }
  console.log(`Applied to ${files.length} files.`);
} else {
  console.log('Dry run: nothing was changed. Add --apply to write.');
}
