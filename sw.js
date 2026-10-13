// Service worker do app Copacabana Residence.
// Arquivos do próprio site: REDE PRIMEIRO (sempre a versão mais nova) e, se o sinal
// cair dentro do loteamento, usa a última cópia salva. Leaflet (unpkg, versão fixa):
// cópia salva primeiro. Imagens de satélite (Esri) não passam por aqui.
const CACHE = 'copa-v2';
const BASICO = [
  './', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './dados/ruas.geojson', './dados/lotes.geojson', './dados/portaria.geojson',
  './dados/pois.geojson', './dados/rotatorias.geojson',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(BASICO.map((u) => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const guardar = (req, resp) => { const cp = resp.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return resp; };

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then((r) => (r.ok ? guardar(req, r) : r))
      .catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (url.hostname === 'unpkg.com') {
    e.respondWith(caches.match(req).then((m) => m || fetch(req).then((r) => guardar(req, r))));
  }
});
