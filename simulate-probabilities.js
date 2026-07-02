/* ============================================================================
 * simulate-probabilities.js  —  Probabilidades de victoria de la porra
 * ----------------------------------------------------------------------------
 * Calcula, con SOLO los resultados oficiales ya registrados, la probabilidad de
 * cada participante de:
 *   - GANAR la porra (quedar 1.º)
 *   - GANAR ALGÚN PREMIO (1.º, 2.º o penúltimo)
 *
 * Cómo: la fase de grupos ya está cerrada, así que la puntuación de cada uno es
 * FIJA salvo lo que aportan las ELIMINATORIAS (puntos por avanzar + goles). Se
 * simula el cuadro restante muchas veces (Montecarlo) usando la fuerza de cada
 * selección (mismo modelo Elo+Poisson que la predicción automática de la app),
 * con un pequeño ajuste por la FORMA real en este Mundial (goles marcados y
 * encajados hasta ahora). Se cuenta cuántas veces gana / cobra premio cada uno.
 *
 * Se ejecuta UNA VEZ al día (tras actualizar official.json) y escribe
 * probabilities.json, que la app lee para mostrar el % junto a cada nombre.
 *
 * Uso:  node simulate-probabilities.js [nSims]
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const OFFICIAL = JSON.parse(fs.readFileSync(path.join(DIR, 'official.json'), 'utf8'));
const N_SIMS = parseInt(process.argv[2], 10) || 50000;

/* ---- Extraer literales de datos desde index.html (fuente única de verdad) ----
 * Busca `const NAME=` y recorta el literal { } o [ ] equilibrando corchetes,
 * ignorando lo que haya dentro de cadenas. Así RATING, GROUPS, KO, PARTICIPANTS,
 * etc. nunca se desincronizan entre la app y este script. */
function grabLiteral(name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*');
  const m = re.exec(HTML);
  if (!m) throw new Error('No encuentro const ' + name);
  let i = m.index + m[0].length;
  const open = HTML[i];
  if (open !== '{' && open !== '[') throw new Error(name + ' no empieza por { o [');
  const close = open === '{' ? '}' : ']';
  let depth = 0, str = null, esc = false;
  for (; i < HTML.length; i++) {
    const c = HTML[i];
    if (str) {
      if (esc) { esc = false; }
      else if (c === '\\') { esc = true; }
      else if (c === str) { str = null; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { i++; break; } }
  }
  return HTML.slice(m.index + m[0].length, i);
}
// T() es el helper que usa GROUPS en la app.
const T = (name, flag) => ({ name, flag });
function evalLiteral(name) {
  // eslint-disable-next-line no-eval
  return eval('(' + grabLiteral(name) + ')');
}

const GROUPS = evalLiteral('GROUPS');
const FIXTURES = evalLiteral('FIXTURES');
const KO = evalLiteral('KO');
const THIRD_ALLOC = evalLiteral('THIRD_ALLOC');
const THIRD_SLOT_ORDER = evalLiteral('THIRD_SLOT_ORDER');
const THIRD_SLOT_TO_MATCH = evalLiteral('THIRD_SLOT_TO_MATCH');
const PPTS = evalLiteral('PPTS');
const RATING = evalLiteral('RATING');
const PORRA_FORM = evalLiteral('PORRA_FORM');
const TEAM_LABEL_MAP = evalLiteral('TEAM_LABEL_MAP');
const PLAYER_TEAMS = evalLiteral('PLAYER_TEAMS');
const PARTICIPANTS = evalLiteral('PARTICIPANTS');
const GLETTERS = Object.keys(GROUPS);

function canonTeam(l) { return TEAM_LABEL_MAP[l] || l; }
const TEAM_INDEX = {};
GLETTERS.forEach(g => GROUPS[g].forEach((t, i) => { TEAM_INDEX[t.name] = { g, i }; }));
function gmId(g, i) { return 'G' + g + '-' + i; }

/* ---- Normalización de nombres de jugador (idéntica a la app) ---- */
function pnorm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss')
    .replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ð/g, 'd').replace(/þ/g, 'th')
    .replace(/ı/g, 'i').replace(/ħ/g, 'h').trim();
}
function pNameMatch(a, b) { const na = pnorm(a), nb = pnorm(b); return !!na && !!nb && (na.includes(nb) || nb.includes(na)); }

/* ---- Resultados oficiales → estado sellado ---- */
const OM = OFFICIAL.matches || {};
function gsS(id) { const s = OM[id]; return (s && s.h !== null && s.a !== null && s.h !== '' && s.a !== '') ? s : null; }

/* Clasificación de un grupo con resultados oficiales. */
function computeStandingsSealed(g) {
  const teams = GROUPS[g];
  const st = teams.map((t, i) => ({ i, t, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0 }));
  FIXTURES.forEach((fx, fi) => {
    const s = gsS(gmId(g, fi)); if (!s) return;
    const h = +s.h, a = +s.a, H = st[fx[0]], A = st[fx[1]];
    H.P++; A.P++; H.GF += h; H.GA += a; A.GF += a; A.GA += h;
    if (h > a) { H.W++; A.L++; H.Pts += 3; } else if (h < a) { A.W++; H.L++; A.Pts += 3; } else { H.D++; A.D++; H.Pts++; A.Pts++; }
  });
  st.forEach(s => s.GD = s.GF - s.GA);
  st.sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.t.name.localeCompare(y.t.name));
  return st;
}
const STANDINGS = {}; GLETTERS.forEach(g => STANDINGS[g] = computeStandingsSealed(g));

/* Asignación oficial (Anexo C) de los 8 mejores terceros a sus huecos. */
function assignThirdsSealed() {
  const arr = GLETTERS.map(g => ({ g, ...STANDINGS[g][2] }));
  const ranked = arr.slice().sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.g.localeCompare(y.g));
  const qualGroups = ranked.slice(0, 8).map(r => r.g);
  const key = qualGroups.slice().sort().join('');
  const alloc = THIRD_ALLOC[key];
  if (!alloc) return null;
  const result = {};
  for (let i = 0; i < THIRD_SLOT_ORDER.length; i++) result[THIRD_SLOT_TO_MATCH[THIRD_SLOT_ORDER[i]]] = alloc[i];
  return result;
}
const THIRD_MAP = assignThirdsSealed();

/* ---- Fuerza + FORMA (goles reales de este Mundial) ---- */
function ratingOf(name) { return RATING[name] || 1500; }
// Forma: goles a favor / en contra por partido de cada selección hasta ahora.
const form = {};   // name -> {gf, ga, pj}
GLETTERS.forEach(g => {
  FIXTURES.forEach((fx, fi) => {
    const s = gsS(gmId(g, fi)); if (!s) return;
    const hn = GROUPS[g][fx[0]].name, an = GROUPS[g][fx[1]].name, h = +s.h, a = +s.a;
    (form[hn] = form[hn] || { gf: 0, ga: 0, pj: 0 }); (form[an] = form[an] || { gf: 0, ga: 0, pj: 0 });
    form[hn].gf += h; form[hn].ga += a; form[hn].pj++;
    form[an].gf += a; form[an].ga += h; form[an].pj++;
  });
});
// Media goleadora del torneo (para comparar la forma de cada equipo con la media).
let totGF = 0, totPJ = 0;
Object.values(form).forEach(f => { totGF += f.gf; totPJ += f.pj; });
const AVG_GF = totPJ ? totGF / totPJ : 1.25;
/* Convertimos la forma en un pequeño ajuste de fuerza (Elo). Un equipo que marca
 * más de la media y encaja menos sube unos puntos; al revés, baja. Se limita a
 * ±45 para que la fuerza base (ranking FIFA + cuotas) siga mandando y no se
 * sobre-reaccione a 3-4 partidos. */
function formDelta(name) {
  const f = form[name]; if (!f || !f.pj) return 0;
  const atk = (f.gf / f.pj) - AVG_GF;        // >0 marca más de la media
  const def = AVG_GF - (f.ga / f.pj);        // >0 encaja menos de la media
  let d = 22 * atk + 22 * def;
  return Math.max(-45, Math.min(45, d));
}
const RATING_EFF = {};
Object.keys(TEAM_INDEX).forEach(name => { RATING_EFF[name] = ratingOf(name) + formDelta(name); });
function reff(name) { return RATING_EFF[name] != null ? RATING_EFF[name] : 1500; }

/* ---- Simulación de un partido de eliminatoria (igual que la app) ---- */
function poissonSample(lambda) { const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; }
function simKO(hn, an) {
  const d = (reff(hn) - reff(an)) / 100;
  const base = 0.98, coef = 0.60, lmin = 0.18, lmax = 1.85;
  const lh = Math.max(lmin, Math.min(lmax, base + coef * d));
  const la = Math.max(lmin, Math.min(lmax, base - coef * d));
  let h = Math.min(3, poissonSample(lh)), a = Math.min(3, poissonSample(la));
  let pen = null;
  if (h === a) { const pHome = 1 / (1 + Math.pow(10, (reff(an) - reff(hn)) / 400)); pen = Math.random() < pHome ? 'h' : 'a'; }
  return { h, a, pen };
}

/* ---- Resolución de un extremo de un cruce (nombre de selección) ---- */
const KO_IDS = Object.keys(KO).sort((x, y) => (+x.slice(1)) - (+y.slice(1)));
function koResult(state, id) {
  const s = state[id]; if (!s) return null;
  const h = +s.h, a = +s.a;
  if (h > a) return 'h'; if (a > h) return 'a';
  return s.pen === 'h' || s.pen === 'a' ? s.pen : null;
}
function resolveEnd(state, src) {
  if (src.t === 'w') return STANDINGS[src.g][0].t.name;
  if (src.t === 'ru') return STANDINGS[src.g][1].t.name;
  if (src.t === '3') { const g = THIRD_MAP && THIRD_MAP[src.slot]; return g ? STANDINGS[g][2].t.name : null; }
  if (src.t === 'mw') { const r = koResult(state, src.m); if (!r) return null; return resolveEnd(state, r === 'h' ? KO[src.m].h : KO[src.m].a); }
  if (src.t === 'ml') { const r = koResult(state, src.m); if (!r) return null; return resolveEnd(state, r === 'h' ? KO[src.m].a : KO[src.m].h); }
  return null;
}

/* ---- Estado sellado inicial de las eliminatorias (M73… ya jugados) ---- */
const SEALED_KO = {};
KO_IDS.forEach(id => { const s = OM[id]; if (s && s.h !== null && s.a !== null && s.h !== '' && s.a !== '') SEALED_KO[id] = { h: +s.h, a: +s.a, pen: s.pen || null }; });

/* ---- Puntuación FIJA (todo lo que NO depende de las eliminatorias) ---- */
// Puntos de una selección por su fase de grupos (resultados + posición + goles).
function teamGroupPts(name) {
  const ti = TEAM_INDEX[name]; if (!ti) return 0;
  let pts = 0, goals = 0;
  FIXTURES.forEach((fx, fi) => {
    if (fx[0] !== ti.i && fx[1] !== ti.i) return;
    const s = gsS(gmId(ti.g, fi)); if (!s) return;
    const side = fx[0] === ti.i ? 'h' : 'a';
    const gf = +(side === 'h' ? s.h : s.a), ga = +(side === 'h' ? s.a : s.h);
    goals += gf;
    if (gf > ga) pts += PPTS.win; else if (gf === ga) pts += PPTS.draw;
  });
  // posición en el grupo
  const st = STANDINGS[ti.g];
  const pos = st.findIndex(x => x.t.name === name);
  if (pos >= 0 && pos < 3) pts += PPTS.pos[pos];
  pts += goals * PPTS.goal;
  return pts;
}
// Puntos de un jugador (SOLO fase de grupos).
function playerPts(playerName) {
  const team = PLAYER_TEAMS[playerName]; if (!team) return 0;
  const ti = TEAM_INDEX[team]; if (!ti) return 0;
  let gN = 0, gP = 0, asst = 0, yel = 0, red = 0;
  FIXTURES.forEach((fx, fi) => {
    if (fx[0] !== ti.i && fx[1] !== ti.i) return;
    const id = gmId(ti.g, fi); const s = gsS(id); if (!s) return;
    const side = fx[0] === ti.i ? 'h' : 'a';
    (s.scorers || []).forEach(sc => { if (sc.team !== side) return; if (pNameMatch(sc.name, playerName)) { if (sc.pk) gP++; else gN++; } if (sc.assist && pNameMatch(sc.assist, playerName)) asst++; });
    (s.assists || []).forEach(as => { if (as.team !== side) return; if (pNameMatch(as.name, playerName)) asst++; });
    (s.cards || []).forEach(cd => { if (cd.team !== side) return; if (pNameMatch(cd.name, playerName)) { if (cd.type === 'red') red++; else yel++; } });
  });
  return gN * PPTS.pGoal + gP * PPTS.pPen + asst * PPTS.assist + yel * PPTS.yellow + red * PPTS.red;
}
// Puntos de un partido especial (pronóstico exacto / acierto de resultado).
function specialPts(id, pred) {
  const s = gsS(id); if (!s) return 0;
  const h = +s.h, a = +s.a, ph = pred[0], pa = pred[1];
  if (h === ph && a === pa) return PPTS.exact;
  const ao = h > a ? 'h' : h < a ? 'a' : 'e', po = ph > pa ? 'h' : ph < pa ? 'a' : 'e';
  return ao === po ? PPTS.outcome : 0;
}

// Cachés de puntos fijos por selección/jugador (no cambian entre simulaciones).
const teamGroupCache = {}; Object.keys(TEAM_INDEX).forEach(n => teamGroupCache[n] = teamGroupPts(n));

// Prepara cada participante: base fija + lista de sus selecciones (índice de equipo).
const PART = PARTICIPANTS.map(p => {
  const ans = p.ans || {};
  const picks = [];             // nombres de selección elegidas (con repetición por hueco)
  PORRA_FORM.cats.forEach(c => {
    const arr = (ans.teams && ans.teams[c.cat]) || [];
    arr.forEach(l => picks.push(canonTeam(l)));
  });
  let base = 0;
  picks.forEach(name => { base += (teamGroupCache[name] || 0); });
  PORRA_FORM.playerCats.forEach(pc => { const nm = ans.players && ans.players[pc.cat]; if (nm) base += playerPts(nm); });
  PORRA_FORM.matches.forEach(m => { const pr = ans.scores && ans.scores[m.id]; if (pr) base += specialPts(m.id, pr); });
  return { alias: p.alias, base, picks };
});

/* ---- Una simulación completa del cuadro → puntos KO por selección ---- */
function simulateOnce() {
  const state = {};
  // Copiamos lo ya jugado
  for (const id in SEALED_KO) state[id] = SEALED_KO[id];
  // Rellenamos el resto en orden numérico (cada ronda usa ganadores de la previa)
  for (const id of KO_IDS) {
    if (state[id]) continue;
    const hn = resolveEnd(state, KO[id].h), an = resolveEnd(state, KO[id].a);
    if (!hn || !an) continue;
    state[id] = simKO(hn, an);
  }
  // Puntos KO por selección (resultado + avance + goles)
  const koPts = {};
  for (const id of KO_IDS) {
    const s = state[id]; if (!s) continue;
    const hn = resolveEnd(state, KO[id].h), an = resolveEnd(state, KO[id].a);
    if (!hn || !an) continue;
    const h = +s.h, a = +s.a, reg = h !== a;
    const winSide = reg ? (h > a ? 'h' : 'a') : (s.pen === 'h' || s.pen === 'a' ? s.pen : null);
    const round = KO[id].r, advB = PPTS.adv[round] || 0;
    // local
    let p = h * PPTS.goal;
    if (reg) { if (winSide === 'h') p += PPTS.win; } else p += PPTS.draw;
    if (winSide === 'h') p += advB;
    koPts[hn] = (koPts[hn] || 0) + p;
    // visitante
    let q = a * PPTS.goal;
    if (reg) { if (winSide === 'a') q += PPTS.win; } else q += PPTS.draw;
    if (winSide === 'a') q += advB;
    koPts[an] = (koPts[an] || 0) + q;
  }
  // Campeón (ganador de la final M104), para calibrar con las cuotas del mercado.
  let champ = null;
  const rf = koResult(state, 'M104');
  if (rf) champ = resolveEnd(state, rf === 'h' ? KO.M104.h : KO.M104.a);
  return { koPts, champ };
}

/* ---- Calibración con cuotas actuales de casas de apuestas (opcional) ----
 * Si existe odds.json con las cuotas de "ganador del Mundial" (decimales) de los
 * equipos aún vivos, ajustamos la fuerza de cada selección para que la prob. de
 * campeón del modelo se acerque a la que implica el mercado HOY. Así las cuotas
 * actualizadas (no solo las de antes del torneo) influyen en las probabilidades.
 * Si no hay odds.json, no se toca nada: se usa RATING + forma. */
let ODDS_USED = false, ODDS_INFO = null;
function loadOdds() { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'odds.json'), 'utf8')); } catch (e) { return null; } }
function calibrateToMarket() {
  const odds = loadOdds();
  const outright = odds && odds.outright;
  if (!outright || typeof outright !== 'object') return;
  // Equipos ya eliminados (perdedores de un cruce KO sellado): no se calibran.
  const eliminated = new Set();
  for (const id in SEALED_KO) {
    const r = koResult(SEALED_KO, id); if (!r) continue;
    const loser = resolveEnd(SEALED_KO, r === 'h' ? KO[id].a : KO[id].h);
    if (loser) eliminated.add(loser);
  }
  // Prob. implícita del mercado = 1/cuota, normalizada (se quita el margen) sobre
  // los equipos listados que sigan vivos y existan en el torneo.
  const raw = {}; let sum = 0;
  for (const team in outright) {
    const c = +outright[team];
    if (!TEAM_INDEX[team] || eliminated.has(team) || !(c > 1)) continue;
    raw[team] = 1 / c; sum += raw[team];
  }
  const teams = Object.keys(raw);
  if (teams.length < 3 || sum <= 0) return;   // pocas cuotas fiables → no calibrar
  const q = {}; teams.forEach(t => q[t] = raw[t] / sum);
  // Iteramos: simular rápido → medir prob. campeón del modelo → empujar la fuerza.
  const NF = 12000, ITERS = 3, C = 80, CLAMP = 30, eps = 1 / NF;
  for (let it = 0; it < ITERS; it++) {
    const champ = {};
    for (let s = 0; s < NF; s++) { const c = simulateOnce().champ; if (c) champ[c] = (champ[c] || 0) + 1; }
    teams.forEach(t => {
      const p = (champ[t] || 0) / NF;
      let d = C * Math.log(Math.max(q[t], eps) / Math.max(p, eps));
      d = Math.max(-CLAMP, Math.min(CLAMP, d));
      RATING_EFF[t] = (RATING_EFF[t] != null ? RATING_EFF[t] : 1500) + d;
    });
  }
  ODDS_USED = true;
  ODDS_INFO = { source: odds.source || null, oddsUpdated: odds.updated || null, teams: teams.length };
}
calibrateToMarket();

/* ---- Montecarlo ---- */
const winCount = new Array(PART.length).fill(0);
const prizeCount = new Array(PART.length).fill(0);
const nPart = PART.length;
const penultIdx = nPart - 2;   // penúltimo puesto (cobra premio)

const order = new Array(nPart);
for (let s = 0; s < N_SIMS; s++) {
  const { koPts } = simulateOnce();
  // total por participante
  for (let i = 0; i < nPart; i++) {
    let t = PART[i].base;
    const picks = PART[i].picks;
    for (let k = 0; k < picks.length; k++) t += (koPts[picks[k]] || 0);
    PART[i]._t = t;
    order[i] = i;
  }
  // ordenar (total desc, empate por alias asc → igual que la app)
  order.sort((x, y) => PART[y]._t - PART[x]._t || PART[x].alias.localeCompare(PART[y].alias));
  winCount[order[0]]++;
  prizeCount[order[0]]++;
  prizeCount[order[1]]++;
  prizeCount[order[penultIdx]]++;
}

/* ---- Salida ---- */
const probs = {};
PART.forEach((p, i) => { probs[p.alias] = { win: +(winCount[i] / N_SIMS).toFixed(4), prize: +(prizeCount[i] / N_SIMS).toFixed(4) }; });
const out = {
  updated: OFFICIAL.updated || null,
  sims: N_SIMS,
  model: 'Elo (ranking FIFA + cuotas) + forma real del torneo' + (ODDS_USED ? ' + cuotas de mercado actualizadas' : '') + '; Montecarlo del cuadro restante. Solo resultados oficiales.',
  oddsUsed: ODDS_USED,
  oddsInfo: ODDS_INFO,
  probs
};
fs.writeFileSync(path.join(DIR, 'probabilities.json'), JSON.stringify(out, null, 1));

// Reporte por consola (top 8 por prob. de ganar)
const rankByWin = PART.map((p, i) => ({ alias: p.alias, win: winCount[i] / N_SIMS, prize: prizeCount[i] / N_SIMS })).sort((a, b) => b.win - a.win);
console.log('Simulaciones:', N_SIMS, '· KO restantes por simular:', KO_IDS.filter(id => !SEALED_KO[id]).length);
console.log('Cuotas de mercado:', ODDS_USED ? ('SÍ (' + ODDS_INFO.teams + ' equipos' + (ODDS_INFO.oddsUpdated ? ', ' + ODDS_INFO.oddsUpdated : '') + ')') : 'no (solo RATING + forma)');
console.log('Top 8 prob. de GANAR la porra:');
rankByWin.slice(0, 8).forEach((r, i) => console.log(`  ${i + 1}. ${r.alias}: ${(r.win * 100).toFixed(1)}% ganar · ${(r.prize * 100).toFixed(1)}% premio`));
