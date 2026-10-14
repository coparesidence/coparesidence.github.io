// Service worker do app Copacabana Residence.
// Só cuida de arquivos do PRÓPRIO site (nada de terceiros): REDE PRIMEIRO (sempre a versão
// mais nova) e, se o sinal cair dentro do loteamento, usa a última cópia salva. Imagens de
// mapa/satélite (outros domínios) não passam por aqui. Só guarda respostas 200 do mesmo site.
const CACHE = 'copa-v10';
const BASICO = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './icons/icon-192.png', './icons/icon-512.png',
  './dados/ruas.geojson', './dados/lotes.geojson', './dados/portaria.geojson',
  './dados/pois.geojson', './dados/rotatorias.geojson', './dados/nomes_ruas.json', './dados/acessos.geojson',
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // terceiros: o navegador cuida
  e.respondWith(fetch(req).then((r) => {
    if (r.ok && r.type === 'basic') { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
