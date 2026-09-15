// scripts/refire-digest.js
// Re-dispara un digest (Push 1 / Push 1 temprano / Push 2) que el cron no alcanzó a mandar,
// SIN reiniciar el contenedor del bot.
//
// Por qué existe: el 2026-09-14 Juanito se desvinculó de WhatsApp a las 18:51 y el digest
// Push 1 de las 7pm cayó 9 minutos después. Para redispararlo la única vía era tocar
// CALENDLY_PUSH1_CRON en el .env y reiniciar — y reiniciar es el riesgo documentado del 405
// (ver docs/WHATSAPP-PAIRING.md y el softban de junio). Este script evita el reinicio.
//
// ─── Cómo funciona ────────────────────────────────────────────────────────────
// NO reimplementa el digest. Usa el `runPush1()` / `runPush2()` REALES y solo cambia el
// sumidero de entrega, aprovechando que `__setDeps()` está exportado y que `d.sendMessage`
// es el ÚNICO punto de envío de todo el track de Calendly (ver deliverToCloser).
//
// Eso importa: el mensaje pasa por los MISMOS gates que en la corrida normal —pausa global,
// pausa por closer, opt-in ganado, entrega solo a `contact_jid` (nunca en frío), dry-run por
// conexión y copia a aparatos secundarios—. Lo único distinto es a dónde va el texto final.
//
// En vez del socket (que este proceso no tiene: el socket vive en el proceso del bot, y
// abrir un segundo cliente de Baileys DRENA la cola de mensajes offline — ver
// docs/WHATSAPP-PAIRING.md), escribe en la tabla `reminders` usada como OUTBOX. El cron de
// recordatorios del bot corre cada minuto, siempre está encendido, y despacha a `to_phone`
// por la cola anti-ban. Es el mismo canal que ya usa dashboard/server/watchdog.js.
//
// ⚠️ `src/scheduler/reminders.js` prefija el texto con "⏰ Recordatorio: ". El digest llega
//    íntegro pero con ese encabezado. Es el precio de no reiniciar.
//
// ⚠️ Requiere que el BOT ESTÉ ARRIBA. Esto encola; quien entrega es el cron del bot. Si el
//    bot está caído (sesión muerta), no hay nada que hacer por WhatsApp — eso lo cubre la
//    alerta fuera de banda del watchdog del dashboard.
//
// ─── Uso ──────────────────────────────────────────────────────────────────────
// Corre DENTRO del contenedor del agente (es el que tiene los tokens de Calendly/HubSpot):
//
//   docker exec -w /app juanito-agent node scripts/refire-digest.js --push 1
//   docker exec -w /app juanito-agent node scripts/refire-digest.js --push 1 --send
//
//   --push 1        el digest de las 7pm (excluye los programas del turno temprano)
//   --push 1-early  la mitad temprana (IGTK, 5:30pm)
//   --push 2        el digest de la mañana (llamadas de HOY)
//   --send          MANDA de verdad. Sin este flag es dry-run y no escribe nada.
//
// Es DRY-RUN POR DEFECTO a propósito: el modo que manda mensajes a closers reales se pide
// explícito.

import { saveReminder } from '../src/db/index.js';
import * as calendlySched from '../src/scheduler/calendly.js';
import { activeAccounts } from '../src/calendly/accounts.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const SEND = has('--send');
const which = valueOf('--push') || '1';

const TZ = () => process.env.TZ || 'America/Bogota';
// `due_at` en la tabla `reminders` es hora LOCAL (ver localNow() en src/db/index.js).
// Usar UTC acá dejaría la fila en el futuro y el digest saldría con horas de retraso.
const localNow = () => new Date().toLocaleString('sv', { timeZone: TZ() });

// Lo que se encoló/se habría encolado, para el resumen final.
const encolados = [];

async function sinkSendMessage(to, text) {
  encolados.push({ to, text });
  if (!SEND) {
    console.log(`\n──────── [DRY-RUN] destino ${to} ────────\n${text}\n`);
    return;
  }
  saveReminder({ text, dueAt: localNow(), toPhone: to, createdBy: 'refire-digest' });
  console.log(`[refire] encolado → ${to} (${text.length} chars)`);
}

async function main() {
  const [calendly, db, hubspot] = await Promise.all([
    import('../src/calendly/index.js'),
    import('../src/db/index.js'),
    import('../src/hubspot/client.js'),
  ]);

  // Espejo del objeto que arma deps() en src/scheduler/calendly.js. Se mantiene el contrato
  // completo (no solo lo que runDigest usa hoy) para que un cambio en el digest que empiece a
  // pedir otra dependencia no falle acá con un TypeError críptico.
  //
  // La ÚNICA diferencia real es `sendMessage`. `sendDocument` se deja explícitamente sin
  // implementar: hoy el digest no lo usa (el brochure del Push 1 va como link dentro del
  // texto), y si algún día lo usara, queremos que reviente acá y no que mande medio push.
  const deps = {
    accounts: activeAccounts,
    listProgramEvents: calendly.listProgramEvents,
    getEvent: calendly.getEvent,
    getFirstInvitee: calendly.getFirstInvitee,
    hubspotEnabled: hubspot.isEnabled,
    getContactPhone: hubspot.getContactPhone,
    findPhoneByName: hubspot.findPhoneByName,
    matchCallToDeal: hubspot.matchCallToDeal,
    searchMeetingsInWindow: hubspot.searchMeetingsInWindow,
    getOwnerEmailMap: hubspot.getOwnerEmailMap,
    getMeetingContact: hubspot.getMeetingContact,
    getScheduledCallsInWindow: db.getScheduledCallsInWindow,
    getCallsWithAnyPushInWindow: db.getCallsWithAnyPushInWindow,
    supersedeHubspotPushes: db.supersedeHubspotPushes,
    searchMeetingsCreatedSince: hubspot.searchMeetingsCreatedSince,
    getContactsOfMeetings: hubspot.getContactsOfMeetings,
    getMeetingsOfContacts: hubspot.getMeetingsOfContacts,
    getMeetingsByIds: hubspot.getMeetingsByIds,
    supersedeRescheduledPushes: db.supersedeRescheduledPushes,
    getPushesByEventUuid: db.getPushesByEventUuid,
    supersedeRescheduledCalendly: db.supersedeRescheduledCalendly,
    scheduleCalendlyPush: db.scheduleCalendlyPush,
    getDueCalendlyPushes: db.getDueCalendlyPushes,
    claimCalendlyPush: db.claimCalendlyPush,
    revertCalendlyPush: db.revertCalendlyPush,
    reclaimStuckCalendlyPushes: db.reclaimStuckCalendlyPushes,
    markCalendlyPushSent: db.markCalendlyPushSent,
    markCalendlyPushSkipped: db.markCalendlyPushSkipped,
    getSkipsAlertablesPorCloser: db.getSkipsAlertablesPorCloser,
    shouldAlertPersistent: db.shouldAlertPersistent,
    createPendingOutcome: db.createPendingOutcome,
    marcarPush4Preguntado: db.marcarPush4Preguntado,
    recordAutoOutcome: db.recordAutoOutcome,
    getDueOutcomeReminders: db.getDueOutcomeReminders,
    markOutcomeReminded: db.markOutcomeReminded,
    expireUnansweredOutcomes: db.expireUnansweredOutcomes,
    getStaleHarvestCandidates: db.getStaleHarvestCandidates,
    applyHarvestedOutcome: db.applyHarvestedOutcome,
    recordRescheduleAwaitingDate: db.recordRescheduleAwaitingDate,
    getPendingManualPushes: db.getPendingManualPushes,
    supersedeManualPushes: db.supersedeManualPushes,
    getAwaitingDateOutcomes: db.getAwaitingDateOutcomes,
    markReschedulePrompted: db.markReschedulePrompted,
    expireAwaitingDateOutcomes: db.expireAwaitingDateOutcomes,
    isOptedIn: db.isVerifiedOptedIn,
    getOptin: db.getOptin,
    isCalendlyPaused: db.isCalendlyPaused,
    isCloserPaused: db.isCloserPaused,
    getMirrorConnections: db.getMirrorConnections,
    hasDmThread: db.hasDmThread,
    sendMessage: sinkSendMessage,
    now: () => Date.now(),
  };

  calendlySched.__setDeps(deps);

  const runners = {
    '1': ['Push 1 (7pm — agenda de mañana)', calendlySched.runPush1],
    '1-early': ['Push 1 temprano (5:30pm — IGTK)', calendlySched.runPush1Early],
    '2': ['Push 2 (mañana — llamadas de hoy)', calendlySched.runPush2],
  };
  const elegido = runners[which];
  if (!elegido) {
    console.error(`--push inválido: "${which}". Usá 1, 1-early o 2.`);
    process.exit(1);
  }
  const [label, run] = elegido;

  console.log(`[refire] ${label} · modo ${SEND ? 'ENVÍO REAL' : 'DRY-RUN'} · ${localNow()} ${TZ()}`);
  if (!SEND) console.log('[refire] nada se escribe en la DB. Agregá --send para mandar.\n');

  const closers = await run();

  console.log(
    `\n[refire] ${label}: ${closers} closer(s), ${encolados.length} mensaje(s) ` +
      `${SEND ? 'encolados en `reminders`' : 'que se habrían mandado'}.`
  );
  if (SEND && encolados.length) {
    console.log('[refire] el cron de recordatorios del bot los despacha en ≤1 min por la cola anti-ban.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[refire] falló:', err);
  process.exit(1);
});
