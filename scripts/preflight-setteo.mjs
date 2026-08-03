// scripts/preflight-setteo.mjs
// Pre-flight de §18.AV. READ-ONLY: no toca la DB, no manda nada, no conecta a WhatsApp.
//
// Responde la pregunta que BLOQUEA el rollout: con el entorno REAL de producción
// (BOSS_LID / ADMIN_LID / CALENDLY_PUSH4_CLOSERS), ¿`roleOf` ve a cada closer como 'closer'?
// Si un closer sale 'boss', el fallback retrocompat se lo está tragando y NO hay que prender
// nada: vería las tools del jefe.
//
// Uso en el VPS, con el src nuevo montado sobre la imagen actual:
//   docker run --rm --env-file /root/juanito/.env \
//     -v /root/juanito/src:/app/src:ro -v /root/juanito/scripts:/app/scripts:ro \
//     juanito-agent node scripts/preflight-setteo.mjs

import { roleOf, closerOf, isCloser } from '../src/common/roles.js';
import { CLOSERS, CLOSER_LIDS } from '../src/calendly/closers.js';
import { isCloserInScope } from '../src/setteo/format.js';
import { calcularCuota, JORNADA_INICIO, JORNADA_FIN, CUOTA_POR_HORA } from '../src/setteo/cuota.js';
import { parseSetteoReply } from '../src/setteo/parse.js';

const ok = (b) => (b ? '✅' : '❌');
let fallos = 0;

console.log('═══ PRE-FLIGHT §18.AV — setteo del closer ═══\n');

// ── 1. Entorno ───────────────────────────────────────────────────────────────
console.log('── Entorno ──');
console.log(`  BOSS_LID configurado: ${ok(Boolean(process.env.BOSS_LID))} ${process.env.BOSS_LID ? '' : '← SIN esto, el fallback retrocompat hace boss a cualquier @lid'}`);
console.log(`  ADMIN_LID configurado: ${ok(Boolean(process.env.ADMIN_LID))}`);
console.log(`  TZ: ${process.env.TZ || '(sin definir)'}`);
console.log(`  SETTEO_CAPTURE_ENABLED: ${process.env.SETTEO_CAPTURE_ENABLED || '(sin definir → false)'}`);
if (!process.env.BOSS_LID) fallos++;

const scopeRaw =
  process.env.SETTEO_CAPTURE_CLOSERS || process.env.SETTEO_REPORT_CLOSERS || process.env.CALENDLY_PUSH4_CLOSERS || '';
console.log(`  Scope efectivo del piloto: ${scopeRaw || '(VACÍO → no se captura a nadie)'}\n`);

// ── 2. roleOf por closer ─────────────────────────────────────────────────────
// Es LO que bloquea: si sale 'boss', el orden de las ramas en roles.js está mal en este
// entorno y el closer vería las tools del jefe.
console.log('── roleOf por identidad del roster ──');
const lidPorEmail = {};
for (const [lid, email] of Object.entries(CLOSER_LIDS)) lidPorEmail[email] = lid;

for (const [email, c] of Object.entries(CLOSERS)) {
  const jidTel = `${String(c.phone).replace(/\D/g, '')}@s.whatsapp.net`;
  const rolTel = roleOf(jidTel);
  const enScope = isCloserInScope(email);
  let linea = `  ${enScope ? '▶' : ' '} ${c.name.padEnd(22)} ${email.padEnd(30)} tel→${rolTel}`;

  const lid = lidPorEmail[email];
  if (lid) {
    const rolLid = roleOf(`${lid}@lid`);
    linea += ` lid→${rolLid}`;
    if (rolLid !== 'closer') { linea += '  ⚠️'; if (enScope) fallos++; }
  }
  if (rolTel !== 'closer') { linea += '  ⚠️ NO resuelve como closer'; if (enScope) fallos++; }
  console.log(linea);
}
console.log('  (▶ = dentro del scope del piloto)\n');

// ── 3. Identidad y aislamiento ───────────────────────────────────────────────
console.log('── Identidad ──');
const enScope = Object.entries(CLOSERS).filter(([e]) => isCloserInScope(e));
for (const [email, c] of enScope.slice(0, 3)) {
  const jid = `${String(c.phone).replace(/\D/g, '')}@s.whatsapp.net`;
  const r = closerOf(jid);
  console.log(`  ${ok(r?.email === email)} closerOf(${c.name}) → ${r?.email || 'null'}`);
  if (r?.email !== email) fallos++;
}
const desconocido = '999999999999999@lid';
console.log(`  ${ok(!isCloser(desconocido))} un LID desconocido NO es closer (rol: ${roleOf(desconocido)})`);
if (isCloser(desconocido)) fallos++;
console.log('');

// ── 4. Cuota y parser ────────────────────────────────────────────────────────
console.log('── Cuota ──');
console.log(`  Jornada ${JORNADA_INICIO()}:00–${JORNADA_FIN()}:00 · ${CUOTA_POR_HORA()} leads por hora libre`);
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Bogota' });
const c0 = calcularCuota({ calls: [], fecha: hoy });
console.log(`  ${ok(c0.cuota > 0)} sin calls: ${c0.horasLibres}h libres → cuota ${c0.cuota}`);
if (c0.cuota <= 0) fallos++;
console.log('');

console.log('── Parser (muestras reales) ──');
for (const t of ['toqué a Juan Pérez, no contestó', 'hablé con María Gómez y agendó', 'hola qué más']) {
  const r = parseSetteoReply(t);
  const desc = r.kind === 'setteos' ? r.items.map((i) => `${i.leadName}(c${i.contesto}a${i.agendo}v${i.vendio})`).join(', ') : r.kind;
  console.log(`  "${t}" → ${desc}`);
}

console.log(`\n═══ ${fallos === 0 ? '✅ PRE-FLIGHT OK — se puede prender el piloto' : `❌ ${fallos} PROBLEMA(S) — NO prender`} ═══`);
process.exit(fallos === 0 ? 0 : 1);
