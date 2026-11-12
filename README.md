# Bunker Atlas

An open world map of bunkers, air-raid shelters and fortifications, built from the brief in `Silly Project.pdf`.

This is the **static first version**: a map with no backend. It's plain HTML, CSS and JS with no build step, so it can be uploaded to any static host, including the Aruba plan that runs misere.it.

## What it does
- A world map built with MapLibre GL JS. Base maps: OpenFreeMap streets (vector, free, no API key), OpenTopoMap terrain and Esri satellite. If OpenFreeMap is unreachable, the app falls back to openstreetmap.org tiles.
- One colour per category. Nearby points group into clusters until you zoom in.
- Filters by category, period and status, plus a text search on name, alternate names, place and country.
- A detail card for each structure, with a reliability label and sources.
- Link to a single structure with `#<id>`, for example `index.html#it-soratte`.
- Publication levels from the brief:
  - `public`: shown at its exact position.
  - `approximate`: snapped to a grid of about 5 km and labelled as approximate.
  - `hidden`: never published.

## Run locally
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000. Opening the file directly with `file://` won't work, because the data is loaded with `fetch`.

## Installable app (PWA)
The site can be installed on a phone or computer as an app.
- **Android / Chrome / Edge:** tap the **Installa** button in the top bar, or use "Install app" in the browser menu.
- **iPhone / iPad (Safari):** tap **Share**, then **Add to Home Screen**. The app shows a one-time hint about this.

Offline, the app still opens, with the bunker data and any map areas already viewed (up to about 3,000 map tiles are kept). `sw.js` handles this.

**On every deploy, bump `VERSION` in `sw.js`.** Otherwise installed copies keep serving the old files. Installing needs HTTPS (or `localhost`). `.htaccess` sets the right file type for the manifest and stops browsers caching `sw.js`.

To rebuild the PNG icons after changing `icons/icon.svg`, re-render it at 192, 512 and 180 (Apple) pixels, plus a 512 "maskable" version with the artwork scaled to about 72%.

## Data
The data is split into layers listed in `data/index.json`:
- `data/bunkers.geojson`: the curated list, written by hand.
- `data/osm/<country>.geojson`: bunkers imported from OpenStreetMap, one file per country. The app only downloads a country file when the map shows that country.

Run the validator after every change. It checks every layer:

```bash
node tools/validate.mjs
```

The validator checks required fields and allowed values, and that every entry has at least one source. It also enforces the safety rules. Anyone can download the raw files, so:
- `hidden` entries and active installations must not be in the files at all.
- `approximate` entries must be **stored** with at most 2 decimal places. Blurring the position only in the browser would not protect anything.

### Importing from OpenStreetMap
```bash
node tools/import-osm.mjs IT
```
This downloads every bunker-type object in the country from the Overpass API. That means `military=bunker`, `building=bunker`, `historic=bunker`, and disused or abandoned bunkers. It then:
- **drops anything inside a `landuse=military` area**, which is likely still in use
- stores bunkers with `access=private/no` only approximately
- names each bunker after the nearest town, and replaces junk names such as "14-18" or "Entrata"
- maps OSM tags onto our categories, periods and statuses
- links every entry back to its OSM object (and to Wikipedia or Wikidata if tagged)
- skips anything within 150 m of a curated site
- sets reliability to `partial` ("documentato ma incompleto")

If the public Overpass server is busy, save the query results yourself and pass them in with `--bunkers file.json --places file.json`.

**License:** imported data is © OpenStreetMap contributors under the ODbL. The map shows that attribution, and the data files must stay open under the same license.

| Field | Values |
|---|---|
| `category` | `military`, `civil_shelter`, `fortification`, `underground`, `other` |
| `period` | `ww1`, `interwar`, `ww2`, `cold_war`, `other`, `unknown` |
| `status` | `museum`, `abandoned`, `reconverted`, `demolished`, `unknown` (`active` is not allowed) |
| `visibility` | `public`, `approximate` |
| `reliability` | `verified`, `partial`, `unverified` |

The 29 sample entries are well-known public sites, written from general knowledge. Their coordinates and sources still need checking, so they are all marked `unverified`.

## Roadmap
1. Static map with sample data (this version).
2. A bigger dataset: OpenStreetMap import (Italy done; more countries next) and a catalogue of other sources.
3. A backend for submissions with review, edit history and photo uploads. This needs hosting beyond Aruba static/PHP, or a PHP + MariaDB version of the API.
4. Downloadable public datasets.
