// Vocabularies shared by the map, filters and detail card.

export const CATEGORIES = {
  military:      { label: 'Bunker militari',          hint: 'WWI, WWII, Guerra fredda', color: '#c0392b' },
  civil_shelter: { label: 'Rifugi civili',            hint: 'Antiaerei, antiatomici',   color: '#2471a3' },
  fortification: { label: 'Fortificazioni',           hint: 'Casematte, fortezze',      color: '#7d6608' },
  underground:   { label: 'Installazioni sotterranee', hint: 'Comandi, depositi',        color: '#6c3483' },
  other:         { label: 'Altre strutture',          hint: 'Osservatori, gallerie',    color: '#4d5656' },
};

export const PERIODS = {
  ww1: 'Prima guerra mondiale',
  interwar: 'Periodo interbellico',
  ww2: 'Seconda guerra mondiale',
  cold_war: 'Guerra fredda',
  other: 'Altro',
  unknown: 'Non specificato',
};

export const STATUSES = {
  museum: 'Museo',
  abandoned: 'Abbandonato',
  reconverted: 'Riconvertito',
  demolished: 'Demolito',
  active: 'Attivo',
  unknown: 'Non specificato',
};

export const RELIABILITY = {
  verified: 'Verificato',
  partial: 'Documentato ma incompleto',
  unverified: 'Segnalazione da verificare',
};

// Grid size (degrees) used to blur "approximate" entries. ~5 km.
export const APPROX_GRID = 0.05;

// Street map: OpenFreeMap vector tiles (free, no API key, allowed for apps).
// Topographic and satellite are raster overlays drawn on top when selected.
export const STREET_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
export const MAP_FONT = 'Noto Sans Bold'; // must exist in the street style's glyphs

export const BASEMAPS = {
  streets: { label: 'Stradale' },
  topo: {
    label: 'Topografica',
    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
    maxzoom: 17,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  },
  satellite: {
    label: 'Satellite',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19,
    attribution: 'Immagini © Esri, Maxar, Earthstar Geographics',
  },
};

// Used only if the OpenFreeMap style can't be loaded (e.g. first visit offline).
export const FALLBACK_STREETS = {
  tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  maxzoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
};
