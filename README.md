# Copacabana Residence — rota até o lote

App web (PWA) de navegação interna do loteamento Copacabana Residence (Nova Betânia, Mossoró/RN).
O visitante lê o QR code na portaria, digita o número do lote (ou escolhe Clube, Saída,
Administração ou Smart Bodega) e segue a rota — de carro, moto ou a pé — com a posição em tempo
real, recálculo se sair do caminho e instruções por voz com o nome das ruas.

**Endereço:** https://coparesidence.github.io/

## Como funciona
- Tudo roda no próprio celular (sem servidor): o grafo de ruas, a mão única, as rotatórias e o
  cálculo da rota (Dijkstra com penalidade de conversão) estão em `app.js`; `index.html` é só a tela.
- `dados/` traz as ruas, os 596 lotes, a portaria, os pontos fixos, as 4 rotatórias e os nomes
  das ruas, extraídos do DWG do loteamento e georreferenciados.
- `voz/` guarda as falas gravadas (voz neural); sem elas o app usa a voz do próprio celular.
- `sw.js` + `manifest.webmanifest` fazem o app abrir como aplicativo e funcionar com sinal fraco.
- `vendor/leaflet/` — Leaflet 1.9.4 (licença BSD-2, em `vendor/leaflet/LICENSE`), servido
  daqui mesmo e conferido por SRI.

## Segurança
- Sem login, sem formulário enviado, sem cookies e sem coleta de dados: a localização fica no
  celular e só é usada para desenhar a rota.
- Política de conteúdo (CSP) restrita: scripts só do próprio site; imagens só do próprio site
  e dos servidores de mapa (Esri e OpenStreetMap).
- Os servidores de mapa recebem os pedidos das imagens da área vista (como em qualquer mapa).

A localização do celular só funciona em HTTPS (o GitHub Pages já serve assim).
