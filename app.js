/* ==================================================================
   Copacabana Residence — navegação interna até o lote
   Dois modos, mesmo motor de roteamento:
     • MODO REAL  → lê dados/ruas.geojson, dados/lotes.geojson,
                    dados/portaria.geojson (saídos do DWG georreferenciado)
     • MODO EXEMPLO → gera uma malha de quadras/ruas/lotes (protótipo)
   O motor constrói um grafo a partir das LINHAS DE RUA e "gruda"
   portaria e lotes na rua mais próxima; rota = Dijkstra (offline).
================================================================== */

const CONFIG = {
  dados: {
    ruas:     'dados/ruas.geojson',
    lotes:    'dados/lotes.geojson',
    portaria: 'dados/portaria.geojson',
  },
  velocidadeMotoKmh: 18,
};

/* ---------------- geometria (lat/lng ↔ metros) ---------------- */
const R = 6378137;
const rad = Math.PI/180;
function metros(a, b){                     // distância aprox. entre [lat,lng]
  const dLat=(b[0]-a[0])*rad, dLng=(b[1]-a[1])*rad, lat=(a[0]+b[0])/2*rad;
  return Math.hypot(dLng*Math.cos(lat), dLat) * R;
}
function projetarNoSegmento(P, A, B){       // projeção de P no segmento AB
  const xy = (pt)=>[ (pt[1]-A[1])*Math.cos(A[0]*rad)*R*rad, (pt[0]-A[0])*R*rad ];
  const p=xy(P), b=xy(B);
  const len2 = b[0]*b[0]+b[1]*b[1] || 1;
  let t = (p[0]*b[0]+p[1]*b[1])/len2;
  t = Math.max(0, Math.min(1, t));
  const q=[b[0]*t, b[1]*t];
  const lat = A[0] + q[1]/(R*rad);
  const lng = A[1] + q[0]/(Math.cos(A[0]*rad)*R*rad);
  return { latlng:[lat,lng], dist: Math.hypot(p[0]-q[0], p[1]-q[1]) };
}

/* ---------------- grafo de ruas (direcionado p/ mão única) ----------------
   lines = [{path:[[lat,lng],...], ow:0|1|-1}]  ow: 0=mão dupla, 1=sentido do
   caminhamento da linha, -1=sentido inverso. */
function buildGraph(lines){
  const nodes=new Map(), adj=new Map(), edges=[];
  const key=(ll)=> ll[0].toFixed(6)+','+ll[1].toFixed(6);
  const nid=(ll)=>{ const k=key(ll); if(!nodes.has(k)){nodes.set(k,ll);adj.set(k,[]);} return k; };
  for(const line of lines){
    const path=line.path||line, ow=line.ow||0, st=line.st??null;
    for(let i=0;i+1<path.length;i++){
      const a=nid(path[i]), b=nid(path[i+1]);
      if(a===b) continue;
      const w=metros(nodes.get(a),nodes.get(b));
      if(ow>=0) adj.get(a).push({to:b,w,st});   // permite a->b (dupla ou fwd)
      if(ow<=0) adj.get(b).push({to:a,w,st});   // permite b->a (dupla ou rev)
      edges.push([a,b,ow,st]);
    }
  }
  return {nodes,adj,edges};
}
// ---- ROTATÓRIAS: injeta anel de circulação ANTI-HORÁRIA (tráfego BR, mão direita) ----
// Cada rua que chega na rotatória é reconectada ao anel; remove o cruzamento reto
// pelo centro, forçando a rota a contornar (retornos/conversões passam pela rotatória).
function injectRotatorias(g, rots){
  const skip=(k)=> typeof k==='string' && (k[0]==='L'||k==='PORTARIA'||k.startsWith('p_')||k.startsWith('POI')||k.startsWith('RT')||k.startsWith('RA'));
  // grau não-direcionado de cada nó (cruzamento = grau ≥ 3)
  const deg=new Map();
  for(const e of g.edges){ if(!e) continue; deg.set(e[0],(deg.get(e[0])||0)+1); deg.set(e[1],(deg.get(e[1])||0)+1); }
  for(const R of rots){
    const M=[R.lat,R.lng], r=Math.max(R.raio||4, 3), cos0=Math.cos(M[0]*rad);
    // 1) TODOS os cruzamentos (grau≥3) a até 20 m do círculo do DWG viram a rotatória.
    //    A malha tem 2–3 cruzamentos "picados" em volta de cada ilha; usar só o mais
    //    próximo deixava ruas chegando FORA do anel (ex.: a diagonal dos lotes 440–448 na
    //    rot.2) → a rota entrava, saía e voltava em gancho. Sem nenhum a 20 m, usa o mais
    //    próximo até 35 m.
    const cset=new Set();
    let J=null, bd=Infinity;
    for(const [k,ll] of g.nodes){ if(skip(k)||(deg.get(k)||0)<3) continue;
      const d=metros(ll,M); if(d<=20) cset.add(k); if(d<bd){ bd=d; J=k; } }
    if(!cset.size){ if(!J || bd>35) continue; cset.add(J); }
    const C=[M[0], M[1]];                                    // centro do anel = círculo do DWG
    // braços = arestas que saem do conjunto de cruzamentos (ruas reais chegando na ilha)
    const arms=[];
    for(let i=0;i<g.edges.length;i++){
      const e=g.edges[i]; if(!e) continue;
      const [a,b,ow,st]=e, aC=cset.has(a), bC=cset.has(b); if(aC===bC) continue;
      const centerIsB=bC, out=centerIsB?a:b, oll=g.nodes.get(out);
      const ang=Math.atan2(oll[0]-C[0], (oll[1]-C[1])*cos0);  // ângulo do braço
      const into  = centerIsB ? ow>=0 : ow<=0;           // fluxo ENTRA na rotatória?
      const outof = centerIsB ? ow<=0 : ow>=0;           // fluxo SAI da rotatória?
      arms.push({out,ang,into,outof,st, jll:g.nodes.get(centerIsB?b:a).slice()});   // jll = cruzamento original da rua
    }
    if(arms.length<3){ continue; }                        // precisa ser junção real
    arms.sort((x,y)=>x.ang-y.ang);
    // 2) pontos do anel = braços + preenchimento (gaps ≤ 45°), ordenados por ângulo
    const pts=[];
    for(let j=0;j<arms.length;j++){
      pts.push({ang:arms[j].ang, arm:j});
      let gap=arms[(j+1)%arms.length].ang-arms[j].ang; if(gap<=0) gap+=2*Math.PI;
      const steps=Math.max(1,Math.round(gap/(Math.PI/4)));
      for(let s=1;s<steps;s++) pts.push({ang:arms[j].ang+gap*s/steps});
    }
    pts.sort((x,y)=>x.ang-y.ang);
    const base='RT'+Math.round(C[0]*1e5)+'_'+Math.round(C[1]*1e5)+'_';
    // o anel inteiro é um "nó composto": o Dijkstra cobra a manobra entrada→saída
    (g.clusterCenter ||= new Map()).set(base.slice(0,-1), C);
    (g.clusterRaio ||= new Map()).set(base.slice(0,-1), r);
    pts.forEach((p,idx)=>{
      p.id=base+idx;
      (g.cluster ||= new Map()).set(p.id, base.slice(0,-1));
      p.ll=[ C[0]+(r*Math.sin(p.ang))/110540, C[1]+(r*Math.cos(p.ang))/(111320*cos0) ];
      g.nodes.set(p.id,p.ll); if(!g.adj.has(p.id)) g.adj.set(p.id,[]);
    });
    // 3) anel MÃO ÚNICA ANTI-HORÁRIA (tráfego BR): pts[k] -> pts[k+1] (ângulo crescente).
    //    Bidirecional fazia 236 rotas contornarem a rot.2 no sentido horário (contramão).
    for(let k=0;k<pts.length;k++){
      const A=pts[k], B=pts[(k+1)%pts.length];
      const w=metros(A.ll,B.ll);
      g.adj.get(A.id).push({to:B.id,w,st:null});
      g.edges.push([A.id,B.id,1,null]);
    }
    // 4) conecta cada braço ao anel, respeitando mão única. A rua segue pelo traçado
    //    dela até o CRUZAMENTO ORIGINAL (nó 'RA…' próprio de cada braço) e só dali faz a
    //    ligação curta até o anel — ligar direto o próximo ponto da rua ao anel deixava a
    //    linha torta, cortando o quarteirão, quando esse ponto ficava longe (rua de 150 m).
    //    O ponto de ligação é o ponto DA RUA (trecho cruzamento→próximo ponto) mais perto do
    //    centro da ilha: fica sempre em cima do asfalto e não faz "gancho" quando o cruzamento
    //    original fica depois da rotatória (rua que passa do lado da ilha, ex. lotes 444–448).
    pts.forEach(p=>{ if(p.arm==null) return;
      const arm=arms[p.arm], A='RA'+p.id.slice(2);
      const lig=projetarNoSegmento(C, arm.jll, g.nodes.get(arm.out)).latlng;
      g.nodes.set(A, lig); g.adj.set(A, []);
      const w1=metros(g.nodes.get(arm.out),lig), w2=metros(lig,p.ll);
      const ow=(arm.into&&arm.outof)?0:(arm.into?1:-1);
      if(arm.into){  g.adj.get(arm.out).push({to:A,w:w1,st:arm.st}); g.adj.get(A).push({to:p.id,w:w2,st:arm.st}); }   // entra
      if(arm.outof){ g.adj.get(p.id).push({to:A,w:w2,st:arm.st});    g.adj.get(A).push({to:arm.out,w:w1,st:arm.st}); } // sai
      g.edges.push([arm.out, A, ow, arm.st]);
      g.edges.push([A, p.id, ow, arm.st]);
    });
    // 5) remove o miolo: isola nós centrais (sem cruzar reto) e some arestas antigas
    for(const k of cset) g.adj.set(k,[]);
    for(const [k,list] of g.adj){ if(cset.has(k)) continue; g.adj.set(k, list.filter(x=>!cset.has(x.to))); }
    for(let i=0;i<g.edges.length;i++){ const e=g.edges[i]; if(e && (cset.has(e[0])||cset.has(e[1]))) g.edges[i]=null; }
    g.edges=g.edges.filter(Boolean);
  }
}
// CRUZAMENTO PICADO: a malha às vezes tem 2–3 nós de cruzamento a poucos metros
// (ex.: saída da portaria, degrau de 8 m). Cada um contava como conversão de 90°,
// mesmo seguindo reto. Agrupa nós grau≥3 ligados por trecho <12 m num "nó composto"
// (mesmo tratamento da rotatória: cobra só a manobra entrada→saída).
function agruparCruzamentos(g, maxM=12){
  const esp=(k)=> isRT(k)||k[0]==='L'||k==='PORTARIA'||k.startsWith('p_')||k.startsWith('POI');
  const deg=new Map();
  for(const e of g.edges){ if(!e||esp(e[0])||esp(e[1])) continue; deg.set(e[0],(deg.get(e[0])||0)+1); deg.set(e[1],(deg.get(e[1])||0)+1); }
  const par=new Map(), find=(x)=>{ while(par.get(x)!==x){ par.set(x,par.get(par.get(x))); x=par.get(x); } return x; };
  for(const e of g.edges){
    if(!e) continue; const [a,b]=e;
    if(esp(a)||esp(b)||(deg.get(a)||0)<3||(deg.get(b)||0)<3) continue;
    if(metros(g.nodes.get(a),g.nodes.get(b))>=maxM) continue;
    if(!par.has(a)) par.set(a,a); if(!par.has(b)) par.set(b,b);
    par.set(find(a),find(b));
  }
  const grupos=new Map();
  for(const x of par.keys()){ const r=find(x); (grupos.get(r)||grupos.set(r,[]).get(r)).push(x); }
  let i=0;
  g.cluster ||= new Map(); g.clusterCenter ||= new Map();
  for(const nos of grupos.values()){
    const id='JC'+(i++); let s0=0,s1=0;
    for(const x of nos){ g.cluster.set(x,id); const ll=g.nodes.get(x); s0+=ll[0]; s1+=ll[1]; }
    g.clusterCenter.set(id,[s0/nos.length, s1/nos.length]);
  }
  return i;
}
// acessos de lote (p_*) inseridos DENTRO de um nó composto (ex.: lotes 567/568 na
// borda da rotatória 4) passam a fazer parte dele — senão a rota "sairia" do anel ali.
// Os acessos ficam encadeados (ponta—p—p—ponta), então olha o GRUPO de acessos ligados
// entre si: se todas as ruas em volta do grupo são do mesmo nó composto, o grupo inteiro entra.
function absorverAcessos(g){
  if(!g.cluster) return;
  const viz=new Map(), liga=(a,b)=>(viz.get(a)||viz.set(a,new Set()).get(a)).add(b);
  for(const [a,L] of g.adj) for(const e of L){ liga(a,e.to); liga(e.to,a); }
  const rua=(x)=> x[0]!=='L' && !x.startsWith('POI') && x!=='PORTARIA';
  const visto=new Set();
  for(const k of g.nodes.keys()){
    if(!k.startsWith('p_') || visto.has(k)) continue;
    const grupo=[], fora=new Set(), pilha=[k]; visto.add(k);
    while(pilha.length){ const u=pilha.pop(); grupo.push(u);
      for(const v of (viz.get(u)||[])){ if(!rua(v)) continue;
        if(v.startsWith('p_')){ if(!visto.has(v)){ visto.add(v); pilha.push(v); } } else fora.add(v); } }
    const cs=[...fora].map(x=>g.cluster.get(x));
    if(cs.length && cs.every(c=>c && c===cs[0])) for(const u of grupo) g.cluster.set(u, cs[0]);
  }
}
// insere um ponto (portaria/lote) no grafo, ligado ao ponto mais próximo da rua.
// Respeita mão única: em via ow=1 só se anda a→pid→b; ow=-1 só b→pid→a.
// prefDir (opcional, [dLat,dLng] normalizado): direção da FILEIRA do lote — em
// lote de esquina, prefere a rua da FRENTE (paralela à fileira) à lateral.
// escolhe o melhor ponto de acesso na rua (SEM inserir no grafo).
// stFilter: restringe a uma street específica (consenso de fileira).
function escolherAcesso(g, latlng, prefDir, stFilter){
  const cands=[];
  const stOk=(st)=> stFilter==null || (Array.isArray(stFilter)? stFilter.includes(st) : st===stFilter);
  for(const [a,b,ow,st] of g.edges){
    if(!stOk(st)) continue;
    const pr=projetarNoSegmento(latlng, g.nodes.get(a), g.nodes.get(b));
    cands.push({...pr,a,b,ow:ow||0,st});
  }
  if(!cands.length) return null;
  cands.sort((x,y)=>x.dist-y.dist);
  let best=cands[0];
  if(prefDir){
    const cos0=Math.cos(latlng[0]*rad);
    const segDir=(c)=>{
      const A=g.nodes.get(c.a), B=g.nodes.get(c.b);
      let dy=B[0]-A[0], dx=(B[1]-A[1])*cos0;
      const L=Math.hypot(dx,dy)||1; return [dy/L,dx/L];
    };
    const par=(c)=>{ const d=segDir(c); return Math.abs(d[0]*prefDir[0]+d[1]*prefDir[1]); };
    const near=cands.filter(c=>c.dist<best.dist+20);
    let bestSc=null;
    for(const c of near){
      const p=par(c);
      if(p<0.6) continue;
      const sc=c.dist-25*p;
      if(!bestSc || sc<bestSc.sc) bestSc={...c, sc};
    }
    if(bestSc) best=bestSc;
  }
  return best;
}
function grudarNaRua(g, latlng, id, prefDir, stFilter, nudgeM){
  g.nodes.set(id, latlng); g.adj.set(id, []);
  let best=escolherAcesso(g, latlng, prefDir, stFilter);
  if(!best && stFilter!=null) best=escolherAcesso(g, latlng, prefDir, null);
  if(!best) return id;                       // sem ruas → nó isolado
  if(nudgeM){
    // empurra o ponto de acesso N metros ao longo do sentido de circulação da via
    const A=g.nodes.get(best.a), B=g.nodes.get(best.b);
    const cos0=Math.cos(best.latlng[0]*rad);
    let dy=B[0]-A[0], dx=(B[1]-A[1])*cos0;
    const L=Math.hypot(dx,dy)||1; dy/=L; dx/=L;
    const s=(best.ow<0?-1:1)*nudgeM;         // ow=-1 circula b→a
    best.latlng=[ best.latlng[0]+ (dy*s)/111320,
                  best.latlng[1]+ (dx*s)/(111320*cos0) ];
    best.latlng=projetarNoSegmento(best.latlng, A, B).latlng;   // não sai do trecho
  }
  const pid='p_'+id;
  g.nodes.set(pid, best.latlng); g.adj.set(pid, []);
  const dir=(x,y,st)=>{ const w=metros(g.nodes.get(x),g.nodes.get(y)); g.adj.get(x).push({to:y,w,st}); };
  // DIVIDE o trecho a—b em a—p—b (tira a ligação direta), pra que vários acessos na mesma
  // quadra fiquem ENCADEADOS ao longo da rua. Antes cada lote ligava direto às duas pontas:
  // do lote 49 pro 51 (vizinhos) a rota ia até a esquina e voltava; e com a moto já na rua,
  // um destino mais à frente na mesma quadra também gerava "vai até a esquina e volta".
  const tira=(x,y,st)=>{ const L=g.adj.get(x); if(!L) return; const i=L.findIndex(e=>e.to===y && e.st===st); if(i>=0) L.splice(i,1); };
  if(best.ow>=0){ tira(best.a,best.b,best.st); dir(best.a,pid,best.st); dir(pid,best.b,best.st); }   // sentido a→b
  if(best.ow<=0){ tira(best.b,best.a,best.st); dir(best.b,pid,best.st); dir(pid,best.a,best.st); }   // sentido b→a
  const ei=g.edges.findIndex(e=>e && e[0]===best.a && e[1]===best.b && e[3]===best.st);
  if(ei>=0){ const [a,b,ow,st]=g.edges[ei]; g.edges.splice(ei,1,[a,pid,ow,st],[pid,b,ow,st]); }
  dir(pid,id,null); dir(id,pid,null);                                    // acesso ao destino
  return id;
}

/* ---------------- Dijkstra (com heap) ---------------- */
class MinHeap{
  constructor(){this.a=[];}
  push(x){const a=this.a;a.push(x);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(a[p][0]<=a[i][0])break;[a[p],a[i]]=[a[i],a[p]];i=p;}}
  pop(){const a=this.a;const top=a[0],last=a.pop();if(a.length){a[0]=last;let i=0;for(;;){let l=2*i+1,r=l+1,s=i;if(l<a.length&&a[l][0]<a[s][0])s=l;if(r<a.length&&a[r][0]<a[s][0])s=r;if(s===i)break;[a[s],a[i]]=[a[i],a[s]];i=s;}}return top;}
  get size(){return this.a.length;}
}
// Dijkstra com PENALIDADE DE CURVA: virar custa "metros extras" (ver penalidadeRumo),
// então entre caminhos de custo parecido a rota segue reta — sem zigue-zagues.
// conversões proibidas por STREET no nó (rotatória): {via: nó, from: street de
// entrada, to: street de saída}. Confirmado em campo: quem desce a via norte (31)
// NÃO corta direto pra curva (42) — os 427-431 são servidos subindo a interna (30)
// e virando à direita na curva.
const BANNED_ST_TURNS=[
  {via:"-5.173394,-37.393791", from:31, to:42},
];
// NÓ COMPOSTO (rotatória ou cruzamento picado) = uma manobra só: dentro dele não se
// cobra curva; na SAÍDA cobra-se a penalidade entre o nó de ENTRADA e o de SAÍDA,
// medida pelo centro (como um cruzamento comum): seguir reto = 0, virar = esquina,
// retorno = retorno. Por isso o estado carrega `ent` (nó por onde entrou).
const isRT=(k)=> typeof k==='string' && k.startsWith('RT');
// A PÉ: pedestre anda na calçada, então mão única não vale — usa também as arestas
// ao contrário (g.radj, montado no fim do init) e ignora as conversões proibidas.
function construirReverso(g){
  const r=new Map();
  for(const [a,L] of g.adj) for(const e of L) (r.get(e.to)||r.set(e.to,[]).get(e.to)).push({to:a, w:e.w, st:e.st});
  g.radj=r;
}
// penalidade entre dois RUMOS: o da rua por onde chegou (A→B) e o da rua por onde sai (C→D)
function penalidadeRumo(A,B,C,D){
  const cos0=Math.cos(B[0]*rad);
  const v1=[B[0]-A[0], (B[1]-A[1])*cos0], v2=[D[0]-C[0], (D[1]-C[1])*cos0];
  const cosang=(v1[0]*v2[0]+v1[1]*v2[1])/((Math.hypot(v1[0],v1[1])*Math.hypot(v2[0],v2[1]))||1);
  if(cosang>0.87) return 0;      // <30°: reto
  if(cosang>0.5)  return 10;     // 30–60°
  if(cosang>-0.5) return 30;     // 60–120° (esquina)
  if(cosang>-0.766) return 45;   // 120–140°: curva fechada (esquina aguda das diagonais)
  return 80;                     // >140°: retorno (o mesmo limite que a voz chama de "Faça o retorno")
}
function dijkstra(g, from, to, opt){
  const pe=!!(opt && opt.pe);
  const CL=g.cluster||new Map(), CC=g.clusterCenter||new Map();
  // o raio de ligação anel↔rua (RA…) conta como parte da rotatória
  const grupo=(n)=>{ const c=CL.get(n); if(c) return c;
    if(n.startsWith('RA')){ const r='RT'+n.slice(2, n.lastIndexOf('_')); if(CC.has(r)) return r; } };
  const dist=new Map(), prev=new Map();
  const k0=from+'||';
  dist.set(k0,0);
  // rumo = [nó, nó] do último trecho de rua com ≥1 m antes de u. A curva é medida
  // rumo-contra-rumo: trechos de ~0 m (acesso de lote em cima da quina, raio em cima
  // do acesso) não contam, e o nó composto inteiro (rotatória/cruzamento picado) vira
  // UMA manobra: rumo de chegada × rumo da rua de saída. Assim a rua que passa ao lado
  // da rotatória e segue reta não "vira", e o retorno pela rotatória continua retorno.
  const h=new MinHeap(); h.push([0,from,'','',null]);
  let endKey=null;
  while(h.size){
    const [d,u,pu,ent,rumo]=h.pop();
    const ku=u+'|'+pu+'|'+ent;
    if((dist.get(ku)??Infinity)<d) continue;
    if(u===to){ endKey=ku; break; }
    const stIn = (pu && !pe) ? ((g.adj.get(pu)||[]).find(x=>x.to===u)||{}).st : null;
    const cu=grupo(u), U=g.nodes.get(u);
    const viz = pe ? (g.adj.get(u)||[]).concat((g.radj && g.radj.get(u))||[]) : (g.adj.get(u)||[]);
    for(const e of viz){
      if(e.to===pu) continue;                        // sem meia-volta imediata
      if(!pe && BANNED_ST_TURNS.some(t=>t.via===u && stIn===t.from && e.st===t.to)) continue;
      const cv=grupo(e.to), V=g.nodes.get(e.to);
      let pen=0, nent='', nrumo=rumo;
      if(cu && cv===cu){ nent=ent; }                 // andando dentro do nó composto
      else if(cv && !cu){ nent=u; }                  // entrando: o rumo de chegada fica guardado
      else if(metros(U,V)>=1){                       // trecho de rua de verdade (ou saída do nó)
        if(rumo && e.to[0]!=='L'){
          pen=penalidadeRumo(g.nodes.get(rumo[0]), g.nodes.get(rumo[1]), U, V);
          // contornar a rotatória pra voltar/virar é manobra normal (e segura): no máximo uma esquina
          if(cu && cu.startsWith('RT')) pen=Math.min(pen,30);
        }
        // saindo de casa a poucos metros da esquina: o sentido inicial é livre
        nrumo = (u===from && metros(U,V)<15) ? null : [u,e.to];
        if(cv) nent=u;                               // saiu de um nó composto direto para outro
      } else if(cv) nent=u;                          // ~0 m: a curva é cobrada no próximo trecho
      const nd=d+e.w+pen;
      const kv=e.to+'|'+u+'|'+nent;
      if(nd < (dist.get(kv)??Infinity)){
        dist.set(kv,nd); prev.set(kv,ku); h.push([nd,e.to,u,nent,nrumo]);
      }
    }
  }
  if(!endKey) return null;
  const path=[]; let cur=endKey; let guard=0;
  while(cur && guard++<10000){ path.unshift(cur.split('|')[0]); cur=prev.get(cur); }
  // dist reportada = metros reais do caminho (sem as penalidades)
  let real=0;
  for(let i=0;i+1<path.length;i++){
    real+=metros(g.nodes.get(path[i]), g.nodes.get(path[i+1]));
  }
  return { path, dist:real };
}

/* ================================================================
   PROVEDORES DE DADOS
================================================================ */

// ---- MODO REAL: parse dos 3 GeoJSON (coords GeoJSON = [lng,lat]) ----
function getProp(props, names){ if(!props) return undefined; for(const n of names) if(props[n]!=null) return props[n]; return undefined; }
function centroide(ring){ let x=0,y=0,n=0; for(const c of ring){ x+=c[0]; y+=c[1]; n++; } return [x/n, y/n]; }

function parseReal(gRuas, gLotes, gPort){
  const lines=[];
  for(const f of (gRuas.features||[])){
    const gg=f.geometry; if(!gg) continue;
    const ow=Number((f.properties||{}).oneway)||0;   // 0=dupla, 1=fwd, -1=rev
    const st=(f.properties||{}).street ?? null;
    if(gg.type==='LineString') lines.push({path:gg.coordinates.map(c=>[c[1],c[0]]), ow, st});
    else if(gg.type==='MultiLineString') for(const part of gg.coordinates) lines.push({path:part.map(c=>[c[1],c[0]]), ow, st});
  }
  const lots=[];
  for(const f of (gLotes.features||[])){
    const gg=f.geometry, pr=f.properties||{};
    let ll=null;
    if(gg.type==='Point') ll=[gg.coordinates[1], gg.coordinates[0]];
    else if(gg.type==='Polygon'){ const c=centroide(gg.coordinates[0]); ll=[c[1],c[0]]; }
    else if(gg.type==='MultiPolygon'){ const c=centroide(gg.coordinates[0][0]); ll=[c[1],c[0]]; }
    if(!ll) continue;
    const id=Number(getProp(pr,['lote','LOTE','Lote','numero','NUMERO','num','id']));
    if(!Number.isFinite(id)) continue;
    const quadra=getProp(pr,['quadra','QUADRA','Quadra','qd','QD']) ?? '—';
    lots.push({ id, quadra, latlng:ll });
  }
  let portaria=null, nome='Portaria';
  const pf=(gPort.features||[])[0];
  if(pf && pf.geometry && pf.geometry.type==='Point'){
    portaria=[pf.geometry.coordinates[1], pf.geometry.coordinates[0]];
    nome=getProp(pf.properties,['nome','NOME','name']) || nome;
  }
  return { mode:'real', lines, lots, portaria, portariaNome:nome };
}

// ---- MODO EXEMPLO: gera malha sobre o terreno real (Nova Betânia, Mossoró/RN) ----
function gerarExemplo(){
  const ANCHOR={lat:-5.17870,lng:-37.38980}, THETA=-35*rad;      // no terreno real; ajuste fino vem do DWG
  const NC=6,NR=4,BW=90,BH=72,LOTS=12,DEPTH=26;
  const PW=NC*BW, PH=NR*BH;
  const toGeo=(x,y)=>{
    const dx=x-PW/2, dy=y-PH/2;
    const xr=dx*Math.cos(THETA)-dy*Math.sin(THETA), yr=dx*Math.sin(THETA)+dy*Math.cos(THETA);
    return [ ANCHOR.lat + yr/111320, ANCHOR.lng + xr/(111320*Math.cos(ANCHOR.lat*rad)) ];
  };
  const lines=[];
  for(let j=0;j<=NR;j++) for(let i=0;i<NC;i++) lines.push([toGeo(i*BW,j*BH), toGeo((i+1)*BW,j*BH)]);
  for(let i=0;i<=NC;i++) for(let j=0;j<NR;j++) lines.push([toGeo(i*BW,j*BH), toGeo(i*BW,(j+1)*BH)]);
  const lots=[]; let n=0;
  for(let j=0;j<NR;j++) for(let i=0;i<NC;i++){
    const quadra=j*NC+i+1, x0=i*BW, step=BW/LOTS;
    for(const f of [{y:j*BH+DEPTH/2},{y:(j+1)*BH-DEPTH/2}])
      for(let k=0;k<LOTS;k++){ n++; lots.push({id:n, quadra, latlng: toGeo(x0+step*(k+0.5), f.y)}); }
  }
  const portaria=toGeo(Math.floor(NC/2)*BW, 0);
  return { mode:'exemplo', lines, lots, portaria, portariaNome:'Portaria' };
}

/* ================================================================
   APP
================================================================ */
const $=(id)=>document.getElementById(id);
const map = L.map('map', { zoomControl:false, attributionControl:true, maxZoom:19 });
map.attributionControl.setPosition('topright');
// fundo: SATÉLITE (Esri) ou MAPA próprio. O app é só pra dentro do condomínio: o "mapa" não
// usa fundo de terceiros (o OpenStreetMap tinha as ruas daqui deslocadas → rua sobre rua);
// é um fundo liso com as nossas ruas, as pistas da portaria e a Av. Gov. Tarcísio Maia.
const COR_FUNDO_MAPA='#f2efe9';
const FUNDOS={
  satelite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom:19, maxNativeZoom:18, attribution:'Imagery © Esri' }),
  mapa: L.layerGroup(),
};
let FUNDO='satelite';
try{ const f=localStorage.getItem('copa.fundo'); if(FUNDOS[f]) FUNDO=f; }catch(e){}
FUNDOS[FUNDO].addTo(map);
const RUAS_LY=[], ROT_LY=[];      // traços das ruas e círculos das rotatórias (mudam de estilo com o fundo)
// no satélite a foto já mostra a rua → traço fino; no mapa as ruas internas podem não
// existir no mapa base → desenha as nossas como rua de verdade (cinza com borda)
// No mapa a rua tem a LARGURA REAL (metros → pixels do zoom atual, como no Google Maps):
// internas 8 m, pistas da portaria 9 m, avenida 14 m; de longe, um mínimo pra continuar visível.
// (a avenida só aparece no mapa — no satélite a foto já mostra)
const LARGURA={ interna:[8,5], acesso:[9,6], avenida:[14,8] };   // [metros, px mínimo]
const pxDe=(m)=> m / (40075016.686*Math.cos(-5.177*Math.PI/180) / Math.pow(2, map.getZoom()+8));
const larguraRua=(tipo)=>{ const [m,min]=LARGURA[tipo]||LARGURA.interna; return Math.max(min, pxDe(m)); };
const estiloRua=(tipo)=> FUNDO==='mapa' ? {color:'#ffffff',weight:larguraRua(tipo),opacity:1}
                       : (tipo==='avenida' ? {opacity:0} : {color:'#ffffff',weight:2,opacity:.35});
const estiloBorda=(tipo)=> FUNDO==='mapa' ? {color:'#c3ccd6',weight:larguraRua(tipo)+3,opacity:1} : {opacity:0};
const PISO_LY=[];
const estiloPiso=(tipo)=> FUNDO!=='mapa' ? {stroke:false, fill:false}
  : {stroke:false, fill:true, fillOpacity:1, fillColor: tipo==='pisoBorda' ? '#c3ccd6' : '#ffffff'};
const estiloRot=()=> FUNDO==='mapa' ? {color:'#94a3b8',weight:2,opacity:1,fillColor:'#cbd5e1',fillOpacity:.6} : {color:'#ffffff',weight:2,opacity:.8,fillColor:'#ffffff',fillOpacity:.15};
function setFundo(f){
  if(!FUNDOS[f]) return;
  if(f!==FUNDO){ map.removeLayer(FUNDOS[FUNDO]); FUNDO=f; FUNDOS[f].addTo(map); if(FUNDOS[f].bringToBack) FUNDOS[f].bringToBack(); }
  map.getContainer().style.background = f==='mapa' ? COR_FUNDO_MAPA : '';
  try{ localStorage.setItem('copa.fundo', f); }catch(e){}
  for(const r of RUAS_LY){ r.borda.setStyle(estiloBorda(r.tipo)); r.linha.setStyle(estiloRua(r.tipo)); }
  for(const p of PISO_LY) p.setStyle(estiloPiso(p.options.tipo));
  for(const c of ROT_LY) c.setStyle(estiloRot());
  if(ROTULOS.length) aplicarFundoExtras();
  const b=$('fundo'); if(b){ const outro=f==='satelite'?'mapa':'satelite';
    b.innerHTML=(outro==='mapa'?ICON_MAPA:ICON_SAT)+`<span>${outro==='mapa'?'Mapa':'Satélite'}</span>`;
    b.setAttribute('aria-label', outro==='mapa'?'Mostrar mapa de ruas':'Mostrar satélite'); }
}
const ICON_MAPA='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>';
const ICON_SAT='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/></svg>';
map.setView([-5.1787,-37.3898], 16);
// camadas, de baixo pra cima: fundo · máscara (só no mapa) · nossas ruas · nomes · rota/marcadores
for(const [nome,z] of [['ruas',350],['rotulos',380]]){ const p=map.createPane(nome); p.style.zIndex=z; p.style.pointerEvents='none'; }
const canvas = L.canvas({ padding:0.5 });
const canvasRuas = L.canvas({ padding:0.5, pane:'ruas' });
const svgRotulos = L.svg({ padding:0.5, pane:'rotulos' });

let G, LOTS_BY_ID, PORT_NODE, ALL_BOUNDS, LMIN=1, LMAX=596;
let routeLine=null, routeBg=null, routeDone=null, destMarker=null;

async function carregarDados(){
  try{
    const [r,l,p] = await Promise.all(Object.values(CONFIG.dados).map(u=>fetch(u,{cache:'no-store'})));
    if(r.ok && l.ok && p.ok){
      const d = parseReal(await r.json(), await l.json(), await p.json());
      if(d.lots.length && d.portaria) return d;
    }
  }catch(e){ /* sem dados reais → exemplo */ }
  return gerarExemplo();
}

function desenharBase(data){
  // ruas: no satélite, traço branco discreto; no mapa, rua desenhada (ver estiloRua).
  // Primeiro TODAS as bordas, depois todas as ruas — senão a borda de uma rua passa por
  // cima da outra nos cruzamentos.
  // + `data.extras`: só desenho, fora das rotas (pistas da portaria e a avenida — dados/acessos.geojson)
  const todas=data.lines.concat(data.extras||[]);
  const bordas=todas.map(line=>L.polyline(line.path||line, Object.assign({renderer:canvasRuas, pane:'ruas', interactive:false, lineCap:'round'}, estiloBorda(line.tipo))).addTo(map));
  // PISO (só no mapa), entre as bordas e as ruas: a faixa de circulação em volta de cada
  // rotatória (o contorno aparece como rua — dá pra ver o retorno) e as áreas pavimentadas
  // (entrada: tudo pavimentado entre as pistas, sem canteiro)
  const opt={renderer:canvasRuas, pane:'ruas', interactive:false};
  for(const rt of (window.ROTATORIAS||[]).filter(r=>r.circula)){
    // faixa de 2 m em volta da ilha (= onde a rota contorna; mais larga invadia os lotes)
    PISO_LY.push(L.circle([rt.lat,rt.lng], Object.assign({radius:rt.raio+2.4, tipo:'pisoBorda'}, opt, estiloPiso('pisoBorda'))).addTo(map));
    PISO_LY.push(L.circle([rt.lat,rt.lng], Object.assign({radius:rt.raio+2, tipo:'piso'}, opt, estiloPiso('piso'))).addTo(map));
  }
  for(const p of (data.pisos||[])) PISO_LY.push(L.polygon(p, Object.assign({tipo:'piso'}, opt, estiloPiso('piso'))).addTo(map));
  todas.forEach((line,i)=>{
    const linha=L.polyline(line.path||line, Object.assign({renderer:canvasRuas, pane:'ruas', interactive:false, lineCap:'round'}, estiloRua(line.tipo))).addTo(map);
    RUAS_LY.push({borda:bordas[i], linha, tipo:line.tipo});
  });
  // largura real: refaz a espessura a cada zoom (só no mapa; no satélite é traço fino fixo)
  map.on('zoomend', ()=>{ if(FUNDO==='mapa') for(const r of RUAS_LY){ r.borda.setStyle(estiloBorda(r.tipo)); r.linha.setStyle(estiloRua(r.tipo)); } });
  criarRotulos(data);
  aplicarFundoExtras();
  // lotes: não são desenhados (poluíam o mapa); só definem o enquadramento
  const bounds=L.latLngBounds([]);
  for(const lot of data.lots) bounds.extend(lot.latlng);
  bounds.extend(data.portaria);
  L.marker(data.portaria,{icon:L.divIcon({className:'',html:'<div class="gate"></div>',iconSize:[16,16],iconAnchor:[8,8]})})
    .addTo(map).bindTooltip(esc(data.portariaNome),{direction:'top'});
  return bounds.pad(0.15);
}
// MAPA: nomes das ruas escritos ao longo das nossas ruas (os mesmos da voz)
const ROTULOS=[];
function criarRotulos(data){
  // junta os trechos de mesmo nome que se encostam numa linha só (um rótulo por rua)
  const chave=(P)=>P[0].toFixed(6)+','+P[1].toFixed(6), porNome=new Map();
  for(const line of data.lines.concat(data.extras||[])){ const nome=line.rotulo || (line.st!=null && NOME_ST[line.st]); if(!nome) continue;
    (porNome.get(nome)||porNome.set(nome,[]).get(nome)).push((line.path||line).slice()); }
  const SVGNS='http://www.w3.org/2000/svg'; let n=0;
  for(const [nome,trechos] of porNome){
    while(trechos.length){
      let cad=trechos.pop(), achou=true;
      while(achou){ achou=false;
        for(let k=0;k<trechos.length;k++){ const t=trechos[k];
          if(chave(t[0])===chave(cad[cad.length-1])) cad=cad.concat(t.slice(1));
          else if(chave(t[t.length-1])===chave(cad[cad.length-1])) cad=cad.concat(t.slice(0,-1).reverse());
          else if(chave(t[t.length-1])===chave(cad[0])) cad=t.slice(0,-1).concat(cad);
          else if(chave(t[0])===chave(cad[0])) cad=t.slice(1).reverse().concat(cad);
          else continue;
          trechos.splice(k,1); achou=true; break; } }
      let comp=0; for(let k=1;k<cad.length;k++) comp+=metros(cad[k-1],cad[k]);
      if(comp<50) continue;
      if(xy(cad[cad.length-1],cad[0])[0]<0) cad.reverse();   // texto sempre "de pé" (da esquerda pra direita)
      const ly=L.polyline(cad,{renderer:svgRotulos, pane:'rotulos', stroke:false, fill:false, interactive:false}).addTo(map);
      const id='rua-rotulo-'+(n++); ly._path.setAttribute('id', id);
      const txt=document.createElementNS(SVGNS,'text'), tp=document.createElementNS(SVGNS,'textPath');
      for(const [a,v] of [['font-size','11'],['font-weight','600'],['font-family','system-ui,-apple-system,Segoe UI,Roboto,sans-serif'],
        ['fill','#475569'],['stroke','#ffffff'],['stroke-width','3'],['paint-order','stroke'],['dy','0.35em']]) txt.setAttribute(a,v);
      tp.setAttribute('href','#'+id); tp.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href','#'+id);
      tp.setAttribute('startOffset','50%'); tp.setAttribute('text-anchor','middle');
      tp.textContent=nome; txt.appendChild(tp); ly._path.parentNode.appendChild(txt);
      ROTULOS.push({ly, txt});
    }
  }
  // 'moveend' vem depois de o SVG redesenhar os trechos na escala nova ('zoomend' vem antes:
  // mediria o comprimento do zoom anterior e esconderia nomes que cabem)
  map.on('moveend', ajustarRotulos);
}
// nome só onde cabe inteiro no trecho (e some de longe, quando vira borrão)
function ajustarRotulos(){
  if(FUNDO!=='mapa') return;
  const longe=map.getZoom()<16;
  for(const r of ROTULOS){ let ok=!longe;
    if(ok){ try{ ok = r.ly._path.getTotalLength() > r.txt.getComputedTextLength()+24; }catch(e){ ok=false; } }
    r.txt.setAttribute('visibility', ok?'visible':'hidden'); }
}
function aplicarFundoExtras(){
  const mapa=FUNDO==='mapa';
  map.getPane('rotulos').style.display = mapa ? '' : 'none';
  if(mapa) ajustarRotulos();
}

/* ---------------- interface ---------------- */
// enquadra deixando espaço pro painel de baixo e pra pílula de cima
const padOpts=()=>({ paddingTopLeft:[24,86], paddingBottomRight:[24,$('sheet').offsetHeight+16] });
function fitAll(){ map.invalidateSize(); if(ALL_BOUNDS && ALL_BOUNDS.isValid()) map.fitBounds(ALL_BOUNDS, padOpts()); }
// botões flutuantes acima do painel: "centralizar" e, acima dele, "Satélite/Mapa"
function posFab(){
  const base=$('sheet').offsetHeight+14;
  $('recenter').style.bottom=base+'px';
  $('fundo').style.bottom=(base+($('recenter').hidden?0:60))+'px';
}
function estado(s){
  for(const id of ['stChoose','stNav','stArr']) $(id).hidden=(id!==s);
  $('man').hidden=(s!=='stNav'); $('brand').hidden=(s==='stNav');
  requestAnimationFrame(posFab);
}
function toast(t,ms=2200){ const el=$('toast'); el.textContent=t; el.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>el.classList.remove('show'),ms); }
const fmtDist=(m)=> m>=1000 ? (m/1000).toFixed(1).replace('.',',')+' km'
                   : (m>=200 ? Math.round(m/10)*10 : Math.max(0,Math.round(m/5)*5))+' m';

/* ---------------- geometria da navegação ---------------- */
// x = leste, y = norte, em metros, relativo a `ref`
const xy=(ll,ref)=>[ (ll[1]-ref[1])*Math.cos(ref[0]*rad)*R*rad, (ll[0]-ref[0])*R*rad ];
// ângulo da virada em B indo A→B→C, em graus: + esquerda, − direita
function anguloVirada(A,B,C){
  const a=xy(A,B), v2=xy(C,B), v1=[-a[0],-a[1]];
  return Math.atan2(v1[0]*v2[1]-v1[1]*v2[0], v1[0]*v2[0]+v1[1]*v2[1])/rad;
}
const classificar=(a)=>{ const x=Math.abs(a); if(x<35) return 'reto'; if(x<60) return a>0?'leve-esq':'leve-dir'; if(x<140) return a>0?'esq':'dir'; return 'retorno'; };

// nomes das ruas (dados/nomes_ruas.json: trecho "street" → nome; OpenStreetMap + correções)
let NOME_ST={};
// trecho (street) da aresta a→b — inclusive andando ao contrário (modo a pé)
function stDe(a,b){
  const e=(G.adj.get(a)||[]).find(x=>x.to===b) || ((G.radj && G.radj.get(a))||[]).find(x=>x.to===b);
  return e ? e.st : null;
}
// nome da rua por onde o caminho segue a partir do índice k (pula acessos/anel sem trecho)
function ruaApos(ids, k){
  for(let t=k; t+1<ids.length && t<k+12; t++){
    const st=stDe(ids[t], ids[t+1]);
    if(st!=null) return NOME_ST[st] || null;
  }
  return null;
}
// manobras ao longo do caminho: nó composto (rotatória/cruzamento picado) = uma manobra
function manobras(ids, pts, cum){
  const CL=G.cluster||new Map(), CC=G.clusterCenter||new Map(), out=[];
  // vizinhos a mais de 1 m: acesso de lote caído em cima da quina (0 m) não pode "apagar" a curva
  const antes=(k)=>{ let t=k-1; while(t>0 && metros(pts[t],pts[k])<1) t--; return pts[t]; };
  const depois=(k)=>{ let t=k+1; while(t<pts.length-1 && metros(pts[t],pts[k])<1) t++; return pts[t]; };
  // ligação anel↔rua (RA…): o "raio" da rotatória até a rua faz parte da manobra da rotatória
  // (senão a quina raio→rua, ~90° quando a rua passa de lado, vira um "vire" falso na saída)
  const ligaAnel=(k,c)=> k>0 && k<ids.length && ids[k].startsWith('RA') && c && c.startsWith('RT') && ids[k].startsWith('RA'+c.slice(2)+'_');
  let i=1;
  while(i<ids.length-1){
    const c=CL.get(ids[i]);
    if(!c && ligaAnel(i, CL.get(ids[i+1]))){ i++; continue; }   // entrada: conta junto com o anel
    if(c){
      let j=i; while(j<ids.length && CL.get(ids[j])===c) j++;
      if(j<ids.length){
        // da rua de entrada (antes do raio) até a rua de saída (depois do raio e de nós colados)
        const i0 = ligaAnel(i-1,c) ? i-1 : i;
        let j1=j; if(ligaAnel(j1,c)) j1++;
        while(j1<ids.length-1 && metros(pts[j1],pts[j1-1])<1) j1++;
        const ctr=CC.get(c), ang=anguloVirada(antes(i0),ctr,depois(j1-1)), rot=isRT(ids[i]), tipo=classificar(ang);
        // rotatória: conta as saídas até a que a rota pega. Saída = nó do anel com TRECHO DE RUA
        // saindo (mesmo que o 1º ponto seja o acesso de um lote); medida pela direção do BRAÇO
        // (onde a rua encosta), não do nó do anel: duas ligações no mesmo braço contam uma vez
        // e o braço por onde entrou não conta.
        let saida=0;
        if(rot){
          const dif=(x,y)=>Math.abs(Math.atan2(Math.sin(x-y),Math.cos(x-y)));
          const aE=angDe(ctr,pts[i-1]), vistas=[];
          for(let k=i+1;k<j;k++){
            if(!isRT(ids[k])) continue;
            const fora=(G.adj.get(ids[k])||[]).filter(e=>!isRT(e.to) && e.st!=null && CL.get(e.to)!==c);
            if(!fora.length) continue;
            const a=angDe(ctr,G.nodes.get(fora[0].to));
            if(k<j-1 && dif(a,aE)<0.35) continue;
            if(vistas.some(v=>dif(v,a)<0.26)) continue;
            vistas.push(a); saida++;
          }
        }
        // entra e sai pelo MESMO braço (o raio de entrada e o de saída no mesmo ponto):
        // é retorno pela rotatória — "Na rotatória, faça o retorno", não "pegue a 1ª saída"
        let angM=ang;
        if(rot && metros(pts[i-1],pts[j])<2){ saida=0; angM=180; }
        else if(rot && saida<1) saida=1;   // entrou e saiu pelo mesmo nó do anel: foi a 1ª saída
        if(rot || tipo!=='reto') out.push({s:(cum[i]+cum[j-1])/2, ang:angM, rot, tipo, saida, rua:ruaApos(ids, j-1)});
        i=j1; continue;
      }
      i=j; continue;
    }
    // nós colados (<1 m): só o último do grupo conta a curva (senão ela sai dobrada)
    if(metros(pts[i],pts[i+1])<1){ i++; continue; }
    const ang=anguloVirada(antes(i),pts[i],depois(i)), tipo=classificar(ang);
    if(tipo!=='reto') out.push({s:cum[i], ang, rot:false, tipo, rua:ruaApos(ids, i)});
    i++;
  }
  // junta viradas encostadas (<10 m) numa só — evita "vire, vire" em degrau de malha.
  // Descarta os primeiros/últimos 12 m: é só o encaixe da portaria/bolinha na rua e
  // a entrada no lote (a chegada já diz "lote à direita/esquerda").
  const res=[], fim=cum[cum.length-1];
  for(const m of out.filter(m=>m.s>12 && m.s<fim-12)){ const p=res[res.length-1];
    if(p && !p.rot && !m.rot && m.s-p.s<10){ p.ang+=m.ang; p.tipo=classificar(p.ang); p.rua=m.rua; if(p.tipo==='reto') res.pop(); }
    else res.push({...m});
  }
  return res;
}
const TXT={'esq':'Vire à esquerda','dir':'Vire à direita','leve-esq':'Mantenha à esquerda','leve-dir':'Mantenha à direita','retorno':'Faça o retorno'};
const ORDINAL=['','primeira','segunda','terceira','quarta','quinta','sexta'];
function textoManobra(m){
  // com o nome da rua quando existe: "Vire à direita na Rua Bossa Nova"
  const na = m.rua ? ` na ${m.rua}` : '', para = m.rua ? ` para a ${m.rua}` : '';
  if(!m.rot) return TXT[m.tipo] + (m.tipo==='retorno' ? '' : na);
  // como o Google Maps: "Na rotatória, pegue a 2ª saída para a Avenida Atlântica"
  if(m.saida>=1 && m.saida<ORDINAL.length) return `Na rotatória, pegue a ${ORDINAL[m.saida]} saída${para}`;
  const x=Math.abs(m.ang);
  return 'Na rotatória, ' + (x<35?'siga em frente' : x<140 ? (m.ang>0?'saia à esquerda':'saia à direita') : 'faça o retorno') + para;
}
const seta=(d,flip)=>`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"${flip?' style="transform:scaleX(-1)"':''}>${d}</svg>`;
const SETA={
  reto:'<path d="M12 20V5M6 11l6-6 6 6"/>',
  vira:'<path d="M7 20v-7a4 4 0 0 1 4-4h8M15 5l4 4-4 4"/>',
  leve:'<path d="M8 20v-6l8-8M10 6h6v6"/>',
  retorno:'<path d="M16 20V9a4 4 0 0 0-8 0v4M4 10l4 4 4-4"/>',
  rot:'<circle cx="12" cy="9" r="4"/><path d="M12 13v8M15 6l3-3M18 3v4M18 3h-4"/>',
  chegada:'<path d="M6 21V4h11l-1.5 3.5L17 11H8"/>',
};
function iconeManobra(m){
  if(m.rot) return seta(SETA.rot, m.ang>0);
  if(m.tipo==='esq'||m.tipo==='dir') return seta(SETA.vira, m.tipo==='esq');
  if(m.tipo==='leve-esq'||m.tipo==='leve-dir') return seta(SETA.leve, m.tipo==='leve-esq');
  if(m.tipo==='retorno') return seta(SETA.retorno, m.ang<0);
  return seta(SETA.reto);
}
function setManobra(icon, dist, txt){ $('manIcon').innerHTML=icon; $('manDist').textContent=dist; $('manTxt').textContent=txt; }

/* ---------------- rota + navegação em tempo real ---------------- */
const NAV={ dest:null, ids:null, pts:null, cum:null, mans:[], total:0, lastS:0, origemGPS:false, lado:null };
// vis/visHd = posição e rumo MOSTRADOS: durante a rota a bolinha fica grudada na linha
const GPS={ ll:null, acc:999, heading:null, vis:null, visHd:null, marker:null, accCircle:null, watch:null, offCount:0, lastRecalc:0, follow:true, arrived:false };
const dentroDoLoteamento=(ll)=> !!(ALL_BOUNDS && ll && ALL_BOUNDS.contains(L.latLng(ll[0],ll[1])));

// como a pessoa vai: muda a velocidade estimada e — a pé — libera a contramão (calçada)
// e deixa a detecção de "saiu da rota" mais tolerante (GPS a pé oscila mais).
const MODOS={
  carro:{ kmh:15,  rotulo:'de carro', pe:false, lim:25, leituras:2, intervalo:5000 },
  moto: { kmh:18,  rotulo:'de moto',  pe:false, lim:25, leituras:2, intervalo:5000 },
  pe:   { kmh:4.5, rotulo:'a pé',     pe:true,  lim:35, leituras:3, intervalo:8000 },
};
let MODO='moto';
try{ const m=localStorage.getItem('copa.modo'); if(MODOS[m]) MODO=m; }catch(e){}
const modo=()=>MODOS[MODO];
const minutos=(m)=>Math.max(1, Math.round(m/(modo().kmh*1000/60)));
function setModo(m){
  MODO=m; try{ localStorage.setItem('copa.modo',m); }catch(e){}
  document.querySelectorAll('#modos .modo').forEach(b=>{ const on=b.dataset.modo===m; b.classList.toggle('on',on); b.setAttribute('aria-checked',on); });
}

// rota saindo de um ponto qualquer (a bolinha do GPS): cria um nó temporário na rua
// mais próxima, respeitando a mão única e — em mão dupla — o rumo da moto (não manda
// fazer meia-volta no meio da rua). O nó é removido depois do cálculo.
function rotaDoPonto(ll, heading, destino){
  const best=escolherAcesso(G, ll, null, null);
  if(!best || best.dist>60) return null;
  const id='p_GPS', A=G.nodes.get(best.a), B=G.nodes.get(best.b);
  G.nodes.set(id, best.latlng); G.adj.set(id, []);
  const add=(to)=>G.adj.get(id).push({to, w:metros(best.latlng,G.nodes.get(to)), st:best.st});
  const pe=modo().pe;
  let paraB=pe || best.ow>=0, paraA=pe || best.ow<=0;   // a pé: qualquer sentido
  if(!pe && paraA && paraB && heading!=null){
    const ab=xy(B,A), hv=[Math.sin(heading*rad), Math.cos(heading*rad)];
    if(ab[0]*hv[0]+ab[1]*hv[1]>=0) paraA=false; else paraB=false;
  }
  if(paraB) add(best.b);
  if(paraA) add(best.a);
  let r=null;
  try{ r=dijkstra(G, id, destino, {pe}); if(r) r.coords=r.path.map(n=>G.nodes.get(n)); }
  finally{ G.nodes.delete(id); G.adj.delete(id); }
  return r;
}

// a pessoa está DENTRO de um lote (em casa) e não na rua? → devolve esse lote
function loteDeOnde(ll){
  const rua=escolherAcesso(G, ll, null, null);
  if(rua && rua.dist<7) return null;                 // já está na rua
  let best=null, bd=20;
  for(const lot of LOTS_BY_ID.values()){ const d=metros(ll, lot.latlng); if(d<bd){ bd=d; best=lot; } }
  return (best && G.nodes.has('p_L'+best.id)) ? best : null;
}
function calcularRota(recalculo){
  let r=null, deGPS=false;
  const pe=modo().pe;
  if(GPS.ll && dentroDoLoteamento(GPS.ll) && GPS.acc<=65){
    // em casa: a rota começa LÁ FORA, na rua em frente ao lote (mesmo ponto de chegada dele).
    // No RECÁLCULO a pessoa já está andando: uma leitura com erro de 7–9 m fora do eixo,
    // perto de um lote, NÃO é "em casa" (a rota sairia da frente do vizinho, às vezes atrás).
    const casa=recalculo ? null : loteDeOnde(GPS.ll);
    if(casa){ r=dijkstra(G, 'p_L'+casa.id, NAV.dest.frente, {pe}); if(r){ r.coords=r.path.map(n=>G.nodes.get(n)); deGPS=true; } }
    if(!r){ r=rotaDoPonto(GPS.ll, GPS.heading, NAV.dest.frente); deGPS=!!r; }
  }
  if(!r){ r=dijkstra(G, PORT_NODE, NAV.dest.frente, {pe}); if(r) r.coords=r.path.map(n=>G.nodes.get(n)); }
  if(!r) return null;
  // a linha começa NA RUA — não liga mais a posição do GPS (dentro de casa) à rota
  const ids=r.path, pts0=r.coords;
  const cum0=[0]; for(let i=1;i<pts0.length;i++) cum0.push(cum0[i-1]+metros(pts0[i-1],pts0[i]));
  const mans=manobras(ids, pts0, cum0);            // manobras: calculadas no caminho do roteador
  // desenho/bolinha/distâncias: rotatória vira curva suave (ver suavizarRotatorias)
  const sv=suavizarRotatorias(ids, pts0), pts=sv.pts;
  const cum=[0]; for(let i=1;i<pts.length;i++) cum.push(cum[i-1]+metros(pts[i-1],pts[i]));
  const kn=[]; for(let i=0;i<ids.length;i++) if(sv.mapa[i]!=null) kn.push([cum0[i], cum[sv.mapa[i]]]);
  const mapS=(s)=>{ for(let k=0;k+1<kn.length;k++) if(s<=kn[k+1][0]){ const [a0,b0]=kn[k],[a1,b1]=kn[k+1]; return b0+(b1-b0)*((s-a0)/((a1-a0)||1)); } return kn.length?kn[kn.length-1][1]:s; };
  mans.forEach(m=>{ m.s=mapS(m.s); });
  Object.assign(NAV,{ ids, pts, cum, total:cum[cum.length-1], lastS:0, origemGPS:deGPS, ditoFinal:false, mans });
  NAV.lado=ladoDestino();
  desenharRota();
  return r;
}
// DESENHO da passagem pela rotatória: o roteador usa um anel de 8+ nós (decide sentido e
// manobra), mas desenhar esses nós dá um "octógono" torto com quinas de 90° nas ligações.
// Aqui o trecho do anel (do nó antes de entrar ao nó depois de sair) vira uma Bézier
// cúbica que contorna a ilha pelo lado anti-horário. Reto ≈ leve desvio; virar ≈ curva.
const angDe=(C,P)=>{ const v=xy(P,C); return Math.atan2(v[1],v[0]); };          // 0 = leste, anti-horário +
const polar=(C,r,a)=>[ C[0]+r*Math.sin(a)/(R*rad), C[1]+r*Math.cos(a)/(R*rad*Math.cos(C[0]*rad)) ];
const offset=(P,m,a)=>[ P[0]+m*Math.sin(a)/(R*rad), P[1]+m*Math.cos(a)/(R*rad*Math.cos(P[0]*rad)) ];   // anda m metros na direção a
const bez=(a,b,c,d,t)=>{ const u=1-t; return [0,1].map(k=>u*u*u*a[k]+3*u*u*t*b[k]+3*u*t*t*c[k]+t*t*t*d[k]); };
function suavizarRotatorias(ids, pts){
  const CL=G.cluster||new Map(), CC=G.clusterCenter||new Map(), CR=G.clusterRaio||new Map();
  const out=[], mapa=[];                               // mapa[i] = índice em `out` do ponto original i
  let i=0, ini=0;                                      // ini: não recua para antes da rotatória anterior
  while(i<ids.length){
    const c=CL.get(ids[i]);
    if(c && isRT(c) && i>0){
      let j=i; while(j<ids.length && CL.get(ids[j])===c) j++;
      if(j<ids.length){                                // há saída: da rua de entrada à rua de saída
        const C=CC.get(c), ilha=CR.get(c)||4, Rc=ilha+2;     // raio da ilha / da faixa de circulação (colada na ilha)
        // pontas do desenho: NA RUA, já fora da faixa (o raio de ligação até o anel pode
        // cair a 4 m do centro quando a rua passa de lado — começar ali dava um gancho)
        let ib=i-1; while(ib>ini && metros(C,pts[ib])<Rc+2) ib--;
        let jf=j;   while(jf<ids.length-1 && metros(C,pts[jf])<Rc+2) jf++;
        out.length=mapa[ib]+1; for(let k=ib+1;k<i;k++) mapa[k]=undefined;
        const P0=pts[ib], P3=pts[jf];
        // rumo das ruas de entrada e de saída (trechos de pelo menos ~3 m)
        let ia=ib; while(ia>0 && metros(pts[ia],P0)<3) ia--;
        let jb=jf; while(jb<ids.length-1 && metros(pts[jb],P3)<3) jb++;
        const vin=xy(P0,pts[ia]), vout=xy(pts[jb],P3), nin=Math.hypot(...vin)||1, nout=Math.hypot(...vout)||1;
        const dIn=[vin[0]/nin, vin[1]/nin], dOut=[vout[0]/nout, vout[1]/nout];
        // a rua só PASSA ao lado da ilha (quase reta, ilha à esquerda = sentido anti-horário)?
        // → segue a rua, abrindo um pouco em volta da ilha. Senão, contorna pelo anel.
        const corda=xy(P3,P0), lc=Math.hypot(...corda)||1, cC=xy(C,P0);
        const ladoEsq=(corda[0]*cC[1]-corda[1]*cC[0])>0;
        const reto=(dIn[0]*dOut[0]+dIn[1]*dOut[1])>0.8;
        if(reto && ladoEsq && lc>1){
          const L=lc*0.35, m=R*rad;
          const ll=(P,v,s)=>[P[0]+v[1]*s/m, P[1]+v[0]*s/(m*Math.cos(P[0]*rad))];
          const B1=ll(P0,dIn,L), B2=ll(P3,dOut,-L);
          for(let k=1;k<16;k++){
            let q=bez(P0,B1,B2,P3,k/16); const dq=metros(C,q), folga=ilha+1.3;
            if(dq<folga) q=polar(C,folga,angDe(C,q));      // não passa por cima da ilha
            out.push(q);
          }
          i=ini=jf; continue;
        }
        // como o Google Maps: entra na FAIXA da rotatória pela direita (curva tangente),
        // contorna colado na ilha no sentido anti-horário e sai pela direita na rua de saída
        const a0=angDe(C,P0), a1=angDe(C,P3);
        let d=a1-a0; while(d<=0.05) d+=2*Math.PI;            // do braço de entrada ao de saída, anti-horário
        const dl=Math.min(0.3, d/4);                         // entra/sai ~17° à direita do eixo da rua
        const ae=a0+dl, ax=a0+d-dl;
        const E=polar(C,Rc,ae), X=polar(C,Rc,ax);
        // entrada: da rua até a faixa (tangente ao círculo)
        const k0=Math.max(Rc+1, Math.min(metros(C,P0), Rc+6));
        const e1=polar(C,k0,a0), e2=offset(E,2,ae-Math.PI/2);
        for(let k=1;k<=8;k++) out.push(bez(P0,e1,e2,E,k/8));
        // contorno: arco anti-horário pela faixa
        const passos=Math.max(2, Math.ceil((ax-ae)/(Math.PI/18)));
        for(let k=1;k<passos;k++) out.push(polar(C,Rc,ae+(ax-ae)*k/passos));
        // saída: da faixa até a rua de saída
        const k3=Math.max(Rc+1, Math.min(metros(C,P3), Rc+6));
        const x1=offset(X,2,ax+Math.PI/2), x2=polar(C,k3,a1);
        for(let k=0;k<8;k++) out.push(bez(X,x1,x2,P3,k/8));
        i=ini=jf; continue;
      }
    }
    mapa[i]=out.length; out.push(pts[i]); i++;
  }
  // fim: se o caminho passa do ponto de chegada e VOLTA (ex.: lote logo na saída da
  // rotatória), termina direto na frente do lote, sem o "vai e volta" de poucos metros
  const n=out.length;
  if(n>=3){
    const v1=xy(out[n-2],out[n-3]), v2=xy(out[n-1],out[n-2]);
    const cs=(v1[0]*v2[0]+v1[1]*v2[1])/((Math.hypot(v1[0],v1[1])||1)*(Math.hypot(v2[0],v2[1])||1));
    if(cs<-0.86){
      out.splice(n-2,1);
      for(let k=0;k<mapa.length;k++){ if(mapa[k]===n-2) mapa[k]=undefined; else if(mapa[k]===n-1) mapa[k]=n-2; }
    }
  }
  return { pts:out, mapa };
}
// o destino fica à direita ou à esquerda de quem chega?
function ladoDestino(){
  const p=NAV.pts, b=p[p.length-1]; let k=p.length-2;
  while(k>0 && metros(p[k],b)<8) k--;
  if(k<0) return null;
  const v=xy(b,p[k]), w=xy(NAV.dest.alvo||NAV.dest.ll,p[k]);   // lado do PRÉDIO (a porta fica na rua)
  return (v[0]*w[1]-v[1]*w[0])>0 ? 'esquerda' : 'direita';
}
function desenharRota(){
  [routeLine,routeBg,routeDone].forEach(l=>l&&map.removeLayer(l));
  routeBg  =L.polyline(NAV.pts,{color:'#ffffff',weight:12,opacity:.95,renderer:canvas,interactive:false}).addTo(map);
  routeLine=L.polyline(NAV.pts,{color:'#0fb5a6',weight:7,renderer:canvas,interactive:false}).addTo(map);
  routeDone=L.polyline([],{color:'#94a3b8',weight:7,renderer:canvas,interactive:false}).addTo(map);
  if(destMarker) map.removeLayer(destMarker);
  destMarker=L.marker(NAV.dest.ll,{icon:L.divIcon({className:'',iconSize:[34,34],iconAnchor:[17,17],
    html:'<div class="pin"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M5 21V4h11l-1.5 3.5L16 11H7v10z"/></svg></div>'})}).addTo(map);
}
// projeta a bolinha na rota; prefere o trecho logo à frente do último ponto conhecido
// (em rota com retorno a rua aparece duas vezes e a projeção não pode "pular" pro fim)
function projetarRota(ll){
  let glob=null, perto=null;
  for(let i=0;i+1<NAV.pts.length;i++){
    const pr=projetarNoSegmento(ll,NAV.pts[i],NAV.pts[i+1]);
    const c={d:pr.dist, s:NAV.cum[i]+metros(NAV.pts[i],pr.latlng)};
    if(!glob||c.d<glob.d) glob=c;
    if(c.s>=NAV.lastS-30 && c.s<=NAV.lastS+150 && (!perto||c.d<perto.d)) perto=c;
  }
  const r=(perto && perto.d<glob.d+15) ? perto : glob;
  NAV.lastS=Math.max(NAV.lastS, r.s);
  return r;
}
// ponto e rumo da rota a `s` metros do início (p/ desenhar a bolinha grudada na linha)
function pontoEm(s){
  const p=NAV.pts, c=NAV.cum;
  for(let i=0;i+1<p.length;i++) if(c[i+1]>=s){
    const t=Math.max(0, Math.min(1, (s-c[i])/((c[i+1]-c[i])||1)));
    return { ll:[p[i][0]+(p[i+1][0]-p[i][0])*t, p[i][1]+(p[i+1][1]-p[i][1])*t], i };
  }
  return { ll:p[p.length-1], i:p.length-2 };
}
function rumoEm(i){
  const p=NAV.pts; let j=i;
  while(j+2<p.length && metros(p[j],p[j+1])<1) j++;   // pula trechos de comprimento ~0
  const v=xy(p[j+1],p[j]); return (Math.atan2(v[0],v[1])/rad+360)%360;
}
function trechoAte(s){
  const p=NAV.pts, c=NAV.cum, out=[];
  for(let i=0;i+1<p.length;i++){
    out.push(p[i]);
    if(c[i+1]>=s){ const t=(s-c[i])/((c[i+1]-c[i])||1);
      out.push([p[i][0]+(p[i+1][0]-p[i][0])*t, p[i][1]+(p[i+1][1]-p[i][1])*t]); return out; }
  }
  return p.slice();
}
// centraliza deixando a bolinha acima do painel
function centrarEm(ll, zoom){
  const z=zoom||map.getZoom(), h=$('sheet').offsetHeight;
  const pt=map.project(L.latLng(ll[0],ll[1]), z).add([0, h/2-40]);
  map.setView(map.unproject(pt, z), z, {animate:true});
}

function atualizarNav(){
  if(!NAV.pts || GPS.arrived) return;
  let s=0;
  const dentro=dentroDoLoteamento(GPS.ll), M=modo();
  GPS.vis=null;
  if(GPS.ll && dentro){
    // a rota saiu da portaria porque o GPS ainda não tinha posição; a pessoa está em outro
    // lugar do loteamento (ex.: em casa) → refaz UMA vez a partir de onde ela está
    // (só na 1ª leitura e só se a rota foi traçada SEM posição — senão, andando desde a
    //  portaria, ela se refazia sozinha no meio do caminho)
    if(!NAV.ajusteFeito){
      NAV.ajusteFeito=true;
      if(NAV.semGPS && !NAV.origemGPS && GPS.acc<=65 && metros(GPS.ll, NAV.pts[0])>40
         && calcularRota() && NAV.origemGPS){ vozInicio(); return atualizarNav(); }
    }
    const pr=projetarRota(GPS.ll);
    s=NAV.lastS;                       // progresso só anda pra frente (GPS tremendo não "volta" a bolinha)
    // perto da linha → a bolinha fica GRUDADA na rota (posição e rumo da própria rua)
    const lim=Math.max(M.lim, Math.min(GPS.acc, 45));
    if(pr.d<=lim){ const pe=pontoEm(s); GPS.vis=pe.ll; GPS.visHd=rumoEm(pe.i); }
    // ainda saindo de casa até a rua (perto do começo da rota): não é "fora da rota"
    const saindoDeCasa = NAV.origemGPS && NAV.lastS<10 && metros(GPS.ll, NAV.pts[0])<60;
    // saiu da rota? (N leituras seguidas longe da linha, GPS razoável) → recalcula
    GPS.offCount = (pr.d>lim && GPS.acc<=50 && !saindoDeCasa) ? GPS.offCount+1 : 0;
    if(GPS.offCount>=M.leituras && Date.now()-GPS.lastRecalc>M.intervalo){
      GPS.lastRecalc=Date.now(); GPS.offCount=0;
      if(calcularRota(true)){ toast('Rota recalculada'); falar(['Rota recalculada.'], true); return atualizarNav(); }
    }
    // chegou?
    if(NAV.total-s<15 || metros(GPS.ll, NAV.pts[NAV.pts.length-1])<18) return chegou();
    if(GPS.follow) centrarEm(GPS.vis||GPS.ll, map.getZoom()<17 ? 18 : null);
    $('navHint').textContent='';
  } else {
    $('navHint').textContent = !GPS.ll ? $('navHint').textContent
      : 'A rota começa na portaria — a bolinha aparece no caminho quando você entrar.';
  }
  routeDone.setLatLngs(trechoAte(s));
  const falta=Math.max(0, NAV.total-s);
  const min=minutos(falta);
  $('rDist').textContent=fmtDist(falta);
  $('rTempo').textContent=min+' min';
  $('rEta').textContent=new Date(Date.now()+min*60000).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  $('progBar').style.width=(NAV.total ? Math.min(100,100*s/NAV.total) : 0)+'%';
  const prox=NAV.mans.find(m=>m.s>s+3);
  if(prox) setManobra(iconeManobra(prox), fmtDist(prox.s-s), textoManobra(prox));
  else setManobra(seta(SETA.chegada), fmtDist(falta), `${NAV.dest.nome} à ${NAV.lado||'frente'}`);
  if(GPS.ll && dentro) vozNav(s, falta);
}

// rota até um lote OU ponto nomeado. Termina na RUA em frente ao destino ('p_<id>').
// `alvo` (opcional) = onde o lugar fica de fato (ex.: prédio do Clube); a rota vai até a porta.
function rotaPara(destNode, destLatLng, nome, alvo){
  liberarAudio();                 // estamos dentro do toque → libera o áudio no iPhone
  $('err').textContent='';
  const frente=G.nodes.has('p_'+destNode) ? 'p_'+destNode : destNode;
  NAV.dest={ node:destNode, frente, ll:destLatLng, nome, alvo:alvo||null };
  NAV.ajusteFeito=false; NAV.semGPS=!GPS.ll; GPS.arrived=false; GPS.offCount=0;
  if(!calcularRota()){ NAV.dest=null; $('err').textContent='Não encontrei rota até esse destino.'; return; }
  $('dName').textContent=nome;
  $('rModo').textContent=modo().rotulo;
  estado('stNav');
  vozInicio();                    // ainda dentro do toque → libera a voz no iPhone
  ligarGPS(); manterTelaLigada();
  GPS.follow=true; $('recenter').hidden=true;
  requestAnimationFrame(()=>{
    if(!NAV.pts) return;            // cancelou antes do próximo quadro
    map.fitBounds(L.latLngBounds(NAV.pts).pad(0.1), Object.assign(padOpts(),{maxZoom:18})); atualizarNav();
  });
}
function chegou(){
  GPS.arrived=true; GPS.vis=null;
  // chegou: a linha da rota some (fica só a bandeira do destino)
  [routeLine,routeBg,routeDone].forEach(l=>l&&map.removeLayer(l));
  routeLine=routeBg=routeDone=null;
  $('arrTxt').textContent=`${NAV.dest.nome} fica à sua ${NAV.lado||'frente'}.`;
  estado('stArr'); soltarTela(); confete();
  falar(FRASE.chegou(NAV.dest.nome, NAV.lado), true);
}
function encerrar(){
  pararVoz();
  NAV.dest=null; NAV.pts=null; GPS.arrived=false; GPS.vis=null;
  if(GPS.ll) desenharEu();
  [routeLine,routeBg,routeDone,destMarker].forEach(l=>l&&map.removeLayer(l));
  routeLine=routeBg=routeDone=destMarker=null;
  $('lote').value=''; $('err').textContent=''; $('recenter').hidden=true;
  estado('stChoose'); soltarTela(); requestAnimationFrame(fitAll);
}
function traçar(ev){
  if(ev) ev.preventDefault();
  $('err').textContent='';
  const v=$('lote').value.trim(), lot=LOTS_BY_ID.get(parseInt(v,10));
  if(!lot){ $('err').textContent = v ? `Não existe o lote ${v}. Os lotes vão de ${LMIN} a ${LMAX}.` : 'Digite o número do lote.'; return; }
  $('lote').blur();
  rotaPara('L'+lot.id, lot.latlng, `Lote ${lot.id}`);
}

/* ---------------- GPS: bolinha em tempo real ---------------- */
function ligarGPS(){
  if(!('geolocation' in navigator)){ $('navHint').textContent='Este aparelho não informa a localização — siga a linha no mapa.'; return; }
  if(GPS.watch!=null) return;
  $('navHint').textContent='Procurando sua localização…';
  GPS.watch=navigator.geolocation.watchPosition(onFix, onGeoErr, {enableHighAccuracy:true, maximumAge:1000, timeout:20000});
}
function onGeoErr(e){
  $('navHint').textContent = e.code===1
    ? 'Localização bloqueada. Permita o acesso pra ver onde você está — enquanto isso, siga a linha.'
    : 'Sem sinal de GPS agora — siga a linha no mapa.';
}
function onFix(pos){
  const c=pos.coords, ll=[c.latitude,c.longitude];
  // rumo: o do GPS quando está andando; senão, o do deslocamento entre leituras
  let hd=(c.heading!=null && !isNaN(c.heading) && (c.speed||0)>0.8) ? c.heading : null;
  if(hd==null && GPS.ll && metros(GPS.ll,ll)>4){ const v=xy(ll,GPS.ll); hd=(Math.atan2(v[0],v[1])/rad+360)%360; }
  if(hd!=null) GPS.heading=hd;
  GPS.ll=ll; GPS.acc=c.accuracy||999;
  if(NAV.dest) atualizarNav();          // decide se a bolinha gruda na rota (GPS.vis)
  desenharEu();
}
// desenha a bolinha: grudada na rota (GPS.vis) quando está no caminho; senão, onde o GPS diz
function desenharEu(){
  const ll=GPS.vis||GPS.ll, hd=GPS.vis ? GPS.visHd : GPS.heading;
  const cone=`display:${hd==null?'none':'block'};transform:rotate(${hd||0}deg)`;
  const raio=GPS.vis ? 0 : Math.min(GPS.acc,80);   // grudada: some o círculo de precisão
  if(!GPS.marker){
    GPS.accCircle=L.circle(ll,{radius:raio,color:'#2563eb',weight:1,opacity:.35,fillOpacity:.08,interactive:false}).addTo(map);
    GPS.marker=L.marker(ll,{interactive:false,zIndexOffset:1000,icon:L.divIcon({className:'',iconSize:[24,24],iconAnchor:[12,12],
      html:`<div class="me"><div class="cone" style="${cone}"></div><div class="halo"></div><div class="dot"></div></div>`})}).addTo(map);
  } else {
    GPS.marker.setLatLng(ll); GPS.accCircle.setLatLng(ll).setRadius(raio);
    const el=GPS.marker.getElement(), cn=el && el.querySelector('.cone');
    if(cn) cn.style.cssText=cone;
  }
}

/* ---------------- voz das instruções ----------------
   Cada frase é uma lista de PEDAÇOS (ex.: ["Em 150 metros,", "vire à direita na Rua X."]).
   1º) Se todos os pedaços existem GRAVADOS (voz/indice.json → voz/*.mp3, gerados uma vez
       com voz neural — ferramentas/gerar_voz.py), toca as gravações emendadas pelo Web
       Audio. Mesma voz natural em qualquer celular; funciona sem sinal (cache do app).
   2º) Senão, a voz do próprio celular lê a frase inteira (melhor voz pt-BR disponível).
   Avisa ~150 m antes da manobra e de novo na hora. No iPhone o áudio só é liberado depois
   de um toque — por isso liberarAudio()/vozInicio() rodam no toque que traça a rota. */
const VOZ={ ligada:true, voz:null, clips:null, ctx:null, buf:new Map(), fontes:[], fim:0 };
try{ VOZ.ligada = localStorage.getItem('copa.voz')!=='0'; }catch(e){}
// melhor voz do celular: pt-BR > aprimorada/premium/neural > Google/rede
function escolherVoz(){
  const nota=(v)=> (/pt[-_]BR/i.test(v.lang)?100:0) + (/premium|enhanced|aprimorad|neural|natural/i.test(v.name)?50:0)
                 + (/google/i.test(v.name)?30:0) + (v.localService===false?10:0) + (/luciana|francisca|thalita/i.test(v.name)?5:0);
  VOZ.voz = speechSynthesis.getVoices().filter(v=>/^pt/i.test(v.lang)).sort((a,b)=>nota(b)-nota(a))[0] || null;
}
if('speechSynthesis' in window){ escolherVoz(); speechSynthesis.onvoiceschanged=escolherVoz; }
fetch('voz/indice.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>{ VOZ.clips=(j&&j.clips)||null; }).catch(()=>{});
const chaveVoz=(t)=> t.toLowerCase().replace(/[.,:;!?]+$/,'').replace(/\s+/g,' ').trim();
// chamado DENTRO de um toque: libera Web Audio e a voz do celular no iPhone
function liberarAudio(){
  try{ VOZ.ctx ||= new (window.AudioContext||window.webkitAudioContext)(); if(VOZ.ctx.state==='suspended') VOZ.ctx.resume(); }catch(e){}
  try{ if('speechSynthesis' in window && !VOZ.synthOk){ const u=new SpeechSynthesisUtterance(' '); u.volume=0; speechSynthesis.speak(u); VOZ.synthOk=true; } }catch(e){}
}
function bufferDe(arq){
  if(!/^[0-9a-f]{12}\.mp3$/.test(arq)) return Promise.reject(new Error('arquivo de voz inválido'));   // só nomes gerados pelo gerar_voz.py
  if(VOZ.buf.has(arq)) return VOZ.buf.get(arq);
  const p=fetch('voz/'+arq).then(r=>{ if(!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then(a=>new Promise((ok,er)=>VOZ.ctx.decodeAudioData(a,ok,er)));
  VOZ.buf.set(arq,p); p.catch(()=>VOZ.buf.delete(arq));
  return p;
}
// baixa de antemão os pedaços das frases desta rota (a fala sai sem atraso)
function preCarregar(frases){
  if(!VOZ.clips || !VOZ.ctx) return;
  for(const partes of frases) for(const t of partes){ const a=VOZ.clips[chaveVoz(t)]; if(a) bufferDe(a).catch(()=>{}); }
}
function pararVoz(){
  try{ speechSynthesis.cancel(); }catch(e){}
  for(const s of VOZ.fontes){ try{ s.stop(); }catch(e){} }
  VOZ.fontes=[]; VOZ.fim=0;
}
function falarCelular(txt){
  if(!('speechSynthesis' in window)) return;
  const u=new SpeechSynthesisUtterance(txt);
  u.lang='pt-BR'; if(VOZ.voz) u.voice=VOZ.voz; u.rate=1.02;
  speechSynthesis.speak(u);
}
async function falar(partes, urgente){
  if(typeof partes==='string') partes=[partes];
  const txt=partes.join(' ');
  (window._falas ||= []).push(txt);                  // registro (testes/depuração)
  if(!VOZ.ligada) return;
  if(urgente) pararVoz();
  const arqs=VOZ.clips && VOZ.ctx ? partes.map(t=>VOZ.clips[chaveVoz(t)]) : null;
  if(!arqs || arqs.some(a=>!a)){ (window._falasCelular ||= []).push(txt); return falarCelular(txt); }
  try{
    // espera as gravações no máximo 1,5 s (sem sinal e sem cache → voz do celular)
    const bufs=await Promise.race([ Promise.all(arqs.map(bufferDe)), new Promise((_,er)=>setTimeout(()=>er(new Error('demorou')),1500)) ]);
    if(VOZ.ctx.state==='suspended') await VOZ.ctx.resume();
    let t=Math.max(VOZ.ctx.currentTime+0.03, VOZ.fim + (VOZ.fim ? 0.35 : 0));
    bufs.forEach((b,i)=>{
      const s=VOZ.ctx.createBufferSource(); s.buffer=b; s.connect(VOZ.ctx.destination); s.start(t);
      VOZ.fontes.push(s); s.onended=()=>{ VOZ.fontes=VOZ.fontes.filter(x=>x!==s); };
      t+=b.duration + (/[.:]$/.test(partes[i]) ? 0.22 : /,$/.test(partes[i]) ? 0.12 : 0.04);   // pausa natural
    });
    VOZ.fim=t;
    (window._falasGravadas ||= []).push(txt);
  }catch(e){ (window._falasCelular ||= []).push(txt); falarCelular(txt); }
}
const distFalada=(m)=> m>=950 ? (Math.round(m/100)/10===1 ? '1 quilômetro' : `${(Math.round(m/100)/10).toFixed(1).replace('.',',')} quilômetros`)
                     : `${m>100 ? Math.round(m/50)*50 : Math.max(10, Math.round(m/10)*10)} metros`;
const minusc=(t)=> t.charAt(0).toLowerCase()+t.slice(1);
const maiusc=(t)=> t.charAt(0).toUpperCase()+t.slice(1);
// "o lote 367", "o Clube", "a Saída", "a Administração"
const comArtigo=(nome)=> /^Lote /.test(nome) ? 'o '+minusc(nome) : (/(a|ção|ída)$/i.test(nome) ? 'a ' : 'o ')+nome;
// "ao lote 367", "ao Clube", "à Saída"
const aoDestino=(nome)=>{ const a=comArtigo(nome); return a.startsWith('a ') ? 'à '+a.slice(2) : 'a'+a; };
// ---- frases (em pedaços; os MESMOS textos que ferramentas/gerar_voz.py grava) ----
const FRASE={
  inicio:(nome,total)=>[`Rota para ${comArtigo(nome)}.`, `São ${distFalada(total)}.`],
  emDist:(d)=>`Em ${distFalada(d)},`,
  manobra:(m)=>`${maiusc(textoManobra(m))}.`,
  sigaPor:(rua,d)=>[rua ? `Siga pela ${rua}` : 'Siga em frente', `por ${distFalada(d)}.`],
  final:(d,lado)=>[`Em ${distFalada(d)},`, `o destino fica à sua ${lado||'frente'}.`],
  chegou:(nome,lado)=>[`Você chegou ${aoDestino(nome)}.`, `Fica à sua ${lado||'frente'}.`],
};
function vozInicio(){
  const prox=NAV.mans[0];
  let partes=FRASE.inicio(NAV.dest.nome, NAV.total);
  if(prox && prox.s<=200){ partes=partes.concat([FRASE.emDist(prox.s), FRASE.manobra(prox)]); prox.ditoLonge=true; }
  else if(prox) partes=partes.concat(FRASE.sigaPor(ruaApos(NAV.ids,0), prox.s));
  falar(partes, true);
  // já deixa baixando as falas desta rota
  preCarregar(NAV.mans.map(m=>[FRASE.manobra(m)]).concat([[`Você chegou ${aoDestino(NAV.dest.nome)}.`]]));
}
// a cada leitura do GPS: aviso antecipado (60–200 m) e aviso na hora (≤40 m), uma vez cada
function vozNav(s, falta){
  const prox=NAV.mans.find(m=>m.s>s+3);
  if(prox){
    const d=prox.s-s;
    if(d<=40 && !prox.ditoPerto){ prox.ditoPerto=prox.ditoLonge=true; falar([FRASE.manobra(prox)], true); }
    else if(d<=200 && d>60 && !prox.ditoLonge){ prox.ditoLonge=true; falar([FRASE.emDist(d), FRASE.manobra(prox)]); }
  } else if(falta<=70 && !NAV.ditoFinal){
    NAV.ditoFinal=true; falar(FRASE.final(falta, NAV.lado));
  }
}
const ICON_SOM_ON='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
const ICON_SOM_OFF='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
function setSom(on){
  VOZ.ligada=on; try{ localStorage.setItem('copa.voz', on?'1':'0'); }catch(e){}
  if(!on) pararVoz();
  const b=$('som'); b.innerHTML=on?ICON_SOM_ON:ICON_SOM_OFF;
  b.setAttribute('aria-pressed', on); b.setAttribute('aria-label', on?'Voz ligada':'Voz desligada');
}

/* tela ligada durante a navegação (o motoqueiro não precisa ficar tocando) */
let WAKE=null;
async function manterTelaLigada(){ try{ if('wakeLock' in navigator) WAKE=await navigator.wakeLock.request('screen'); }catch(e){} }
function soltarTela(){ try{ WAKE && WAKE.release(); }catch(e){} WAKE=null; }
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && NAV.dest && !GPS.arrived) manterTelaLigada(); });

/* confete na chegada (inspirado no "Confetti" do naocodei: gravidade, giro e resistência do ar) */
function confete(){
  const cv=$('confetti'), ctx=cv.getContext('2d'), dpr=window.devicePixelRatio||1, W=innerWidth, H=innerHeight;
  cv.hidden=false; cv.width=W*dpr; cv.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
  const cores=['#14b8a6','#2563eb','#f59e0b','#ef4444','#a855f7','#22c55e'];
  const P=Array.from({length:140},()=>({x:W/2+(Math.random()-.5)*90, y:H*.6, vx:(Math.random()-.5)*10, vy:-(7+Math.random()*9),
    r:5+Math.random()*5, a:Math.random()*6.28, va:(Math.random()-.5)*.3, c:cores[Math.random()*cores.length|0]}));
  const t0=performance.now();
  (function quadro(t){
    ctx.clearRect(0,0,W,H); let vivos=0;
    for(const p of P){ p.vy+=.28; p.vx*=.985; p.vy*=.985; p.x+=p.vx; p.y+=p.vy; p.a+=p.va;
      if(p.y<H+20){ vivos++; ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.a); ctx.fillStyle=p.c; ctx.fillRect(-p.r/2,-p.r/4,p.r,p.r/2); ctx.restore(); } }
    if(vivos && t-t0<4500) requestAnimationFrame(quadro); else { ctx.clearRect(0,0,W,H); cv.hidden=true; }
  })(t0);
}

/* ícones dos destinos fixos */
// texto que vai pra dentro de HTML (tooltips/botões) sempre escapado
const esc=(s)=> String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ICON_POI={
  'Clube':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0d9488" stroke-width="2.2" stroke-linecap="round"><path d="M2 17c2 0 2-1.5 4-1.5S8 17 10 17s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5M2 21c2 0 2-1.5 4-1.5S8 21 10 21s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/><path d="M8 14V5a2 2 0 0 1 4 0M14 14V5a2 2 0 0 1 4 0M8 9h6"/></svg>',
  'Saída':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e11d48" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/></svg>',
  'Administração':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V7l8-4 8 4v14M9 21v-5h6v5M8 10h.01M12 10h.01M16 10h.01"/></svg>',
};
ICON_POI['Smart Bodega']='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1.2 12.1a1 1 0 0 1-1 .9H7.2a1 1 0 0 1-1-.9z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';
const ORDEM_POI=['Clube','Saída','Administração','Smart Bodega'];

(async function init(){
  const data = await carregarDados();

  // motor comum: grafo + grudar portaria/lotes
  G = buildGraph(data.lines);
  // rotatórias: só MARCADOR visual por ora. A injeção de anel automática não casa
  // com o DWG (o cruzamento da malha fica ~9m fora do círculo do DWG → zigue-zague).
  // O contorno correto virá redesenhando a geometria da rua conforme o DWG.
  // rot. 1 (entrada) fica só marcador (rua do clube reta); 2/3/4 ganham o contorno alinhado ao DWG.
  const SEM_CIRCULACAO=['Rotatória 1'];
  try{
    const rr=await fetch('dados/rotatorias.geojson',{cache:'no-store'});
    if(rr.ok){ const rj=await rr.json();
      const rots=(rj.features||[]).map(f=>({lat:f.geometry.coordinates[1], lng:f.geometry.coordinates[0], raio:(f.properties||{}).raio_m||6, nome:(f.properties||{}).nome,
        circula:!SEM_CIRCULACAO.includes((f.properties||{}).nome)}));
      injectRotatorias(G, rots.filter(r=>!SEM_CIRCULACAO.includes(r.nome)));
      window.ROTATORIAS=rots;
    }
  }catch(e){ console.warn('rotatorias', e); }
  agruparCruzamentos(G);
  PORT_NODE = grudarNaRua(G, data.portaria, 'PORTARIA');
  LOTS_BY_ID = new Map();
  for(const lot of data.lots) LOTS_BY_ID.set(lot.id, lot);
  // direção da fileira: vizinho de numeração (id±1) a <25m define a frente do lote
  const rowDir=(lot)=>{
    // usa o vizinho de numeração MAIS PRÓXIMO (o outro pode estar do lado de lá da esquina)
    const cos0=Math.cos(lot.latlng[0]*rad);
    let best=null;
    for(const nb of [LOTS_BY_ID.get(lot.id-1), LOTS_BY_ID.get(lot.id+1)]){
      if(!nb) continue;
      let dy=nb.latlng[0]-lot.latlng[0], dx=(nb.latlng[1]-lot.latlng[1])*cos0;
      const L=Math.hypot(dx,dy)*6378137*rad;   // metros aprox
      if(L>2 && L<25 && (!best || L<best.L)) best={L, dir:[dy/Math.hypot(dx,dy), dx/Math.hypot(dx,dy)]};
    }
    return best ? best.dir : null;
  };
  // CONSENSO DE FILEIRA: acessos de uma fileira contígua devem ficar na MESMA rua.
  // fase 1: escolha preliminar de cada lote
  const pre=new Map();
  for(const lot of data.lots){
    const b=escolherAcesso(G, lot.latlng, rowDir(lot), null);
    pre.set(lot.id, b?b.st:null);
  }
  // fase 2: fileiras = sequências de ids consecutivos com passo <25m; street modal
  const mFileira=(a,b)=>{ const cos0=Math.cos(a[0]*rad);
    return Math.hypot((b[0]-a[0]), (b[1]-a[1])*cos0)*6378137*rad; };
  const idsSeq=data.lots.map(l=>l.id).sort((a,b)=>a-b);
  const byId=new Map(data.lots.map(l=>[l.id,l]));
  let fila=[];
  const filas=[];
  for(let i=0;i<idsSeq.length;i++){
    const id=idsSeq[i];
    if(fila.length){
      const prevLot=byId.get(fila[fila.length-1]);
      if(id!==fila[fila.length-1]+1 || mFileira(prevLot.latlng, byId.get(id).latlng)>=25){ filas.push(fila); fila=[]; }
    }
    fila.push(id);
  }
  if(fila.length) filas.push(fila);
  const alvoSt=new Map();
  for(const f of filas){
    if(f.length<3) continue;                       // fileira curta: sem consenso
    const cnt=new Map();
    for(const id of f){ const s=pre.get(id); if(s!=null && s>=0) cnt.set(s,(cnt.get(s)||0)+1); }
    let modal=null, mx=0;
    cnt.forEach((v,k)=>{ if(v>mx){mx=v;modal=k;} });
    if(modal!=null && mx>=f.length*0.5)            // maioria clara
      for(const id of f) if(pre.get(id)!==modal) alvoSt.set(id, modal);
  }
  // overrides manuais confirmados em campo (frente real do lote → street(s))
  // 427-431: frente é a CURVA da rotatória norte (streets 42-45, fluxo p/ leste)
  const CURVA=[42,43,44,45];
  const ACC_OVERRIDE={427:CURVA,428:CURVA,429:CURVA,430:CURVA,431:CURVA};
  // grupos que grudavam na rua de trás → forçar a rua da FRENTE (mais próxima)
  for(let i=13;i<=21;i++) ACC_OVERRIDE[i]=11;
  for(let i=35;i<=47;i++) ACC_OVERRIDE[i]=9;
  for(let i=63;i<=80;i++) ACC_OVERRIDE[i]=13;
  // ajuste fino do ponto de chegada (metros ao longo do sentido da via)
  const ACC_NUDGE={427:6};
  // fase 3: insere acessos (outliers presos à street modal da fileira)
  for(const lot of data.lots)
    grudarNaRua(G, lot.latlng, 'L'+lot.id, rowDir(lot), ACC_OVERRIDE[lot.id] ?? alvoSt.get(lot.id) ?? null, ACC_NUDGE[lot.id]);

  // POIs nomeados (opcional): dados/pois.geojson
  let pois=[];
  try{
    const pr=await fetch('dados/pois.geojson',{cache:'no-store'});
    if(pr.ok){ const pj=await pr.json();
      // geometry = PORTA (onde a rota termina); properties.icone [lng,lat] = onde o ícone fica
      // (ex.: em cima do prédio do Clube). Sem `icone`, o ícone fica na porta.
      pois=(pj.features||[]).map(f=>{ const pr=f.properties||{}, ic=pr.icone;
        return {nome:pr.nome||'POI', latlng:[f.geometry.coordinates[1],f.geometry.coordinates[0]],
                icone:(Array.isArray(ic) && ic.length===2 && ic.every(Number.isFinite)) ? [ic[1],ic[0]] : null}; });
    }
  }catch(e){}
  pois.forEach((p,i)=>{ p.node='POI'+i; grudarNaRua(G, p.latlng, p.node); });
  absorverAcessos(G);
  construirReverso(G);            // p/ o modo a pé (contramão liberada)

  // nomes das ruas p/ instruções e voz (opcional; sem o arquivo, as instruções saem sem nome)
  try{
    const nr=await fetch('dados/nomes_ruas.json',{cache:'no-store'});
    if(nr.ok){ NOME_ST=(await nr.json()).trechos||{};
      map.attributionControl.addAttribution('Nomes © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'); }
  }catch(e){}

  // pistas da portaria e a avenida em frente (só desenho, não entram nas rotas)
  try{
    const ar=await fetch('dados/acessos.geojson',{cache:'no-store'});
    if(ar.ok){ const fs=((await ar.json()).features||[]).filter(f=>f.geometry);
      data.extras=fs.filter(f=>f.geometry.type==='LineString').map(f=>{
        const pr=f.properties||{};
        return { path:f.geometry.coordinates.map(c=>[c[1],c[0]]), tipo:pr.tipo==='avenida'?'avenida':'acesso',
                 rotulo: typeof pr.nome==='string' ? pr.nome : null }; });
      data.pisos=fs.filter(f=>f.geometry.type==='Polygon').map(f=>f.geometry.coordinates[0].map(c=>[c[1],c[0]])); }
  }catch(e){}

  ALL_BOUNDS = desenharBase(data);
  // rotatórias no mapa (contorno branco discreto)
  (window.ROTATORIAS||[]).forEach(rt=>{
    ROT_LY.push(L.circle([rt.lat,rt.lng],Object.assign({radius:(rt.raio||6),interactive:false}, estiloRot())).addTo(map));
  });
  // destinos fixos: só os de ORDEM_POI (Clube, Saída, Administração, Smart Bodega), nessa ordem
  pois.sort((a,b)=>(ORDEM_POI.indexOf(a.nome)+99)%99-(ORDEM_POI.indexOf(b.nome)+99)%99);
  for(const p of pois){
    const ic=ICON_POI[p.nome]||ICON_POI['Administração'];
    L.marker(p.icone||p.latlng,{icon:L.divIcon({className:'',html:`<div class="poi">${ic.replace(/width="22" height="22"/,'width="16" height="16"')}</div>`,iconSize:[28,28],iconAnchor:[14,14]})})
      .addTo(map).bindTooltip(esc(p.nome),{direction:'top'});
    if(!ORDEM_POI.includes(p.nome)) continue;
    const b=document.createElement('button'); b.className='place press'; b.type='button';
    b.innerHTML=`<span class="pi">${ic}</span>${esc(p.nome)}`;
    b.onclick=()=>rotaPara(p.node, p.latlng, p.nome, p.icone);
    $('places').appendChild(b);
  }

  const ids=[...LOTS_BY_ID.keys()]; LMIN=Math.min(...ids); LMAX=Math.max(...ids);
  $('lote').placeholder=`Número do lote (${LMIN} a ${LMAX})`;
  if(data.mode!=='real') console.warn('Sem dados reais em dados/*.geojson — usando malha de exemplo.');

  estado('stChoose');
  fitAll(); map.whenReady(()=>setTimeout(fitAll,150)); window.addEventListener('load',()=>setTimeout(fitAll,350));
  window.addEventListener('resize',()=>{ posFab(); });

  // eventos
  $('fLote').addEventListener('submit',traçar);
  $('cancel').onclick=encerrar;
  setFundo(FUNDO);
  $('fundo').onclick=()=>setFundo(FUNDO==='satelite'?'mapa':'satelite');
  setModo(MODO);
  document.querySelectorAll('#modos .modo').forEach(b=> b.onclick=()=>setModo(b.dataset.modo));
  setSom(VOZ.ligada);
  $('som').onclick=()=>{ liberarAudio(); setSom(!VOZ.ligada); if(VOZ.ligada) falar(['Voz ligada.'], true); };
  $('again').onclick=encerrar;
  $('recenter').onclick=()=>{ GPS.follow=true; $('recenter').hidden=true; posFab(); if(GPS.ll) centrarEm(GPS.vis||GPS.ll, Math.max(map.getZoom(),18)); };
  map.on('dragstart',()=>{ if(NAV.dest && !GPS.arrived){ GPS.follow=false; $('recenter').hidden=false; posFab(); } });

  // se a pessoa já deu permissão de localização antes, a bolinha aparece sem perguntar de novo
  try{ navigator.permissions && navigator.permissions.query({name:'geolocation'}).then(p=>{ if(p.state==='granted') ligarGPS(); }).catch(()=>{}); }catch(e){}

  // PWA: funciona como app (tela cheia, ícone na tela inicial) e abre mesmo com sinal fraco
  if('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('sw.js').catch(()=>{});

  // expõe p/ depuração no console (e p/ simular o GPS nos testes)
  Object.assign(window,{ G, LOTS_BY_ID, PORT_NODE, dijkstra, rotaPara, NAV, GPS, onFix, setModo, modo });
  // TODOS os pedaços de frase que a voz pode falar (lista usada por ferramentas/gerar_voz.py
  // pra gravar a voz neural — mesma fonte de texto do app, então nada fica de fora)
  window.inventarioVoz=()=>{
    const S=new Set(), add=(a)=>a.forEach(t=>S.add(t));
    const ruas=[...new Set(Object.values(NOME_ST))].concat([null]);
    const dists=new Set(); for(let m=0;m<=1600;m++) dists.add(distFalada(m));
    for(const n of [...LOTS_BY_ID.keys()].map(id=>'Lote '+id).concat(ORDEM_POI)){
      add(FRASE.inicio(n,100).slice(0,1)); add(FRASE.chegou(n,'direita').slice(0,1));
    }
    for(const l of ['direita','esquerda','frente']){ add(FRASE.chegou('Clube',l).slice(1)); add(FRASE.final(100,l).slice(1)); }
    for(const dt of dists){ S.add(`São ${dt}.`); S.add(`Em ${dt},`); S.add(`por ${dt}.`); }
    for(const r of ruas){
      S.add(r ? `Siga pela ${r}` : 'Siga em frente');
      for(const t of ['esq','dir','leve-esq','leve-dir']) S.add(FRASE.manobra({rot:false,tipo:t,rua:r}));
      for(let k=1;k<ORDINAL.length;k++) S.add(FRASE.manobra({rot:true,saida:k,rua:r,ang:0}));
      for(const a of [0,90,-90,180]) S.add(FRASE.manobra({rot:true,saida:0,rua:r,ang:a}));
    }
    S.add(FRASE.manobra({rot:false,tipo:'retorno',rua:null}));
    add(['Rota recalculada.','Voz ligada.']);
    return [...S];
  };
  window.simularGPS=(pontos, ms=700, acc=6)=>{ clearInterval(window._sim); let i=0;
    window._sim=setInterval(()=>{ if(i>=pontos.length) return clearInterval(window._sim);
      const p=pontos[i++]; onFix({coords:{latitude:p[0],longitude:p[1],accuracy:acc,heading:null,speed:null}}); }, ms); };
})();
