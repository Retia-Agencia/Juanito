// scripts/load-test.js
// ─── Capa 1: harness de carga sintética (offline, sin WhatsApp, sin API real) ──
//
// Simula la actividad de un grupo grande (default 300 personas) contra el pipeline
// REAL de grupos de Juanito, para responder lo que el escenario de "grupo de 300"
// intenta comprobar SIN necesitar 300 humanos reales:
//   • Throughput / latencia de ingest pasivo (saveMessage por cada mensaje).
//   • Cuántas menciones REALMENTE llegan a Claude tras dedup + autorización + rate-limit.
//   • Proyección de COSTO de API (conteo de llamadas × estimación de tokens × precio Haiku).
//   • El bug de la ventana de resumen (getRecentMessages lee solo 50 mensajes).
//
// PRECAUCIONES (no romper el bot vivo):
//   • DB AISLADA en un archivo temporal — NUNCA toca ./data/brain.sqlite ni el VPS.
//   • Claude MOCKEADO: cero llamadas a la API → cero costo, cero rate limits.
//   • Decisiones REALES: usa las funciones reales de gating (markIfNew, isGroupAuthorized,
//     checkAndIncrementGroupUsage, roleOf) para que los números reflejen el código real.
//     Lo único que no se ejecuta es chat()/sendMessage() — que es justo lo que mockeamos.
//
// Uso:
//   node scripts/load-test.js
//   SENDERS=300 MESSAGES=10000 MENTION_RATE=0.05 RATE_MSGS_PER_MIN=120 node scripts/load-test.js
//
// Variables:
//   SENDERS            participantes sintéticos (default 300)
//   MESSAGES           total de mensajes a simular (default 5000)
//   MENTION_RATE       fracción de mensajes que mencionan al bot (default 0.05)
//   RATE_MSGS_PER_MIN  ritmo simulado del grupo, para proyectar costo/tiempo (default 60)
//   OUTPUT_TOKENS      tokens de salida asumidos por respuesta de Claude (default 150)
//   GROUP_DAILY_LIMIT  tope de consultas/día por remitente no privilegiado (default 5)

import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, statSync, existsSync } from 'fs';

// ─── Entorno hermético — DEBE ir antes de importar nada que toque la DB ─────────
const TMP_DB = join(tmpdir(), `juanito-loadtest-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = TMP_DB;
process.env.TZ = process.env.TZ || 'America/Bogota';
process.env.BOT_NAME = process.env.BOT_NAME || 'Juanito';
// Valores dummy que NO coinciden con los senders sintéticos (@lid) → todos quedan 'unknown'
// (rate-limited), que es el caso realista de un grupo de desconocidos.
process.env.BOSS_PHONE = '570000000000';
process.env.BOSS_LID = '000000000000@lid';
process.env.ADMIN_LID = '';
process.env.UNLIMITED_PHONES = '';
// Nunca llamamos a la API, pero el SDK construye el cliente al importar claude/index.js.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-loadtest-NOOP';

// ─── Parámetros ────────────────────────────────────────────────────────────────
const SENDERS = Number(process.env.SENDERS || 300);
const MESSAGES = Number(process.env.MESSAGES || 5000);
const MENTION_RATE = Number(process.env.MENTION_RATE || 0.05);
const RATE_MSGS_PER_MIN = Number(process.env.RATE_MSGS_PER_MIN || 60);
const OUTPUT_TOKENS = Number(process.env.OUTPUT_TOKENS || 150);
const GROUP_DAILY_LIMIT = Number(process.env.GROUP_DAILY_LIMIT || 5);

// Precio Haiku 4.5 (claude-haiku-4-5-20251001), USD por millón de tokens.
const PRICE_IN_PER_MTOK = 1.0;
const PRICE_OUT_PER_MTOK = 5.0;

// Estimación de tokens: heurística chars/4. NO es exacta — para cifras precisas usar
// el endpoint count_tokens. Sirve para proyección de orden de magnitud y comparativas.
const estTokens = (s) => Math.ceil((s || '').length / 4);

const GROUP_ID = '999999999999999999@g.us';
const GROUP_NAME = 'Grupo de Prueba 300';

// Pool de frases para variar largo/contenido de los mensajes sintéticos.
const SNIPPETS = [
  'buenas a todos',
  'alguien sabe a qué hora es la reunión de hoy?',
  'jajaja qué buena esa',
  'paso el link más tarde',
  'estoy de acuerdo con lo que dijo el de arriba, hay que revisarlo bien antes',
  'ok perfecto, gracias',
  'no me llegó el correo todavía, alguien más?',
  'confirmo asistencia para el viernes en la tarde si no hay cambios de último momento',
  'ya quedó resuelto el tema del pago',
  '👍',
  'me avisan cualquier cosa porfa',
  'creo que deberíamos votarlo entre todos para que sea más justo y nadie quede inconforme',
];

function randomSenderIndex() {
  // Distribución sesgada: el ~20% de la gente genera el ~80% de los mensajes (realista).
  return Math.floor(SENDERS * Math.random() ** 2);
}

function randomText() {
  return SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)];
}

async function main() {
  // Importes dinámicos DESPUÉS de fijar el entorno.
  await import('../src/db/migrate.js'); // crea las tablas en la DB temporal
  const db = await import('../src/db/index.js');
  const { roleOf } = await import('../src/common/roles.js');
  const { buildSystemPrompt } = await import('../src/claude/index.js');

  // Autorizar el grupo de prueba (igual que lo haría /grupo on o el auto-join del jefe).
  db.authorizeGroup({ groupId: GROUP_ID, groupName: GROUP_NAME, authorizedBy: 'loadtest' });

  // Tamaño REAL del system prompt de grupo (rama isGroup, no usa deps).
  const groupSystemPrompt = await buildSystemPrompt({}, { isGroup: true });
  const systemTokens = estTokens(groupSystemPrompt);

  // Réplica fiel de isUnlimitedSender() de src/bot/index.js (roleOf real).
  const isUnlimitedSender = (sender) => {
    const role = roleOf(sender);
    return role === 'boss' || role === 'admin';
  };

  // Contadores
  let ingested = 0;
  let mentions = 0;
  let claudeBound = 0;
  let rateLimited = 0;
  let dupDropped = 0;
  let inputTokensTotal = 0;

  // Respuesta sintética del bot, dimensionada para que el historial crezca de forma
  // realista (chat() guarda user+assistant por cada llamada → alimenta getRecentHistory).
  const fakeReply = 'r'.repeat(OUTPUT_TOKENS * 4);

  const t0 = process.hrtime.bigint();

  for (let i = 0; i < MESSAGES; i++) {
    const senderIdx = randomSenderIndex();
    const sender = `${100000000000 + senderIdx}@lid`;
    const pushName = `User${senderIdx}`;
    const text = randomText();
    const messageId = `loadtest-${i}`;
    const isBotMentioned = Math.random() < MENTION_RATE;

    // ── Hot path 1: ingest pasivo (mirror de src/whatsapp/index.js → messages.upsert).
    // Se ejecuta para CADA mensaje del grupo, lo mencionen o no.
    db.saveMessage({
      role: 'user',
      content: `[${pushName}]: ${text}`,
      source: 'group',
      chatId: GROUP_ID,
    });
    ingested++;

    // ── Hot path 2: handleGroupMessage (gating real, en el MISMO orden que el código).
    // Paso: dedup (markIfNew se llama para todo mensaje, antes del check de mención).
    if (!db.markIfNew(messageId)) {
      dupDropped++;
      continue;
    }
    if (!isBotMentioned) continue; // no mención → no llega a Claude
    mentions++;

    if (!db.isGroupAuthorized(GROUP_ID)) continue; // autorizado en este harness

    // Rate limit por remitente (igual que el bot).
    if (!isUnlimitedSender(sender)) {
      if (!db.checkAndIncrementGroupUsage(sender, GROUP_DAILY_LIMIT)) {
        rateLimited++;
        continue;
      }
    }

    // Llega a Claude. Mockeamos chat(): replicamos su efecto REAL sobre la DB
    // (guarda el turno user, lee historial de 30, guarda el turno assistant) para
    // estimar tokens de entrada de forma fiel y ejercitar getRecentHistory en caliente.
    claudeBound++;
    db.saveMessage({ role: 'user', content: text, chatId: GROUP_ID }); // source 'bot'
    const history = db.getRecentHistory(30, GROUP_ID);
    const historyChars = history.reduce((n, m) => n + (m.content || '').length, 0);
    inputTokensTotal += systemTokens + estTokens(text) + estTokens(' '.repeat(historyChars));
    db.saveMessage({ role: 'assistant', content: fakeReply, chatId: GROUP_ID });
  }

  const t1 = process.hrtime.bigint();
  const wallMs = Number(t1 - t0) / 1e6;
  const msgsPerSec = (MESSAGES / wallMs) * 1000;

  // Tiempo de consultas en caliente (muestra única, post-carga).
  const qa = process.hrtime.bigint();
  db.getRecentHistory(30, GROUP_ID);
  const histQueryMs = Number(process.hrtime.bigint() - qa) / 1e6;
  const qb = process.hrtime.bigint();
  const summaryWindow = db.getRecentMessages
    ? null
    : null; // getRecentMessages vive en whatsapp; lo simulamos abajo con SQL equivalente
  // Equivalente exacto a whatsapp.getRecentMessages(GROUP_ID, 50): últimas 50 source='group'.
  const last50 = db
    .default
    .prepare(
      `SELECT content FROM messages WHERE chat_id = ? AND source = 'group' ORDER BY created_at DESC LIMIT 50`
    )
    .all(GROUP_ID);
  const summaryQueryMs = Number(process.hrtime.bigint() - qb) / 1e6;

  // Costo
  const outputTokensTotal = claudeBound * OUTPUT_TOKENS;
  const costIn = (inputTokensTotal / 1e6) * PRICE_IN_PER_MTOK;
  const costOut = (outputTokensTotal / 1e6) * PRICE_OUT_PER_MTOK;
  const costRun = costIn + costOut;

  // Proyección temporal: a RATE_MSGS_PER_MIN, ¿cuánto "tiempo de grupo" simulamos?
  const simMinutes = MESSAGES / RATE_MSGS_PER_MIN;
  const costPerHour = simMinutes > 0 ? costRun / (simMinutes / 60) : 0;
  const costPerDay = costPerHour * 24;

  // Tope teórico de llamadas/día por rate-limit (lo que protege el costo).
  const dailyCallCeiling = SENDERS * GROUP_DAILY_LIMIT;

  // Bug de ventana de resumen.
  const summaryMsgsPerWindow = 50;
  const groupMinutesCovered = summaryMsgsPerWindow / RATE_MSGS_PER_MIN;

  const dbBytes = existsSync(TMP_DB) ? statSync(TMP_DB).size : 0;
  const bytesPerMsg = ingested ? dbBytes / ingested : 0;

  const f = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  Juanito — Capa 1: carga sintética de grupo (offline, sin API)     ║
╚══════════════════════════════════════════════════════════════════╝

CONFIG
  Participantes (senders) ....... ${f(SENDERS, 0)}
  Mensajes simulados ............ ${f(MESSAGES, 0)}
  Tasa de mención ............... ${f(MENTION_RATE * 100)}%
  Ritmo simulado del grupo ...... ${f(RATE_MSGS_PER_MIN, 0)} msg/min  (≈ ${f(simMinutes)} min de chat)
  Límite diario por remitente ... ${f(GROUP_DAILY_LIMIT, 0)} consultas/día
  Modelo / precio ............... claude-haiku-4-5  ($${PRICE_IN_PER_MTOK}/MTok in, $${PRICE_OUT_PER_MTOK}/MTok out)

THROUGHPUT (ingest pasivo — saveMessage por CADA mensaje)
  Tiempo total .................. ${f(wallMs)} ms
  Throughput .................... ${f(msgsPerSec, 0)} msg/seg
  Mensajes guardados ............ ${f(ingested, 0)}
  Tamaño DB ..................... ${f(dbBytes / 1024, 0)} KB  (${f(bytesPerMsg, 0)} bytes/msg)
  Query getRecentHistory(30) .... ${f(histQueryMs, 3)} ms
  Query getRecentMessages(50) ... ${f(summaryQueryMs, 3)} ms

EMBUDO DE MENCIONES (gating real)
  Menciones al bot .............. ${f(mentions, 0)}  (${f((mentions / MESSAGES) * 100)}% del tráfico)
  Bloqueadas por rate-limit ..... ${f(rateLimited, 0)}
  Duplicados descartados ........ ${f(dupDropped, 0)}
  → Llamadas REALES a Claude .... ${f(claudeBound, 0)}

COSTO (proyección, tokens estimados con heurística chars/4 — ver nota)
  Tokens de entrada (total) ..... ${f(inputTokensTotal, 0)}
  Tokens de salida (total) ...... ${f(outputTokensTotal, 0)}
  Costo de esta corrida ......... $${f(costRun, 4)}
  Costo proyectado / hora ....... $${f(costPerHour, 2)}
  Costo proyectado / día ........ $${f(costPerDay, 2)}
  Tope de llamadas/día (rate-limit) ${f(dailyCallCeiling, 0)}  (${f(SENDERS, 0)} × ${f(GROUP_DAILY_LIMIT, 0)})
  Techo de costo/día (si todos topan) $${f((dailyCallCeiling * (systemTokens + OUTPUT_TOKENS) * 1) / 1e6 * PRICE_IN_PER_MTOK + (dailyCallCeiling * OUTPUT_TOKENS) / 1e6 * PRICE_OUT_PER_MTOK, 2)}  (aprox., 1 llamada/mención)

BUG DE VENTANA DE RESUMEN  (src/scheduler/summaries.js + summarize_group)
  getRecentMessages lee .......... ${summaryMsgsPerWindow} de ${f(ingested, 0)} mensajes ingeridos
  A ${f(RATE_MSGS_PER_MIN, 0)} msg/min, 50 msgs ≈ ${f(groupMinutesCovered)} min de chat
  El "resumen de las últimas 4h" en realidad cubre ~${f(groupMinutesCovered)} min en un grupo así.
  last50 efectivamente recuperados: ${last50.length}

NOTAS
  • Tokens estimados (chars/4). Para cifras exactas: endpoint count_tokens del SDK.
  • groupMetadata() se llama por-mensaje en whatsapp/index.js (no medible offline):
    candidato #1 de optimización — el nombre del grupo es constante, no hace falta pedirlo
    en cada mensaje.
  • No hay throttle de envío en sendMessage(): riesgo de softban con muchas menciones
    casi simultáneas. Esta corrida no lo mide (es lo que mockeamos) pero lo confirma el código.
`);

  // ── Limpieza: borrar la DB temporal (+ WAL/SHM). NUNCA tocó la DB real. ─────────
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TMP_DB + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
  console.log(`DB temporal eliminada: ${TMP_DB}\n`);
}

main().catch((err) => {
  console.error('[load-test] Error:', err);
  // Intento de limpieza aún en error.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TMP_DB + suffix;
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {}
  }
  process.exit(1);
});
