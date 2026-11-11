# Bunker Atlas

An open world map of bunkers, air-raid shelters and fortifications, built from the brief in `Silly Project.pdf`.

This is the **static first version**: a map with no backend. It's plain HTML, CSS and JS with no build step, so it can be uploaded to any static host, including the Aruba plan that runs misere.it.

## What it does
- A world map built with MapLibre GL JS. Base maps: OpenStreetMap streets, OpenTopoMap terrain and Esri satellite.
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

## Data
All data lives in `data/bunkers.geojson`, one Point feature per structure. Run the validator after every edit:

```bash
node tools/validate.mjs
```

The validator checks required fields and allowed values, and that every entry has at least one source. It also enforces the safety rules. In this static version the raw file can be downloaded by anyone, so:
- `hidden` entries and active installations must not be in the file at all.
- `approximate` entries must be **stored** with at most 2 decimal places. Blurring the position only in the browser would not protect anything.

| Field | Values |
|---|---|
| `category` | `military`, `civil_shelter`, `fortification`, `underground`, `other` |
| `period` | `ww1`, `interwar`, `ww2`, `cold_war`, `other` |
| `status` | `museum`, `abandoned`, `reconverted`, `demolished` (`active` is not allowed) |
| `visibility` | `public`, `approximate` |
| `reliability` | `verified`, `partial`, `unverified` |

The 29 sample entries are well-known public sites, written from general knowledge. Their coordinates and sources still need checking, so they are all marked `unverified`.

## Roadmap
1. Static map with sample data (this version).
2. A bigger dataset: a catalogue of sources and an import from OpenStreetMap (`military=bunker`, `building=bunker`).
3. A backend for submissions with review, edit history and photo uploads. This needs hosting beyond Aruba static/PHP, or a PHP + MariaDB version of the API.
4. Downloadable public datasets.
