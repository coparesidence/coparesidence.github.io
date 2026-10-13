# Copacabana Residence — rota até o lote

App web (PWA) de navegação interna do loteamento Copacabana Residence (Nova Betânia, Mossoró/RN).
O visitante lê o QR code na portaria, digita o número do lote (ou escolhe Clube, Saída ou
Administração) e segue a rota — com a posição em tempo real, recálculo se sair do caminho e
instruções por voz.

**Endereço:** https://coparesidence.github.io/

## Como funciona
- Tudo roda no próprio celular (sem servidor): o grafo de ruas, a mão única, as rotatórias e o
  cálculo da rota (Dijkstra com penalidade de conversão) estão em `index.html`.
- `dados/` traz as ruas, os 596 lotes, a portaria, os pontos (Clube, Saída, Administração) e as
  4 rotatórias, extraídos do DWG do loteamento e georreferenciados.
- `sw.js` + `manifest.webmanifest` fazem o app abrir como aplicativo e funcionar com sinal fraco.

A localização do celular só funciona em HTTPS (o GitHub Pages já serve assim).
