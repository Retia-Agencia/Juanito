// src/scheduler/calendly.js
// Recordatorios precall a closers desde Calendly.
//
//  Push 0 (inmediato)     → aviso de "nueva call HOY": cuando el poll descubre una
//                           reserva nueva para una call de hoy y los digests ya
//                           pasaron (§18.C). Se agenda como push_n=0 con due=ahora.
//  Push 1 (7:00pm cron)   → digest de las llamadas de MAÑANA, por closer.
//  Push 2 (6:30am cron)   → digest de las llamadas de HOY, por closer.
//  Push 3 (25min antes)   → uno por llamada. Se agenda en `calendly_pushes` al
//                           descubrir la cita (poll) y lo entrega un cron al minuto.
//
//  El closer = host del evento (event_memberships[0].user_email) → mapeo en
//  calendly/closers.js. "Equipo EstadoX" se enruta a Mateo.
//
//  Modo DRY-RUN (CALENDLY_DRY_RUN != 'false', default true): NO envía WhatsApp,
//  solo registra en log lo que mandaría. El polling sí persiste en la DB para
//  poder validar la agenda; la entrega en dry-run loguea y marca 'sent'.
//
//  Seam de dependencias (__setDeps): las funciones IMPURAS (API de Calendly, DB,
//  WhatsApp) se resuelven de forma perezosa y son inyectables en tests, igual que
//  en src/claude/index.js. Los helpers PUROS (plantillas, push-logic) se importan
//  directo porque no tocan red/DB.

import { CronJob } from 'cron';
import { createHash } from 'node:crypto';
import {
  firstNameFrom,
  fullNameFrom,
  closerEmailOf,
  prospectPhoneOf,
  buildPush3Message,
  buildDigestMessage,
  programKeyOf,
  programLabelOf,
  eventJoinUrl,
  dayRangeUtc,
  toSqliteUtc,
  formatCallTime,
  buildPush0Message,
  isSameDayInTz,
  isNextDayInTz,
  push2HasRunToday,
  dailyCronHasRunToday,
  push4DueUtc,
  buildPush4Message,
  buildOutcomeReminder,
  buildReschedulePromptMessage,
} from '../calendly/index.js';
import { computePush3Schedule, decidePush0 } from '../calendly/push-logic.js';
import { push5DueUtc, buildPush5Message } from '../calendly/sheet-push.js';
import { pickSupersededPushes, isManualUuid, planRescheduledPushes } from '../calendly/reschedule-logic.js';
import { isCoveredProgram, decideFromAgenda } from '../hubspot/deals.js';
import { decideNudgeAction, buildDealNudgeMessage, buildCreateDealNudgeMessage, buildTwinReviewMessage, dealUrl } from '../hubspot/nudge.js';
import { meetingsToCalls, hubspotMeetingIdOf } from '../hubspot/meetings.js';
import { pickMeetingsToSchedule, callStartToIso, programLivesInThisHubspot } from '../hubspot/agenda-poll.js';
import { pickRescheduledAway } from '../hubspot/reschedule-detect.js';
import { resolveCloser, isIgnoredCloser, accountOfCloser, extraJidsForCloser, HUBSPOT_OWNER_TO_CLOSER } from '../calendly/closers.js';
import { CLOSERS } from '../calendly/closers.js';
import { tallyByCloser, buildAgendaMessage } from '../calendly/agenda-admin.js';
import { accountOf, activeAccounts, DEFAULT_ACCOUNT } from '../calendly/accounts.js';
import { mirrorConnections } from '../calendly/mirror.js';
import { SKIP_SLUGS, SKIP_ALERTABLES, ETIQUETA_SKIP } from '../calendly/skip-reasons.js';
import {
  recordPollOk,
  recordPollError,
  recordUnmapped,
  shouldAlert,
} from '../calendly/health.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const DRY_RUN = () => process.env.CALENDLY_DRY_RUN !== 'false'; // default true
const REQUIRE_OPTIN = () => process.env.CALENDLY_REQUIRE_OPTIN !== 'false'; // default true
const LEAD_MIN = () => Number(process.env.CALENDLY_PUSH3_LEAD_MIN || 25);

// Push 0 (§18.C): aviso de "nueva call HOY". Activo por default (gateado igual que
// todo por opt-in/contact_jid/pausa/DRY_RUN). `RECENT_MIN` = qué tan reciente debe
// ser el booking para contar como nuevo (≥ el intervalo del poll, con margen).
const PUSH0_ENABLED = () => process.env.CALENDLY_PUSH0_ENABLED !== 'false'; // default true
const PUSH0_RECENT_MIN = () => Number(process.env.CALENDLY_PUSH0_RECENT_MIN || 10);

// Push 4 (§18.AB): registro de outcome post-call. Se entrega DESPUÉS de la call
// (start + duración + gracia). Insistencia v1: un recordatorio si no responde.
const PUSH4_ENABLED = () => process.env.CALENDLY_PUSH4_ENABLED !== 'false'; // default true
// Allowlist de closers para el Push 4 (rollout acotado). Vacío = TODOS. Útil para
// probar el registro de outcomes con un solo closer antes de abrirlo al equipo.
// Emails separados por coma (ej: CALENDLY_PUSH4_CLOSERS=pablo.lozano@30x.com).
const PUSH4_CLOSERS = () =>
  (process.env.CALENDLY_PUSH4_CLOSERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
function push4AllowedFor(email) {
  const allow = PUSH4_CLOSERS();
  if (!allow.length) return true; // sin allowlist → aplica a todos
  return allow.includes(String(email || '').toLowerCase().trim());
}
const CALL_DURATION_MIN = () => Number(process.env.CALENDLY_CALL_DURATION_MIN || 30);
const PUSH4_GRACE_MIN = () => Number(process.env.CALENDLY_PUSH4_GRACE_MIN || 5);

// Push 5 (§18.AP): recordatorio de llenar los Google Sheets, N minutos después de que la call
// TERMINA. Quién lo recibe NO se decide acá: lo decide la conexión, declarando `sheets` en
// accounts.js (hoy retia y comunicarte). Este flag es el interruptor global de emergencia, para
// apagarlo sin redeploy y sin cortarle a un closer el resto de sus pushes (que es lo que hace
// `/calendly off <closer> <cuenta>`).
// ─── Espejo de dev (§18.BM) ───────────────────────────────────────────────────
// Copia hacia un JID de DEV de todo lo que `deliver()` resuelve para los closers de las
// conexiones listadas — se haya enviado o no. Existe para acompañar el arranque de una conexión
// nueva: el modo de falla caro de este sistema no es el push mal escrito, es el push que NO SALE
// (falta el opt-in, la cuenta está en dry-run, el closer está pausado), y eso es justo lo que el
// closer no puede reportar porque no lo ve. EstadoX estuvo un mes así y Salazar una semana.
//
// Por eso el espejo NO se corta con el dry-run ni con los skips: lleva el RESULTADO en el
// encabezado. La única excepción es la pausa GLOBAL — el botón de pánico significa silencio
// total, espejo incluido.
//
// Apagado por default: sin CALENDLY_DEV_MIRROR_JID no existe. Es deliberadamente un env y no un
// `extraJids` del roster, porque un extraJid es "el segundo aparato de ESE closer": entra a
// CLOSER_LIDS, así que el dev quedaría RECONOCIDO como ese closer al escribirle a Juanito, y el
// roster prohíbe repetir un mismo JID en varias identidades (un JID = una identidad). Un espejo
// es lo contrario: un destino, muchos closers, y cero identidad.
const DEV_MIRROR_JID = () => (process.env.CALENDLY_DEV_MIRROR_JID || '').trim();
// Conexiones espejadas (CSV de keys de accounts.js). VACÍO = ninguna: un espejo sin alcance
// declarado no copia nada, en vez de copiarlo TODO. Poner el JID sin querer no puede terminar
// en el dev recibiendo los pushes de las cuatro conexiones.
//
// `override` es lo que dejó `/espejo` en la DB (§18.BV): manda sobre el `.env` cuando existe,
// para poder mover el espejo de agencia sin redeploy. `null`/`undefined` = nadie usó el comando
// → el `.env`, como siempre. String vacío = apagado POR COMANDO, y por eso el `??` no puede ser
// un `||`: '' es una respuesta, no una ausencia.
const DEV_MIRROR_CONNECTIONS = (override) =>
  mirrorConnections(override, process.env.CALENDLY_DEV_MIRROR_CONNECTIONS);
// Cada cuánto se puede REPETIR el mismo aviso (mismo mensaje + mismo resultado). No es la
// frecuencia del espejo: un resultado NUEVO sale siempre, sin esperar esto. 6h = el default de
// health.js, o sea "avisá de nuevo si mañana sigue roto", no "avisá cada minuto".
const DEV_MIRROR_TTL_MS = () => Number(process.env.CALENDLY_DEV_MIRROR_TTL_MIN || 360) * 60000;

const SHEET_PUSH_ENABLED = () => process.env.CALENDLY_SHEET_PUSH !== 'false'; // default true
const SHEET_PUSH_DELAY_MIN = () => Number(process.env.CALENDLY_SHEET_DELAY_MIN || 10);

// Modelo nudge (§18.AF): para programas con pipeline en HubSpot, en vez de preguntarle
// el outcome al closer, Juanito revisa el deal y solo lo pica si sigue en "Agendado"
// (no preguntar lo que HubSpot ya sabe). Apagado por default → rollout controlado; sin
// el flag, TODO sigue en Push 4 clásico. Requiere HUBSPOT_PAT configurado.
const NUDGE_ENABLED = () => process.env.HUBSPOT_NUDGE_ENABLED === 'true';
// Cosecha por estado de agenda (§18.AG): la evolución del nudge. En vez de leer la ETAPA
// del deal (proxy tosco), lee `agenda_status` (COMPLETED/NO_SHOW/RESCHEDULED/CANCELED/
// SCHEDULED) y DERIVA el outcome directo a call_outcomes sin preguntar; solo pica al closer
// si la call venció y sigue "Programada". Apagado por default; sin el flag, sigue el nudge
// por etapa (o el Push 4 clásico). Requiere HUBSPOT_PAT + programa cubierto.
const HARVEST_ENABLED = () => process.env.HUBSPOT_AGENDA_HARVEST === 'true';
// Barrido periódico de cosecha (§18.AH): el harvest de arriba es una sola foto en el
// momento del Push 4; si el closer actualiza el deal DESPUÉS, nadie vuelve a mirar y la
// fila cierra sola como 'no_answer'. Este barrido re-consulta HubSpot para esas filas
// abandonadas, cada N horas, solo mientras HARVEST_ENABLED. Apagable aparte por si acaso,
// sin tocar el harvest en vivo.
const HARVEST_SWEEP_ENABLED = () => process.env.HUBSPOT_HARVEST_SWEEP_ENABLED !== 'false'; // default true
// Poll de las citas que solo viven en HubSpot (§18.AN): les crea los mismos Push 0/3/4 que a
// una cita de Calendly. Apagado por default porque manda mensajes REALES a closers — se estrena
// con `runHubspotAgendaPoll({ preview:true })`, que solo dice qué haría.
const HUBSPOT_POLL_ENABLED = () => process.env.HUBSPOT_AGENDA_POLL === 'true';
// Detección de la reagenda hecha DENTRO del CRM (§18.AO). Va colgada del poll de HubSpot (sin
// él no hay nada que mirar) pero con interruptor propio, porque su efecto es el opuesto: CANCELA
// pushes en vez de crearlos, y un falso positivo deja a un closer sin aviso de una call real.
const HUBSPOT_RESCHEDULE_SCAN = () => process.env.HUBSPOT_RESCHEDULE_SCAN !== 'false'; // default true
// Cuánto hacia atrás se miran las citas recién creadas. El poll corre cada 5 min; 2h da margen
// de sobra para un reinicio o un rato de HubSpot caído sin perderse una reagenda, y el barrido
// es idempotente (re-cancelar una fila ya 'skipped' no cambia nada).
const RESCHEDULE_SCAN_LOOKBACK_MIN = () => Number(process.env.HUBSPOT_RESCHEDULE_LOOKBACK_MIN || 120);
const HARVEST_SWEEP_CRON = () => process.env.HUBSPOT_HARVEST_SWEEP_CRON || '0 8-22/2 * * *'; // cada 2h, 8am-10pm
const HARVEST_SWEEP_MAX_AGE_HOURS = () => Number(process.env.HUBSPOT_HARVEST_SWEEP_MAX_AGE_HOURS || 72);
// Params de la reagenda (para agendar la call nueva desde hs_next_meeting_start_time).
// Espejo de los defaults de calendly/reschedule.js.
const RESCHED_LEAD_MIN = () => Number(process.env.CALENDLY_PUSH3_LEAD_MIN || 25);
const RESCHED_MAX_CHAIN = () => Number(process.env.CALENDLY_RESCHEDULE_MAX_CHAIN || 3);
const OUTCOME_REMIND_AFTER_MIN = () => Number(process.env.CALENDLY_OUTCOME_REMIND_MIN || 30);
const OUTCOME_EXPIRE_AFTER_MIN = () => Number(process.env.CALENDLY_OUTCOME_EXPIRE_MIN || 30);
const OUTCOME_CRON = () => process.env.CALENDLY_OUTCOME_CRON || '*/10 * * * *';

// Reagendas (§18.AC): cuando el closer marca "Reagendó", Juanito le pide la fecha y agenda
// la call nueva por su cuenta (uuid sintético 'manual:…'), venga o no de Calendly. Apagado
// por default → rollout acotado con la misma allowlist del Push 4.
const RESCHEDULE_ENABLED = () => process.env.CALENDLY_RESCHEDULE_ENABLED === 'true';
// Insistencia diaria a las reagendas que quedaron sin fecha (9am Bogotá).
const RESCHEDULE_PROMPT_CRON = () => process.env.CALENDLY_RESCHEDULE_PROMPT_CRON || '0 9 * * *';
const RESCHEDULE_MAX_ASKED = () => Number(process.env.CALENDLY_RESCHEDULE_MAX_ASKED || 3);

const POLL_CRON = () => process.env.CALENDLY_POLL_CRON || '*/5 * * * *';
const DELIVER_CRON = () => process.env.CALENDLY_DELIVER_CRON || '* * * * *';
const PUSH1_CRON = () => process.env.CALENDLY_PUSH1_CRON || '0 19 * * *'; // 7:00pm
const PUSH2_CRON = () => process.env.CALENDLY_PUSH2_CRON || '30 6 * * *'; // 6:30am

// Agenda diaria a la ADMIN de EstadoX (7am). No es un push a closers: es el conteo de cuántas
// llamadas tiene HOY cada closer de IA para Abogados, por DM a quien supervisa. Se autodesactiva
// sin destinatarios, como todos los jobs del scheduler.
const ADMIN_AGENDA_CRON = () => process.env.ADMIN_AGENDA_CRON || '0 7 * * *';
// JIDs (CSV). Mismo requisito que SHEETS_REPORT_DM: tiene que ser el JID desde el que la persona
// LE ESCRIBIÓ a Juanito, o no hay hilo y no se entrega.
const ADMIN_AGENDA_DM = () =>
  (process.env.ADMIN_AGENDA_DM || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
// Conexión cuyos programas se cuentan. Es una var y no un hardcode para que la misma agenda
// sirva a otra marca sin tocar código.
const ADMIN_AGENDA_CONNECTION = () => (process.env.ADMIN_AGENDA_CONNECTION || 'estadox').trim();

// Auditoría de skips: cada hora revisa qué pushes se perdieron de verdad y avisa al admin.
// Existe porque el modo de fallo caro no es el ruidoso sino el MUDO — el caso Daniela se
// descubrió porque un humano lo reportó dos días después, no porque el sistema avisara.
const SKIP_AUDIT_CRON = () => process.env.CALENDLY_SKIP_AUDIT_CRON || '15 * * * *';
// Umbral por closer. En 2 y no en 1 para no alertar por el caso aislado (un closer que se
// dio de baja, una call rara); dos en la misma ventana ya huele a configuración rota.
const SKIP_ALERT_MIN = () => Number(process.env.CALENDLY_SKIP_ALERT_MIN || 2);

const ADMIN_LIDS = () =>
  (process.env.ADMIN_LID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// ─── Seam de dependencias (impuras) ───────────────────────────────────────────

let _injectedDeps = null;

// Solo para tests: sustituye API/DB/WhatsApp por mocks del contrato.
export function __setDeps(deps) {
  _injectedDeps = deps;
}
export function __resetDeps() {
  _injectedDeps = null;
}

async function deps() {
  if (_injectedDeps) return _injectedDeps;
  const [calendly, db, whatsapp, hubspot] = await Promise.all([
    import('../calendly/index.js'),
    import('../db/index.js'),
    import('../whatsapp/index.js'),
    import('../hubspot/client.js'),
  ]);
  return {
    // Cuentas de Calendly a pollear. Va por el seam porque lee process.env (los tokens):
    // es impura, y los tests necesitan poder simular dos cuentas sin tocar el entorno.
    accounts: activeAccounts,
    listProgramEvents: calendly.listProgramEvents,
    getEvent: calendly.getEvent,
    getFirstInvitee: calendly.getFirstInvitee,
    // Fallback de teléfono: si Calendly no trae número, se busca por email en HubSpot
    // (read-only). Se autodesactiva si HubSpot no está configurado → comportamiento previo.
    hubspotEnabled: hubspot.isEnabled,
    getContactPhone: hubspot.getContactPhone,
    // Rescate del teléfono cuando el lead agendó con otro correo (ver resolvePhone).
    findPhoneByName: hubspot.findPhoneByName,
    // §18.AF: modelo nudge — matchea la call con su deal y clasifica el estado.
    matchCallToDeal: hubspot.matchCallToDeal,
    // §18.AN: poll de las citas que solo viven en HubSpot.
    searchMeetingsInWindow: hubspot.searchMeetingsInWindow,
    getOwnerEmailMap: hubspot.getOwnerEmailMap,
    getMeetingContact: hubspot.getMeetingContact,
    getScheduledCallsInWindow: db.getScheduledCallsInWindow,
    getCallsWithAnyPushInWindow: db.getCallsWithAnyPushInWindow,
    supersedeHubspotPushes: db.supersedeHubspotPushes,
    // §18.AO: la reagenda hecha dentro del CRM (crea meeting nuevo, deja el viejo con su push).
    searchMeetingsCreatedSince: hubspot.searchMeetingsCreatedSince,
    getContactsOfMeetings: hubspot.getContactsOfMeetings,
    getMeetingsOfContacts: hubspot.getMeetingsOfContacts,
    getMeetingsByIds: hubspot.getMeetingsByIds,
    supersedeRescheduledPushes: db.supersedeRescheduledPushes,
    scheduleCalendlyPush: db.scheduleCalendlyPush,
    getDueCalendlyPushes: db.getDueCalendlyPushes,
    claimCalendlyPush: db.claimCalendlyPush,
    revertCalendlyPush: db.revertCalendlyPush,
    reclaimStuckCalendlyPushes: db.reclaimStuckCalendlyPushes,
    markCalendlyPushSent: db.markCalendlyPushSent,
    markCalendlyPushSkipped: db.markCalendlyPushSkipped,
    // Auditoría horaria: pushes perdidos por closer (ver runSkipAudit).
    getSkipsAlertablesPorCloser: db.getSkipsAlertablesPorCloser,
    // Dedup de alertas que sobrevive al reinicio (solo para lo histórico, ver notifyAdmins).
    shouldAlertPersistent: db.shouldAlertPersistent,
    // §18.AB: outcomes post-call.
    createPendingOutcome: db.createPendingOutcome,
    // Push 4: 'sent' + pendiente en UNA transaccion (ver db/index.js).
    marcarPush4Preguntado: db.marcarPush4Preguntado,
    recordAutoOutcome: db.recordAutoOutcome,
    getDueOutcomeReminders: db.getDueOutcomeReminders,
    markOutcomeReminded: db.markOutcomeReminded,
    expireUnansweredOutcomes: db.expireUnansweredOutcomes,
    // §18.AH: barrido periódico de cosecha (re-chequea filas abandonadas al nudge).
    getStaleHarvestCandidates: db.getStaleHarvestCandidates,
    applyHarvestedOutcome: db.applyHarvestedOutcome,
    // §18.AC: reagendas — dedup contra Calendly + insistencia por la fecha.
    recordRescheduleAwaitingDate: db.recordRescheduleAwaitingDate,
    getPendingManualPushes: db.getPendingManualPushes,
    supersedeManualPushes: db.supersedeManualPushes,
    getAwaitingDateOutcomes: db.getAwaitingDateOutcomes,
    markReschedulePrompted: db.markReschedulePrompted,
    expireAwaitingDateOutcomes: db.expireAwaitingDateOutcomes,
    // Anti-ban: el gate de entrega exige opt-in GANADO (el closer escribió), no solo
    // que la fila exista. Una fila sembrada/sin verificar NO habilita envío en frío.
    isOptedIn: db.isVerifiedOptedIn,
    // Para enrutar al hilo real del closer (contact_jid) en vez del número canónico.
    getOptin: db.getOptin,
    // Botón de pánico global (`/calendly off`): apaga TODOS los envíos al instante.
    isCalendlyPaused: db.isCalendlyPaused,
    // Pausa por-closer, por identidad/email (`/calendly off <closer> <cuenta>`).
    isCloserPaused: db.isCloserPaused,
    // Alcance del espejo de dev, movible en caliente con `/espejo` (§18.BV). Sin esto el
    // espejo solo sabía del `.env` y cambiarlo costaba un redeploy.
    getMirrorConnections: db.getMirrorConnections,
    // Anti-ban: la agenda a la admin es un DM a un tercero, no a un closer con opt-in.
    // Sin hilo previo NO se entrega (mismo gate que el reporte de las 8pm).
    hasDmThread: db.hasDmThread,
    sendMessage: whatsapp.sendMessage,
    // Brochure adjunto del Push 1 (Operaciones): pasa por la MISMA cola anti-ban.
    sendDocument: whatsapp.sendDocument,
    now: () => Date.now(),
  };
}

// Teléfono del prospecto para el push precall. Calendly deja `text_reminder_number`
// null en muchas reservas (instant_book / reagendadas / formularios sin SMS) → antes
// eso caía a "sin teléfono, mándalo manual". Fallback read-only: buscar el contacto en
// HubSpot por su email (Calendly siempre lo captura) y tomar mobilephone/phone. Si
// HubSpot está apagado o no hay match, se comporta igual que antes (devuelve null).
//
// ⚠️ El HubSpot conectado es el de UNA empresa (`account.hubspot`). Un lead de OTRA agencia
// no se busca ahí jamás: si el email coincidiera (misma persona en ambos CRMs, o choque de
// email), le meteríamos al closer de una empresa el teléfono sacado del CRM de la otra —
// el closer terminaría escribiéndole a un contacto ajeno, y cruzaríamos datos entre
// clientes. Sin `account` (callers viejos) se asume la cuenta default, que sí lo tiene.
async function resolvePhone(d, invitee, account) {
  const direct = prospectPhoneOf(invitee);
  if (direct) return direct;
  const acct = account || accountOf(DEFAULT_ACCOUNT);
  if (!acct?.hubspot) return null;
  const email = invitee?.email;
  if (!d.hubspotEnabled?.()) return null;
  if (email && d.getContactPhone) {
    const p = await d.getContactPhone(email).catch(() => null);
    if (p) {
      console.log(`[HubSpot] teléfono de ${email} recuperado (Calendly sin número)`);
      return p;
    }
  }
  // Último recurso: el GEMELO por nombre. Cuando el lead agenda con un correo distinto al del
  // formulario, HubSpot queda con dos contactos y el del correo de Calendly es un cascarón sin
  // teléfono — así que la búsqueda por email de arriba devuelve null teniendo el número al lado
  // (medido 2026-07-28). findPhoneByName solo responde si NO hay ambigüedad; ante homónimos con
  // teléfonos distintos devuelve null y el push sale "mándalo manual", como antes.
  if (!d.findPhoneByName) return null;
  const porNombre = await d.findPhoneByName(invitee?.name).catch(() => null);
  if (porNombre) {
    console.log(
      `[HubSpot] teléfono de "${invitee?.name}" recuperado por NOMBRE (su correo de Calendly ${email || '(sin correo)'} no tiene teléfono en HubSpot)`
    );
  }
  return porNombre;
}

// Payload de createPendingOutcome para una fila de push. `extra` permite fijar `reminded`
// (el nudge lo pone en 1 para suprimir el recordatorio clásico).
function pendingOutcomeFrom(p, extra = {}) {
  return {
    event_uuid: p.event_uuid,
    program: p.program,
    closer_email: p.closer_email,
    closer_phone: p.closer_phone,
    closer_name: resolveCloser(p.closer_email)?.name || null,
    lead_name: p.prospect_name,
    lead_phone: p.prospect_phone,
    call_start: p.call_start,
    ...extra,
  };
}

// Modelo nudge/cosecha (§18.AF/AG): decide qué hacer con un Push 4 de un programa cubierto.
// Saca el email del lead de Calendly (la fila del push no lo guarda), matchea el deal y
// traduce a un plan. Con HARVEST_ENABLED prefiere `agenda_status` (deriva el outcome sin
// preguntar); si no, cae al nudge por etapa. Devuelve:
//   { handled:false }                        → cae a Push 4 clásico (preguntar) — red de seguridad
//   { handled:true, harvest:'show'|… }        → registrar el outcome sin preguntar (cosecha)
//   { handled:true, reschedule:true, nextMeetingStart } → reagenda: cosechar + agendar la nueva
//   { handled:true, silent:true, reason }     → no molestar (deal ya avanzado / cita futura)
//   { handled:true, message }                 → mandar el nudge (link al deal / crear)
async function planNudge(d, p) {
  if (!d.matchCallToDeal) return { handled: false };
  // Email del lead (la fila del push no lo guarda) — y de dónde sacarlo depende del ORIGEN de
  // la call. Bug 2026-07-27: esto preguntaba SIEMPRE a Calendly con el event_uuid, así que para
  // una cita que solo vive en HubSpot armaba la URL '…/scheduled_events/hubspot:113635096174',
  // Calendly devolvía error, el email quedaba null y el plan caía a `handled:false` → el Push 4
  // CLÁSICO. Resultado medido: de las calls de origen Calendly, 121 de 148 outcomes se
  // cosecharon solos; de las de origen HubSpot, 0 de 3 — las tres le preguntaron al closer,
  // que es justo lo que la cosecha existe para evitar.
  let email = null;
  const meetingId = hubspotMeetingIdOf(p.event_uuid);
  if (meetingId) {
    // Origen HubSpot: el lead sale del contacto asociado al meeting, la misma vía que ya usa
    // el poll para armar el Push 3.
    const contacto = d.getMeetingContact ? await d.getMeetingContact(meetingId).catch(() => null) : null;
    email = contacto?.email || null;
  } else {
    try {
      const inv = await d.getFirstInvitee(`https://api.calendly.com/scheduled_events/${p.event_uuid}`);
      email = inv?.email || null;
    } catch {
      /* sin invitee → sin email → cae a clásico */
    }
  }
  if (!email) return { handled: false };

  // `name`: sin él, matchCallToDeal no puede buscar al GEMELO cuando el lead agendó con otro correo.
  const match = await d.matchCallToDeal({ email, programKey: p.program, name: p.prospect_name });
  const lead = fullNameFrom(p.prospect_name);

  // §18.AG — cosecha por estado de agenda (evolución del nudge). Solo si el flag está y el
  // deal trae `agenda_status`; si no, cae al modelo por etapa de abajo (red de seguridad).
  if (HARVEST_ENABLED() && match && !match.error && match.agendaStatus) {
    const a = decideFromAgenda({
      agendaStatus: match.agendaStatus,
      nextMeetingStart: match.nextMeetingStart,
      now: d.now(),
    });
    if (a.action === 'harvest')
      return { handled: true, harvest: a.asistencia, reason: match.agendaStatus, won: match.won };
    if (a.action === 'reschedule')
      return { handled: true, reschedule: true, nextMeetingStart: match.nextMeetingStart, reason: 'RESCHEDULED' };
    if (a.action === 'skip') return { handled: true, silent: true, reason: a.reason };
    if (a.action === 'nudge')
      return { handled: true, message: buildDealNudgeMessage({ name: lead, url: dealUrl(match.deal?.id), viaTwin: match.viaTwin }) };
    // a.action === 'ask' → sin estado claro → cae al modelo por etapa / clásico.
  }

  // Modelo por etapa (§18.AF): fallback. Solo activo con HUBSPOT_NUDGE_ENABLED.
  if (!NUDGE_ENABLED()) return { handled: false };
  const decision = decideNudgeAction(match);
  if (decision.action === 'silent') return { handled: true, silent: true, reason: match.status };
  if (decision.action === 'nudge_update')
    return { handled: true, message: buildDealNudgeMessage({ name: lead, url: decision.dealUrl, viaTwin: match.viaTwin }) };
  if (decision.action === 'nudge_review')
    return { handled: true, message: buildTwinReviewMessage({ name: lead, urls: decision.dealUrls }) };
  if (decision.action === 'nudge_create')
    return { handled: true, message: buildCreateDealNudgeMessage({ name: lead, reason: decision.reason }) };
  return { handled: false }; // 'ask' / unknown / error → Push 4 clásico
}

// ─── Alertas a admins (decisión 5) ────────────────────────────────────────────
// DM inmediato a los ADMIN_LID solo para fallos que tiran pushes de un closer real
// al piso: token muerto y closer sin mapear. Deduplicado por `dedupKey` (6h) para
// no spamear cada poll. Si no hay ADMIN_LID configurado, queda en el log.
// `persistent`: usa el dedup que SOBREVIVE al reinicio (tabla `settings`) en vez del de
// memoria. Va por alerta, no global, porque la diferencia es real: un token muerto sigue
// muerto y re-avisarlo tras un reinicio confirma que el problema sigue vivo; un push que ya
// se perdió es historia y re-avisarlo solo hace ruido. Ver shouldAlertPersistent en db/index.js.
async function notifyAdmins(d, text, dedupKey, { persistent = false } = {}) {
  const gate = persistent && d.shouldAlertPersistent ? d.shouldAlertPersistent : shouldAlert;
  if (dedupKey && !gate(dedupKey)) return;
  const admins = ADMIN_LIDS();
  if (!admins.length) {
    console.warn(`[Calendly] alerta sin ADMIN_LID configurado: ${text}`);
    return;
  }
  for (const a of admins) {
    try {
      await d.sendMessage(a, `⚠️ ${text}`);
    } catch (e) {
      console.error('[Calendly] no pude alertar al admin:', e.message);
    }
  }
}

function isAuthError(msg) {
  return /\b(401|403)\b/.test(String(msg || ''));
}

// ─── Listado multi-cuenta con aislamiento de errores ──────────────────────────
// Consulta las citas de CADA cuenta activa por separado y devuelve `{ ev, account }` para
// que el caller sepa con qué token seguir pidiendo detalles de cada evento.
//
// El try/catch va POR CUENTA a propósito: un token muerto en una agencia NO puede tumbar
// el poll de la otra. Antes, con una sola cuenta, un throw acá abortaba el ciclo entero.
// `failed` avisa si alguna cuenta se cayó, para no confundir "no hay citas" con "no pude
// preguntar" (un 0 silencioso sería exactamente el bug que esto evita).
async function listEventsAllAccounts(d, { minStartIso, maxStartIso, tag }) {
  const out = [];
  let failed = false;
  for (const account of d.accounts ? d.accounts() : activeAccounts()) {
    try {
      const evs = await d.listProgramEvents({ minStartIso, maxStartIso, account });
      for (const ev of evs) out.push({ ev, account });
    } catch (e) {
      failed = true;
      recordPollError(e.message);
      console.error(`[Calendly] ${tag} [${account.key}]: error listando:`, e.message);
      if (isAuthError(e.message)) {
        await notifyAdmins(
          d,
          `Calendly rechazó el token de ${account.label} (${e.message.slice(0, 80)}). Los pushes de esa cuenta están caídos hasta rotarlo.`,
          `token:${account.key}` // dedup POR CUENTA: una alerta no puede silenciar la otra
        );
      }
    }
  }
  return { events: out, failed };
}

// ─── Cuenta del closer → dry-run ──────────────────────────────────────────────
// El dry-run es POR CUENTA: una agencia puede estar enviando en vivo mientras la otra
// arranca muda. Se resuelve por el closer (no por el programa) porque el closer siempre se
// conoce, incluso en filas viejas con `program` NULL. Cuenta desconocida → DRY_RUN() global,
// que es el default seguro (true = no envía).
function dryRunForCloser(closerEmail) {
  const acct = accountOf(accountOfCloser(closerEmail));
  return acct ? acct.dryRun() : DRY_RUN();
}

// ─── Envío (respeta DRY-RUN) ──────────────────────────────────────────────────

// Punto ÚNICO de salida hacia un closer. Envuelve `deliverToCloser` (que tiene toda la lógica y
// los gates) para colgarle el espejo de dev sin ensuciar ninguno de sus siete puntos de retorno.
// Todos los callers siguen llamando `deliver` y recibiendo el mismo resultado que antes.
async function deliver(d, to, text, tag, closerEmail) {
  const outcome = await deliverToCloser(d, to, text, tag, closerEmail);
  await mirrorToDev(d, { text, tag, closerEmail, outcome });
  return outcome;
}

// Copia al dev de UN mensaje ya resuelto. Best-effort y SIEMPRE después del envío real: si el
// espejo falla (JID muerto, sesión caída) el push ya se entregó donde importa y el resultado no
// cambia — un espejo roto nunca puede marcar como fallido un push que sí salió.
//
// ⚠️ DEDUPLICADO, y no es un detalle de cortesía. Un Push 3 que no se puede entregar **NO se
// quema**: se queda en 'scheduled' y `runCalendlyDelivery` lo reintenta CADA MINUTO hasta que la
// call pasa (por eso el log de `deliver` tiene su propio throttle de 1h). La primera versión del
// espejo no lo tenía y mandó 29 copias del mismo push en hora y media — la del lead sin teléfono
// de Dana, que no tenía opt-in. Un espejo que grita 60 veces por hora es exactamente el ruido que
// hace que se deje de mirar, o sea que se rompe solo.
//
// La clave incluye el HASH DEL TEXTO, no solo el closer: dos leads distintos del mismo closer con
// el mismo resultado son dos avisos legítimos. Y incluye el RESULTADO, que es lo que hace que esto
// no pierda información: si el push pasa de 'skipped-optin' a 'sent', la clave cambia y el aviso
// nuevo sale al toque, sin esperar el TTL. O sea que se silencia la repetición, nunca el cambio.
const mirrorKey = (tag, closerEmail, outcome, text) =>
  `espejo:${tag}:${closerEmail}:${outcome}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 12)}`;

async function mirrorToDev(d, { text, tag, closerEmail, outcome }) {
  const jid = DEV_MIRROR_JID();
  if (!jid) return;
  // El botón de pánico manda sobre todo lo demás: 'paused' es la pausa GLOBAL.
  if (outcome === 'paused') return;
  const conexion = accountOfCloser(closerEmail);
  if (!DEV_MIRROR_CONNECTIONS(d.getMirrorConnections?.()).includes(conexion)) return;
  if (!shouldAlert(mirrorKey(tag, closerEmail, outcome, text), DEV_MIRROR_TTL_MS())) return;
  const closer = resolveCloser(closerEmail);
  const cabecera =
    `🪞 *espejo dev* — ${tag} · ${accountOf(conexion)?.label || conexion} · ` +
    `${closer?.name || closerEmail} · resultado: *${outcome}*`;
  try {
    await d.sendMessage(jid, `${cabecera}\n\n${text}`);
  } catch (e) {
    console.error(`[Calendly] espejo dev falló (el push real no se ve afectado): ${e.message}`);
  }
}

// Devuelve 'sent' | 'dry-run' | 'skipped-optin' | 'skipped-no-thread'
//          | 'paused' | 'paused-closer'.
// Anti-baneo: nunca enviamos a un closer que no haya escrito antes a Juanito.
// `to` es solo el fallback del número canónico del closer: la clave del opt-in se
// re-resuelve adentro contra `closers.js` a partir de `closerEmail` (ver paso 0), para que
// una rotación de número no deje huérfanas las filas ya agendadas. El ENVÍO, en cambio, va
// EXCLUSIVAMENTE a la identidad que YA estableció hilo con Juanito (`contact_jid` del
// opt-in). Entrega ESTRICTA (Item 1):
// sin `contact_jid` NO se entrega — preferimos perder un push antes que mandar en frío
// a un número que jamás escribió (el patrón que dispara softbans).
//
// Botón de pánico (Item 2, `/calendly on|off`, admin): la pausa GLOBAL corta todo; la
// pausa por-closer (por IDENTIDAD/email, `isCloserPaused`) corta solo ese programa de ese
// closer. Es ortogonal a DRY_RUN (master dev-only del .env) y se controla en caliente desde
// la DB, sin redeploy.
//
// `closerEmail` decide la CUENTA (accountOfCloser) y con ella el dry-run: así una agencia
// puede estar en vivo mientras la otra solo loguea. REGLA para quien agregue un canal
// nuevo hacia closers: el dry-run se resuelve SIEMPRE por `accountOfCloser(closerEmail)`,
// nunca leyendo DRY_RUN() directo — si no, ese canal se le escapa a la cuenta muda.
async function deliverToCloser(d, to, text, tag, closerEmail) {
  // 0) La llave del opt-in se resuelve SIEMPRE contra el roster vivo, nunca con el número
  //    que venga en `to`. Las filas de `calendly_pushes` congelan `closer_phone` al AGENDAR
  //    (hasta 48h antes) y `outcomes` hace lo mismo: rotarle el número a un closer dejaba
  //    huérfano todo lo ya agendado, y como el skip es terminal, arreglar el roster no lo
  //    recuperaba (Daniela, 29-jul: 5 leads sin precall). Resolver acá y no en cada call
  //    site es a propósito — es el punto ÚNICO por el que pasan push 3/4/5, digests,
  //    outcomes y reagendas. `to` queda de fallback para un closer que ya salió del roster.
  const phone = resolveCloser(closerEmail)?.phone || to;
  // 1) Pausa global: botón de pánico — apaga absolutamente todo.
  if (d.isCalendlyPaused && d.isCalendlyPaused()) {
    console.log(`[Calendly] PAUSADO (global) → ${phone}: omito (${tag})`);
    return 'paused';
  }
  // 2) Opt-in GANADO requerido (anti-ban).
  if (REQUIRE_OPTIN() && !d.isOptedIn(phone)) {
    // Throttle 1h: desde que el push 3 reintenta en vez de quemarse, un closer sin opt-in
    // con agenda llena repetiría esta línea cada minuto y taparía el resto del log. La
    // clave lleva prefijo propio para no chocar con las de notifyAdmins.
    if (shouldAlert(`log:optin:${phone}`, 3600 * 1000))
      console.log(`[Calendly] OMITIDO (${tag}) → ${phone}: el closer aún no le ha escrito a Juanito (sin opt-in)`);
    return 'skipped-optin';
  }
  const optin = d.getOptin ? d.getOptin(phone) : null;
  // 3) Pausa por-closer, por IDENTIDAD (email de la CITA): una persona con dos identidades (misma
  //    línea, dos Calendly) se apaga por programa. El opt-in se comparte por teléfono, pero la
  //    pausa vive por email en `settings`. Ver isCloserPaused/setCloserPaused y la invariante en
  //    src/calendly/closers.js.
  if (d.isCloserPaused && d.isCloserPaused(closerEmail)) {
    console.log(`[Calendly] PAUSADO (closer ${closerEmail}): omito (${tag})`);
    return 'paused-closer';
  }
  // 4) Entrega estricta: solo a un hilo YA establecido (contact_jid). Sin él, no se envía.
  const target = optin?.contact_jid;
  if (!target) {
    if (shouldAlert(`log:jid:${phone}`, 3600 * 1000))
      console.log(`[Calendly] OMITIDO (${tag}) → ${phone}: sin hilo establecido (contact_jid) — no se entrega para evitar envío en frío`);
    return 'skipped-no-thread';
  }
  const via = ` [hilo de opt-in; closer ${phone}]`;
  // 4b) Aparatos SECUNDARIOS del roster (`extraJids`): copia de lo mismo, para closers que
  //     trabajan con dos líneas y pidieron recibir en ambas. Se calcula acá —después de todos
  //     los gates— para que la copia herede pausa, opt-in y dry-run del primario: un `/calendly
  //     off` que apagara el principal y siguiera copiando al secundario sería lo peor de ambos.
  //     Se descarta el que coincida con el primario (mismo hilo, no duplicar el mensaje).
  const extras = extraJidsForCloser(closerEmail).filter((j) => j && j !== target);
  // 5) Dry-run de la cuenta del closer (último filtro, igual que antes).
  if (dryRunForCloser(closerEmail)) {
    console.log(`[Calendly][DRY-RUN:${accountOfCloser(closerEmail)}] (${tag}) → ${target}${via}\n${text}\n`);
    for (const extra of extras)
      console.log(`[Calendly][DRY-RUN:${accountOfCloser(closerEmail)}] copia (${tag}) → ${extra} [aparato secundario]`);
    return 'dry-run';
  }
  await d.sendMessage(target, text);
  console.log(`[Calendly] enviado (${tag}) → ${target}${via}`);
  // La copia es BEST-EFFORT y va después del primario a propósito: si el secundario falla
  // (aparato desvinculado, JID muerto), el push ya se entregó donde importa y el estado sigue
  // siendo 'sent'. Si contara para el resultado, un teléfono viejo apagado marcaría el push como
  // fallido y dispararía reintentos de algo que SÍ llegó.
  for (const extra of extras) {
    try {
      await d.sendMessage(extra, text);
      console.log(`[Calendly] copia (${tag}) → ${extra} [aparato secundario; closer ${phone}]`);
    } catch (e) {
      console.error(`[Calendly] ⚠️ copia (${tag}) a ${extra} falló (el primario SÍ salió): ${e.message}`);
    }
  }
  return 'sent';
}

// ─── Poll: descubre citas y agenda Push 3 ─────────────────────────────────────

export async function runCalendlyPoll() {
  const d = await deps();
  const nowMs = d.now();
  const now = new Date(nowMs);
  const minStartIso = new Date(nowMs - 5 * 60000).toISOString();
  const maxStartIso = new Date(nowMs + 48 * 3600 * 1000).toISOString();

  // Una cuenta caída no puede tumbar el poll de la otra → se listan por separado.
  const { events, failed } = await listEventsAllAccounts(d, {
    minStartIso,
    maxStartIso,
    tag: 'poll',
  });
  if (failed && !events.length) return 0;

  // §18.AC: pushes de reagendas manuales aún por entregar. Si una de esas reagendas
  // terminó entrando por Calendly, el evento real manda y hay que cancelar el sintético
  // — si no, se le pregunta dos veces al closer y el lead cuenta dos veces.
  let manualPushes =
    RESCHEDULE_ENABLED() && d.getPendingManualPushes ? d.getPendingManualPushes() : [];

  let nuevos = 0;
  for (const { ev, account } of events) {
    try {
      const uuid = ev.uri.split('/').pop();

      // Decisión 4b: agendar incluso si los triggers normales ya pasaron (catch-up),
      // mientras la llamada siga en el futuro.
      const sched = computePush3Schedule({ startIso: ev.start_time, leadMin: LEAD_MIN(), nowMs });
      if (!sched.shouldSchedule) continue;
      const due = new Date(sched.dueMs);

      const email = closerEmailOf(ev);
      const closer = resolveCloser(email);
      if (!closer) {
        if (isIgnoredCloser(email)) continue; // host conocido, no gestionado aún → silencio
        recordUnmapped(email);
        console.warn(`[Calendly] poll: sin closer mapeado para "${email}" (evento ${uuid}) — omito`);
        await notifyAdmins(d, `Closer sin mapear en Calendly: ${email}. Esa(s) cita(s) no recibirán pushes — agrégalo a src/calendly/closers.js.`, `unmapped:${email}`);
        continue;
      }

      const programKey = programKeyOf(ev.event_type);
      const invitee = await d.getFirstInvitee(ev.uri, { token: account.token() });
      const firstName = firstNameFrom(invitee?.name);
      const name = fullNameFrom(invitee?.name);
      const phone = await resolvePhone(d, invitee, account);

      // Dedup de reagendas (§18.AC): mismo closer + mismo lead + call futura = es la misma
      // call que el closer nos dictó por WhatsApp, pero ahora con evento real. Calendly
      // manda: se cancelan los pushes sintéticos y el outcome apunta al uuid real.
      if (manualPushes.length && d.supersedeManualPushes) {
        const hits = pickSupersededPushes(manualPushes, {
          closerPhone: closer.phone,
          leadPhone: phone,
          leadName: invitee?.name,
        });
        const uuids = new Set(hits.map((h) => h.event_uuid));
        for (const manualUuid of uuids) {
          d.supersedeManualPushes(manualUuid, uuid);
          console.log(
            `[Calendly] reagenda ${manualUuid} superseded por evento real ${uuid} (${firstName}) — no se pregunta dos veces`
          );
        }
        // Fuera de la lista: ya no pueden volver a matchear con otra cita de este mismo poll.
        if (uuids.size) manualPushes = manualPushes.filter((p) => !uuids.has(p.event_uuid));
      }

      // Dedup contra el poll de HubSpot (§18.AN), en el sentido inverso: la cita ya tenía push
      // sintético porque solo estaba en el CRM, y ahora aparece en Calendly (el closer la pasó
      // al sistema, o el sync llegó tarde). Calendly manda → se cancela el sintético. Sin esto
      // el closer recibiría el MISMO aviso dos veces, que es peor que no recibirlo.
      const callStartUtc = toSqliteUtc(new Date(ev.start_time));
      if (d.supersedeHubspotPushes) {
        const cancelados = d.supersedeHubspotPushes(email, callStartUtc, uuid);
        if (cancelados) {
          console.log(
            `[Calendly] ${cancelados} push(es) de HubSpot cancelados: la cita de ${firstName} entró por Calendly (${uuid})`
          );
        }
      }

      const message = buildPush3Message({
        name,
        firstName,
        phone,
        startIso: ev.start_time,
        programKey,
        closer: firstNameFrom(closer.name),
        linkLlamada: eventJoinUrl(ev),
      });

      const result = d.scheduleCalendlyPush({
        event_uuid: uuid,
        push_n: 3,
        program: programKey,
        closer_email: email,
        closer_phone: closer.phone,
        prospect_name: invitee?.name || null,
        prospect_phone: phone,
        call_start: toSqliteUtc(new Date(ev.start_time)),
        due_at: toSqliteUtc(due),
        message,
      });

      if (result === 'new' || result === 'rescheduled') {
        nuevos++;
        const tag = sched.immediate ? ' [catch-up]' : '';
        console.log(
          `[Calendly] Push 3 ${result}${tag} → ${closer.name} | ${firstName} | ${formatCallTime(ev.start_time)} (due ${toSqliteUtc(due)} UTC)`
        );
      }

      // ─── Push 4: registro de outcome post-call (§18.AB) ──────────────────────
      // Se agenda para start + duración + gracia (default 30+5). Mismo dedup
      // (UNIQUE event_uuid+push_n). El mensaje real se reconstruye al entregar.
      // Gateado por allowlist (PUSH4_CLOSERS) para rollouts acotados a un closer.
      // Gate por CUENTA: una agencia puede tener el registro de outcomes activo mientras
      // otra arranca solo con los pushes precall (0-3). `push4` del registro manda; la
      // allowlist fina (CALENDLY_PUSH4_CLOSERS) se aplica además, dentro de esa cuenta.
      if (account.push4() && push4AllowedFor(email)) {
        const due4 = push4DueUtc(ev.start_time, CALL_DURATION_MIN(), PUSH4_GRACE_MIN());
        const r4 = d.scheduleCalendlyPush({
          event_uuid: uuid,
          push_n: 4,
          program: programKey,
          closer_email: email,
          closer_phone: closer.phone,
          prospect_name: invitee?.name || null,
          prospect_phone: phone,
          call_start: toSqliteUtc(new Date(ev.start_time)),
          due_at: toSqliteUtc(due4),
          message: buildPush4Message({ name, firstName, startIso: ev.start_time }),
        });
        if (r4 === 'new' || r4 === 'rescheduled') {
          console.log(
            `[Calendly] Push 4 ${r4} → ${closer.name} | ${firstName} | call ${formatCallTime(ev.start_time)} (pregunta ${toSqliteUtc(due4)} UTC)`
          );
        }
      }

      // ─── Push 5: recordatorio de llenar los Sheets (§18.AP) ──────────────────
      // Solo las conexiones que declaran `sheets` (hoy retia y comunicarte). Vence al FIN REAL de la call
      // (ev.end_time) + delay, no a start+duración: una call de 45 min no debe recibirlo
      // mientras sigue en curso. Mismo dedup UNIQUE(event_uuid, push_n) que los demás; el
      // mensaje real se reconstruye al entregar.
      //
      // OJO con la numeración: es 5 y no 4 porque el 4 es el registro de outcome de 30x, que
      // esta cuenta tiene apagado (account.push4() → false). Retia se salta el 4.
      if (SHEET_PUSH_ENABLED() && account.sheets?.length) {
        const due5 = push5DueUtc(ev.start_time, ev.end_time, {
          durationMin: CALL_DURATION_MIN(),
          delayMin: SHEET_PUSH_DELAY_MIN(),
        });
        const r5 = d.scheduleCalendlyPush({
          event_uuid: uuid,
          push_n: 5,
          program: programKey,
          closer_email: email,
          closer_phone: closer.phone,
          prospect_name: invitee?.name || null,
          prospect_phone: phone,
          call_start: toSqliteUtc(new Date(ev.start_time)),
          due_at: toSqliteUtc(due5),
          message: buildPush5Message({ name, firstName, startIso: ev.start_time, sheets: account.sheets }),
        });
        if (r5 === 'new' || r5 === 'rescheduled') {
          console.log(
            `[Calendly] Push 5 ${r5} → ${closer.name} | ${firstName} | call ${formatCallTime(ev.start_time)} (sheets ${toSqliteUtc(due5)} UTC)`
          );
        }
      }

      // ─── Push 0: aviso de "nueva call HOY / MAÑANA" (§18.C) ──────────────────
      // Solo para reservas genuinamente nuevas, una vez ya pasó el digest que le
      // correspondía (Push 2 si la call es hoy, Push 1 si es mañana). El caso
      // "mañana" tapa la ventana ciega de la noche — ver push-logic.js. Reusa la
      // misma fila/dedup que los demás pushes (push_n=0, due=ahora) → lo entrega
      // `runCalendlyDelivery` con todos los gates anti-ban.
      if (PUSH0_ENABLED()) {
        const d0 = decidePush0({
          startMs: new Date(ev.start_time).getTime(),
          createdAtMs: ev.created_at ? new Date(ev.created_at).getTime() : NaN,
          nowMs,
          isToday: isSameDayInTz(ev.start_time, TZ(), now),
          push2HasRun: push2HasRunToday(PUSH2_CRON(), TZ(), now),
          isTomorrow: isNextDayInTz(ev.start_time, TZ(), now),
          push1HasRun: dailyCronHasRunToday(PUSH1_CRON(), TZ(), now),
          recentMs: PUSH0_RECENT_MIN() * 60000,
        });
        if (d0.notify) {
          const when = d0.reason === 'new-booking-tomorrow' ? 'mañana' : 'hoy';
          const msg0 = buildPush0Message({ name, firstName, phone, startIso: ev.start_time, programKey, when });
          const r0 = d.scheduleCalendlyPush({
            event_uuid: uuid,
            push_n: 0,
            program: programKey,
            closer_email: email,
            closer_phone: closer.phone,
            prospect_name: invitee?.name || null,
            prospect_phone: phone,
            call_start: toSqliteUtc(new Date(ev.start_time)),
            due_at: toSqliteUtc(new Date(nowMs)),
            message: msg0,
          });
          if (r0 === 'new') {
            console.log(
              `[Calendly] Push 0 (nueva call HOY) → ${closer.name} | ${firstName} | ${formatCallTime(ev.start_time)}`
            );
          }
        }
      }
    } catch (e) {
      console.error(`[Calendly] poll: error en evento ${ev.uri}:`, e.message);
    }
  }

  recordPollOk(events.length);
  console.log(
    `[Calendly] Poll completo: ${events.length} citas, ${nuevos} push 3 agendados/actualizados${DRY_RUN() ? ' [DRY-RUN]' : ''}`
  );

  // Las citas que solo existen en HubSpot, DESPUÉS de Calendly y en el mismo tick. El orden no
  // es cosmético: al correr segundo, el poll de HubSpot ya ve en `calendly_pushes` lo que
  // Calendly acaba de agendar, así que una cita que está en las dos fuentes queda con UN push,
  // el de Calendly. Si corrieran en paralelo (o HubSpot primero) habría carrera y doble aviso.
  await runHubspotAgendaPoll().catch((e) =>
    console.error('[HubSpot] poll de agenda falló (los pushes de Calendly no se ven afectados):', e.message)
  );

  // Y al final del todo, las reagendas hechas dentro del CRM. DESPUÉS de los dos polls, no antes:
  // si cancelara primero, el poll de HubSpot vería la call vieja "sin push" y le crearía uno
  // nuevo en el mismo tick —bajo otro event_uuid si venía de Calendly— resucitando justo lo que
  // acabábamos de matar.
  await runHubspotRescheduleScan().catch((e) =>
    console.error('[HubSpot] scan de reagendas falló (ningún push se canceló):', e.message)
  );

  return nuevos;
}

// ─── Poll de las citas que SOLO viven en HubSpot (§18.AN) ─────────────────────
// El closer (o un setter) agenda dentro del CRM y esa cita nunca pasa por Calendly: medido,
// ~11 al día. Salían en la agenda del jefe pero NADIE avisaba al closer. Acá se les crean los
// mismos Push 3/4/0 que a una cita de Calendly, pasando por los MISMOS gates (opt-in ganado,
// pausa global, pausa por closer, dry-run por cuenta) porque reusan `scheduleCalendlyPush` y
// los entrega `runCalendlyDelivery`.
//
// Apagado por default (HUBSPOT_AGENDA_POLL=true para activarlo): manda mensajes reales a
// closers, así que se estrena mirando primero qué haría (`previewHubspotAgendaPoll`).
export async function runHubspotAgendaPoll({ preview = false } = {}) {
  const d = await deps();
  if (!preview && !HUBSPOT_POLL_ENABLED()) return 0;
  if (!d.hubspotEnabled?.() || !d.searchMeetingsInWindow || !d.getScheduledCallsInWindow) return 0;

  const nowMs = d.now();
  const minStartIso = new Date(nowMs - 5 * 60000).toISOString();
  const maxStartIso = new Date(nowMs + 48 * 3600 * 1000).toISOString();
  const toDb = (iso) => iso.slice(0, 19).replace('T', ' ');

  const [meetings, ownerEmailById] = await Promise.all([
    d.searchMeetingsInWindow({ fromIso: minStartIso, untilIso: maxStartIso }),
    d.getOwnerEmailMap(),
  ]);
  const hubspotCalls = meetingsToCalls(meetings, { ownerEmailById, ownerToCloser: HUBSPOT_OWNER_TO_CLOSER });
  // Dedup contra CUALQUIER fila de push, no solo las vivas: una call cuyo push se canceló por
  // reagenda (§18.AO) tiene que seguir contando como "ya decidida", o el poll se la crearía de
  // nuevo bajo otro event_uuid en el ciclo siguiente. Fallback a la consulta vieja para no
  // romper los tests/mocks que solo inyectan `getScheduledCallsInWindow`.
  const existingCalls = (d.getCallsWithAnyPushInWindow || d.getScheduledCallsInWindow)(
    toDb(minStartIso),
    toDb(maxStartIso)
  );
  const { toSchedule, skipped, fueraDeHorario } = pickMeetingsToSchedule({
    hubspotCalls,
    existingCalls,
    tz: TZ(),
  });

  // Una cita fuera de horario NO se descarta en silencio: casi siempre es un marcador y no una
  // llamada, pero si alguna vez lo fuera, el log es la única forma de enterarse.
  for (const c of fueraDeHorario) {
    console.warn(
      `[HubSpot] cita fuera de horario, SIN push: ${c.call_start} UTC · ${c.closer_email} · ` +
        `${c.program} · ${String(c.prospect_name || '').slice(0, 60)}`
    );
  }

  if (preview) {
    console.log(
      `[HubSpot] PREVIEW: ${meetings.length} meetings → ${hubspotCalls.length} de closer → ` +
        `${toSchedule.length} SIN push (descartadas: ${skipped.yaAgendado} ya agendadas, ` +
        `${skipped.duplicado} duplicadas en HubSpot, ${skipped.programa} de otro CRM, ` +
        `${skipped.fueraDeHorario} fuera de horario)`
    );
    for (const c of toSchedule) {
      console.log(`   · ${c.call_start} UTC · ${c.closer_email} · ${c.program} · ${c.prospect_name || '(sin título)'}`);
    }
    return toSchedule.length;
  }

  let nuevos = 0;
  for (const call of toSchedule) {
    try {
      const startIso = callStartToIso(call.call_start);
      if (!startIso) continue;
      const sched = computePush3Schedule({ startIso, leadMin: LEAD_MIN(), nowMs });
      if (!sched.shouldSchedule) continue;

      const email = call.closer_email;
      const closer = resolveCloser(email);
      if (!closer) continue; // el mapa ya garantiza que es closer; defensivo

      // El lead sale del contacto asociado, no del título del meeting: el título es
      // "Entrevista de Postulación Programa X", que como nombre de prospecto no sirve
      // y deja el push sin número al cual escribirle.
      const contacto = d.getMeetingContact ? await d.getMeetingContact(call.meeting_id) : null;
      const name = fullNameFrom(contacto?.name) || null;
      const firstName = firstNameFrom(contacto?.name) || '';
      const phone = contacto?.phone || null;

      const base = {
        event_uuid: call.event_uuid,
        program: call.program,
        closer_email: email,
        closer_phone: closer.phone,
        prospect_name: contacto?.name || call.prospect_name || null,
        prospect_phone: phone,
        call_start: call.call_start,
      };

      const r3 = d.scheduleCalendlyPush({
        ...base,
        push_n: 3,
        due_at: toSqliteUtc(new Date(sched.dueMs)),
        message: buildPush3Message({
          name,
          firstName,
          phone,
          startIso,
          programKey: call.program,
          closer: firstNameFrom(closer.name),
          linkLlamada: call.join_url || '',
        }),
      });
      if (r3 === 'new' || r3 === 'rescheduled') {
        nuevos++;
        console.log(
          `[HubSpot] Push 3 ${r3} (cita solo en HubSpot) → ${closer.name} | ${firstName || '?'} | ${formatCallTime(startIso)}`
        );
      }

      const acct = accountOf(accountOfCloser(email));
      if (acct?.push4?.() && push4AllowedFor(email)) {
        d.scheduleCalendlyPush({
          ...base,
          push_n: 4,
          due_at: toSqliteUtc(push4DueUtc(startIso, CALL_DURATION_MIN(), PUSH4_GRACE_MIN())),
          message: buildPush4Message({ name, firstName, startIso }),
        });
      }

      if (PUSH0_ENABLED()) {
        const d0 = decidePush0({
          startMs: Date.parse(startIso),
          createdAtMs: call.created_at ? Date.parse(call.created_at) : NaN,
          nowMs,
          isToday: isSameDayInTz(startIso, TZ(), new Date(nowMs)),
          push2HasRun: push2HasRunToday(PUSH2_CRON(), TZ(), new Date(nowMs)),
          isTomorrow: isNextDayInTz(startIso, TZ(), new Date(nowMs)),
          push1HasRun: dailyCronHasRunToday(PUSH1_CRON(), TZ(), new Date(nowMs)),
          recentMs: PUSH0_RECENT_MIN() * 60000,
        });
        if (d0.notify) {
          d.scheduleCalendlyPush({
            ...base,
            push_n: 0,
            due_at: toSqliteUtc(new Date(nowMs)),
            message: buildPush0Message({
              name,
              firstName,
              phone,
              startIso,
              programKey: call.program,
              when: d0.reason === 'new-booking-tomorrow' ? 'mañana' : 'hoy',
            }),
          });
        }
      }
    } catch (e) {
      console.error(`[HubSpot] poll: error en ${call.event_uuid}:`, e.message);
    }
  }

  if (toSchedule.length || nuevos) {
    console.log(
      `[HubSpot] Poll de agenda: ${hubspotCalls.length} calls de closer, ${nuevos} push nuevos ` +
        `(${skipped.yaAgendado} ya venían de Calendly, ${skipped.duplicado} duplicadas en HubSpot)`
    );
  }
  return nuevos;
}

// ─── Reagendas hechas DENTRO del CRM (§18.AO) ─────────────────────────────────
// Reagendar en HubSpot no mueve la cita: crea una nueva y deja la vieja intacta con su hora
// original. La vieja se queda con su Push 3 ("arranca en 25 min") y su Push 4 ("¿cómo te fue?")
// para una llamada que no va a ocurrir. Backtest de 21 días: ~4 pushes rancios por semana.
//
// La lógica de decisión —qué es reagenda y qué no— es pura y vive en hubspot/reschedule-detect.js
// junto con la medición que fijó el umbral. Acá solo está el armado del grafo
// (cita nueva → contacto → otras citas del lead) y el efecto sobre la DB.
//
// Cuesta 1 request por ciclo cuando no hay nada nuevo (~4 cuando sí), porque busca por
// `hs_createdate` en vez de rastrear la agenda futura entera.
const RESCHEDULE_SIBLING_CAP = 300;

export async function runHubspotRescheduleScan({ preview = false } = {}) {
  const d = await deps();
  if (!preview && !HUBSPOT_RESCHEDULE_SCAN()) return 0;
  if (!d.hubspotEnabled?.() || !d.searchMeetingsCreatedSince || !d.supersedeRescheduledPushes) return 0;

  const nowMs = d.now();
  const sinceIso = new Date(nowMs - RESCHEDULE_SCAN_LOOKBACK_MIN() * 60000).toISOString();
  const esFutura = (c) => {
    const iso = callStartToIso(c.call_start);
    return Boolean(iso) && Date.parse(iso) > nowMs;
  };
  const deEsteCrm = (c) => programLivesInThisHubspot(c.program);

  const [raw, ownerEmailById] = await Promise.all([
    d.searchMeetingsCreatedSince({ sinceIso }),
    d.getOwnerEmailMap(),
  ]);
  const recientes = meetingsToCalls(raw, { ownerEmailById, ownerToCloser: HUBSPOT_OWNER_TO_CLOSER })
    .filter(deEsteCrm)
    .filter(esFutura);
  if (!recientes.length) return 0;

  // cita nueva → su lead
  const contactOf = await d.getContactsOfMeetings(recientes.map((c) => c.meeting_id));
  const nuevas = recientes
    .map((c) => ({ ...c, contact_id: contactOf[String(c.meeting_id)] }))
    .filter((c) => c.contact_id);
  if (!nuevas.length) return 0;

  // lead → TODAS sus citas (ahí está la que quedó vieja, que puede caer fuera de cualquier
  // ventana de agenda: por eso se llega a ella por el lead y no por rango de fechas)
  const porContacto = await d.getMeetingsOfContacts([...new Set(nuevas.map((c) => c.contact_id))]);
  const conocidas = new Map(nuevas.map((c) => [String(c.meeting_id), c]));
  const faltantes = [...new Set(Object.values(porContacto).flat())].filter((id) => !conocidas.has(String(id)));
  const hermanasRaw = faltantes.length ? await d.getMeetingsByIds(faltantes.slice(0, RESCHEDULE_SIBLING_CAP)) : [];
  const hermanas = new Map(
    meetingsToCalls(hermanasRaw, { ownerEmailById, ownerToCloser: HUBSPOT_OWNER_TO_CLOSER })
      .filter(deEsteCrm)
      .map((c) => [String(c.meeting_id), c])
  );

  const siblingsByContact = {};
  for (const [cid, ids] of Object.entries(porContacto)) {
    siblingsByContact[cid] = ids
      .map((id) => hermanas.get(String(id)) || conocidas.get(String(id)))
      .filter(Boolean);
  }

  const { superseded, skipped } = pickRescheduledAway({ nuevas, siblingsByContact, nowMs });

  if (preview) {
    console.log(
      `[HubSpot] PREVIEW reagendas: ${raw.length} meetings creados desde ${sinceIso.slice(0, 16)} → ` +
        `${nuevas.length} citas futuras de closer → ${superseded.length} calls viejas a cancelar ` +
        `(descartes: ${skipped.mismaTanda} misma tanda de booking, ${skipped.yaArranco} ya arrancaron, ` +
        `${skipped.mismoMinuto} duplicadas, ${skipped.otroPrograma} de otro programa)`
    );
  }

  let cancelados = 0;
  for (const { vieja, nueva, gapMin } of superseded) {
    // Se loguea SIEMPRE, aunque no hubiera push pendiente que cancelar: es la única forma de
    // auditar si la regla está tocando lo que debe. Un falso positivo acá deja a un closer sin
    // aviso de una call real, así que el log lleva las dos horas y el gap que la clasificó.
    const linea =
      `${vieja.closer_email} · ${vieja.program} · ${vieja.call_start} UTC → ${nueva.call_start} UTC ` +
      `(reagendada ${gapMin} min después de crearse la original; lead: ${String(nueva.prospect_name || '?').slice(0, 40)})`;
    if (preview) {
      console.log(`   · [preview] ${linea}`);
      continue;
    }
    const n = d.supersedeRescheduledPushes(vieja.closer_email, vieja.call_start, nueva.call_start);
    cancelados += n;
    console.log(`[HubSpot] reagenda en el CRM → ${n} push(es) cancelado(s): ${linea}`);
  }

  // Señal de vida. Sin esto el scan solo habla cuando cancela algo —o sea, unas 5 veces por
  // semana— y no habría forma de distinguir "no hubo reagendas" de "el job se murió". Solo se
  // loguea cuando hubo citas nuevas que examinar, así que no ensucia los ciclos vacíos.
  if (!preview) {
    console.log(
      `[HubSpot] scan de reagendas: ${nuevas.length} citas nuevas examinadas, ${superseded.length} reagendas, ` +
        `${cancelados} push(es) cancelado(s) (${skipped.yaArranco} rebooks post-call, ` +
        `${skipped.mismaTanda} de la misma tanda, ${skipped.mismoMinuto} duplicadas)`
    );
  }

  return preview ? superseded.length : cancelados;
}

// ─── Entrega de Push 3 vencidos ───────────────────────────────────────────────
// Bug #1 (doble envío): la librería `cron` NO previene ejecuciones solapadas. Si
// un lote tarda >1 min, dos ticks podrían leer las mismas filas. Defensa en dos
// capas: (1) guard de reentrada `_delivering`; (2) claim atómico por fila
// (status 'scheduled' → 'sending') que solo procede si ESTE worker la reclamó.

let _delivering = false;

export async function runCalendlyDelivery() {
  if (_delivering) {
    console.log('[Calendly] deliver: ya hay una entrega en curso, salto este tick');
    return 0;
  }
  _delivering = true;
  try {
    const d = await deps();
    // Antes de leer nada: rescatar lo que dejó huérfano un proceso caído (ver
    // reclaimStuckCalendlyPushes en src/db/index.js). Va ACÁ y no en el arranque porque acá es
    // donde se sabe que no hay ningún tick en vuelo —`_delivering` lo garantiza—, así que no
    // puede revivir una fila que alguien esté enviando en este instante. Lo que revive vuelve
    // a 'scheduled' y entra en el mismo lote, con todos sus gates: si la llamada ya pasó, el
    // guard de obsolescencia la marca 'skipped'. Enterrarla con su motivo también es ganar;
    // lo que no se puede es dejarla en un estado que nadie mira.
    if (d.reclaimStuckCalendlyPushes) {
      const rescatadas = d.reclaimStuckCalendlyPushes();
      if (rescatadas)
        console.warn(`[Calendly] ${rescatadas} push(es) atascado(s) en 'sending' devueltos a 'scheduled' (proceso caído a mitad de entrega)`);
    }
    const due = d.getDueCalendlyPushes();
    let procesados = 0;
    for (const p of due) {
      // Claim atómico: si otro worker ya la tomó, claim devuelve false → saltar.
      if (d.claimCalendlyPush && !d.claimCalendlyPush(p.id)) continue;
      try {
        // ─── Push 4: registro de outcome post-call (§18.AB) ──────────────────
        // INVIERTE el guard de obsolescencia: este push es JUSTAMENTE post-call
        // (due = start + duración + gracia), así que NO se salta por "ya pasó".
        if (p.push_n === 4) {
          let ev4 = null;
          // Los uuids sintéticos de reagenda (§18.AC) no existen en Calendly — es una call
          // que nos dictó el closer. Ni se consulta la API: se pregunta con lo guardado.
          if (!isManualUuid(p.event_uuid)) {
            const uri4 = `https://api.calendly.com/scheduled_events/${p.event_uuid}`;
            try {
              ev4 = await d.getEvent(uri4);
            } catch {
              /* si la verificación falla, preguntamos igual con lo guardado */
            }
          }
          // Cancelada → outcome AUTOMÁTICO, sin molestar al closer.
          if (ev4 && ev4.status === 'canceled') {
            if (d.recordAutoOutcome)
              d.recordAutoOutcome({
                event_uuid: p.event_uuid,
                program: p.program,
                closer_email: p.closer_email,
                closer_phone: p.closer_phone,
                closer_name: resolveCloser(p.closer_email)?.name || null,
                lead_name: p.prospect_name,
                lead_phone: p.prospect_phone,
                call_start: p.call_start,
                asistencia: 'cancelado',
              });
            d.markCalendlyPushSent(p.id);
            console.log(`[Calendly] Push 4 #${p.id}: cita cancelada → outcome auto (no se pregunta)`);
            continue;
          }
          // Reagendada a otra hora → no preguntar ahora; el poll reagenda el Push 4.
          if (ev4 && ev4.status === 'active' && toSqliteUtc(new Date(ev4.start_time)) !== p.call_start) {
            d.markCalendlyPushSkipped(p.id, 'reagendada (el poll reagenda el push 4)', SKIP_SLUGS.REAGENDADA);
            console.log(`[Calendly] Push 4 #${p.id} omitido: reagendada`);
            continue;
          }

          // ── Modelo nudge/cosecha (§18.AF/AG): programas cubiertos por HubSpot ──
          // Con HARVEST: lee `agenda_status` y DERIVA el outcome a call_outcomes sin preguntar
          // (show/no-show/reagenda/cancel); solo pica al closer si la call venció y sigue
          // "Programada". Con NUDGE (sin harvest): modelo por etapa. Cae a Push 4 clásico ante
          // cualquier duda (programa no cubierto, sin email, error, estado no clasificable).
          let outcomeMsg = null; // si queda != null, es el texto del nudge
          let remindedFlag = 0; // el nudge lo pone en 1 → suprime el recordatorio clásico
          if (
            (NUDGE_ENABLED() || HARVEST_ENABLED()) &&
            d.hubspotEnabled?.() &&
            !isManualUuid(p.event_uuid) &&
            isCoveredProgram(p.program)
          ) {
            const plan = await planNudge(d, p);
            // §18.AG — cosecha directa: registra el outcome desde HubSpot, sin preguntar.
            // §18.AG+venta — eje aparte de la asistencia: un 'show' con el deal ya en la
            // etapa Ganado cosecha también el resultado, para que el conteo de ventas no
            // salga corto en los programas cosechados en silencio (sin esto dependía de
            // que el closer, ya sin nada que contestar, lo cargara aparte — no pasaba).
            if (plan.handled && plan.harvest) {
              const resultado = plan.harvest === 'show' && plan.won ? 'venta_cerrada' : null;
              if (d.recordAutoOutcome)
                d.recordAutoOutcome(pendingOutcomeFrom(p, { asistencia: plan.harvest, resultado }));
              d.markCalendlyPushSent(p.id);
              console.log(
                `[Calendly] Push 4 #${p.id}: agenda_status=${plan.reason} → outcome '${plan.harvest}'${resultado ? ` + resultado='${resultado}'` : ''} cosechado de HubSpot (sin preguntar)`
              );
              procesados++;
              continue;
            }
            // §18.AG — reagenda registrada en HubSpot: cosecha 'reagendado' + agenda la call
            // nueva desde hs_next_meeting_start_time (mismo mecanismo que la reagenda manual).
            if (plan.handled && plan.reschedule) {
              let extra = '';
              let agendada = false;
              const startMs = Date.parse(plan.nextMeetingStart || '');
              if (RESCHEDULE_ENABLED() && startMs && startMs > d.now()) {
                const rp = planRescheduledPushes(pendingOutcomeFrom(p), new Date(startMs), {
                  nowMs: d.now(),
                  leadMin: RESCHED_LEAD_MIN(),
                  durationMin: CALL_DURATION_MIN(),
                  graceMin: PUSH4_GRACE_MIN(),
                  maxChain: RESCHED_MAX_CHAIN(),
                });
                if (rp.ok) {
                  for (const push of rp.pushes) d.scheduleCalendlyPush(push);
                  extra = ` → nueva call agendada (${rp.pushes.map((x) => `push${x.push_n}`).join(', ')})`;
                  agendada = true;
                } else {
                  extra = ` → no agendé la nueva (${rp.reason})`;
                }
              }
              // Sin fecha nueva utilizable, la reagenda NO se cierra: se le pide la fecha al
              // closer, exactamente igual que cuando la dicta él por WhatsApp. Antes acá había
              // un recordAutoOutcome + markSent que la cerraba muda, y como
              // `hs_next_meeting_start_time` viene vacío en 397 de 400 deals, ese era el camino
              // NORMAL, no el borde: 5 de 5 reagendas cosechadas murieron ahí sin una sola
              // repregunta (§18.AN). El cron de las 9am (runReschedulePrompts) las recoge.
              if (!agendada && RESCHEDULE_ENABLED() && d.recordRescheduleAwaitingDate) {
                d.recordRescheduleAwaitingDate(pendingOutcomeFrom(p));
                extra += ' → le pido la fecha al closer';
              } else if (d.recordAutoOutcome) {
                d.recordAutoOutcome(pendingOutcomeFrom(p, { asistencia: 'reagendado' }));
              }
              d.markCalendlyPushSent(p.id);
              console.log(`[Calendly] Push 4 #${p.id}: agenda_status=RESCHEDULED → reagenda cosechada${extra}`);
              procesados++;
              continue;
            }
            if (plan.handled && plan.silent) {
              // El closer ya avanzó el deal / hay cita futura → no molestar. Sin pendiente.
              d.markCalendlyPushSent(p.id);
              console.log(`[Calendly] Push 4 #${p.id}: deal ya actualizado en HubSpot (${plan.reason}) → sin preguntar`);
              procesados++;
              continue;
            }
            if (plan.handled) {
              outcomeMsg = plan.message; // nudge_update / nudge_create
              remindedFlag = 1;
            }
          }

          // Mensaje: el nudge (si aplicó) o la pregunta clásica de Push 4.
          const startIso4 = ev4?.start_time || `${p.call_start.replace(' ', 'T')}Z`;
          const msg4 =
            outcomeMsg ||
            buildPush4Message({
              name: fullNameFrom(p.prospect_name),
              firstName: firstNameFrom(p.prospect_name),
              startIso: startIso4,
            });
          const r4 = await deliver(d, p.closer_phone, msg4, 'push4', p.closer_email);
          if (r4 === 'sent') {
            // El push se marca enviado y el pendiente se abre en UNA transaccion: al closer
            // YA se le pregunto, asi que su respuesta (incl. una reagenda) tiene que tener
            // donde caer (getActiveOutcomeForCloser). Si la escritura falla, el push queda
            // 'scheduled' y el ciclo siguiente lo reintenta; antes quedaba 'sent' con la
            // pregunta hecha al vacio y la respuesta sin donde aterrizar.
            if (d.marcarPush4Preguntado) {
              d.marcarPush4Preguntado(p.id, pendingOutcomeFrom(p, { reminded: remindedFlag }));
            } else {
              d.markCalendlyPushSent(p.id);
              if (d.createPendingOutcome)
                d.createPendingOutcome(pendingOutcomeFrom(p, { reminded: remindedFlag }));
            }
          } else if (r4 === 'dry-run') {
            // DRY-RUN NO ABRE EL PENDIENTE. El push si se marca: `calendly_pushes` es el
            // ledger del propio job y sin eso el Push 4 se reintentaria para siempre (sale
            // antes del guard de obsolescencia). Pero `call_outcomes` es DATO OPERATIVO: una
            // fila abierta a nadie caduca sola como 'no_answer' a los ~60 min y entra al
            // reporte como "el closer no registro la call". O sea que una cuenta muda
            // ensuciaba las metricas de cumplimiento con calls que jamas se preguntaron.
            d.markCalendlyPushSent(p.id);
            console.log(
              `[Calendly] Push 4 #${p.id} [DRY-RUN]: no se abre pendiente (nadie fue preguntado)`
            );
          } else if (r4 === 'paused' || r4 === 'paused-closer') {
            if (d.revertCalendlyPush) d.revertCalendlyPush(p.id); // reintentar al despausar
          } else if (r4 === 'skipped-no-thread') {
            d.markCalendlyPushSkipped(p.id, 'sin hilo establecido (contact_jid)', SKIP_SLUGS.SIN_HILO);
          } else {
            d.markCalendlyPushSkipped(p.id, 'closer sin opt-in', SKIP_SLUGS.SIN_OPTIN);
          }
          procesados++;
          continue;
        }

        // ─── Push 5: recordatorio de llenar los Sheets (§18.AP) ──────────────
        // Va ACÁ, antes del guard de obsolescencia, y termina en `continue`. No es
        // cuestión de estilo: el guard descarta todo push cuya call ya empezó, y este
        // vence DESPUÉS de que terminó, así que si lo alcanzara se marcaría 'skipped'
        // siempre y no se enviaría nunca. Es la misma maniobra del Push 4 de arriba
        // (salir antes), no una excepción dentro del guard: el guard no se toca.
        if (p.push_n === 5) {
          // Cancelada o movida → no pedir que registre una call que no pasó. Los uuids
          // sintéticos de reagenda no existen en Calendly: no se consultan.
          let ev5 = null;
          if (!isManualUuid(p.event_uuid)) {
            try {
              ev5 = await d.getEvent(`https://api.calendly.com/scheduled_events/${p.event_uuid}`);
            } catch {
              /* si la verificación falla, mandamos igual con lo guardado */
            }
          }
          if (ev5 && ev5.status !== 'active') {
            d.markCalendlyPushSkipped(p.id, `cita ${ev5.status}`, SKIP_SLUGS.CANCELADA);
            console.log(`[Calendly] Push 5 #${p.id} omitido: cita ${ev5.status}`);
            continue;
          }
          if (ev5 && toSqliteUtc(new Date(ev5.start_time)) !== p.call_start) {
            d.markCalendlyPushSkipped(p.id, 'reagendada (el poll agendará la nueva hora)', SKIP_SLUGS.REAGENDADA);
            console.log(`[Calendly] Push 5 #${p.id} omitido: reagendada`);
            continue;
          }

          // Reconstruido acá, no `p.message`, por lo mismo que los demás pushes: un cambio
          // de copy o de link no llega a las filas ya agendadas (decidePushAction devuelve
          // 'unchanged' mientras la hora no cambie). Los sheets salen de la cuenta del
          // CLOSER, igual que el dry-run.
          const acct5 = accountOf(accountOfCloser(p.closer_email));
          const msg5 = buildPush5Message({
            name: fullNameFrom(p.prospect_name),
            firstName: firstNameFrom(p.prospect_name),
            startIso: ev5?.start_time || `${p.call_start.replace(' ', 'T')}Z`,
            sheets: acct5?.sheets || [],
          });
          const r5 = await deliver(d, p.closer_phone, msg5, 'push5', p.closer_email);
          if (r5 === 'sent' || r5 === 'dry-run') {
            d.markCalendlyPushSent(p.id);
          } else if (r5 === 'paused' || r5 === 'paused-closer') {
            if (d.revertCalendlyPush) d.revertCalendlyPush(p.id); // reintentar al despausar
          } else if (r5 === 'skipped-no-thread') {
            d.markCalendlyPushSkipped(p.id, 'sin hilo establecido (contact_jid)', SKIP_SLUGS.SIN_HILO);
          } else {
            d.markCalendlyPushSkipped(p.id, 'closer sin opt-in', SKIP_SLUGS.SIN_OPTIN);
          }
          procesados++;
          continue;
        }

        // Guard de obsolescencia: si la llamada YA empezó, el recordatorio no sirve.
        // Cubre pushes que quedaron 'scheduled' por una pausa (botón de pánico) o una
        // caída de WhatsApp y se vaciarían en lote al reanudar. Comparación lexical de
        // strings UTC 'YYYY-MM-DD HH:MM:SS' = comparación cronológica. (Los digests
        // Push 1/2 no pasan por aquí; se calculan a hora fija por cron.)
        if (toSqliteUtc(new Date(d.now())) >= p.call_start) {
          d.markCalendlyPushSkipped(p.id, 'llamada ya pasó (push obsoleto)', SKIP_SLUGS.OBSOLETO);
          console.log(`[Calendly] Push ${p.push_n} #${p.id} omitido: llamada ya pasó (${p.call_start} UTC)`);
          continue;
        }
        // Re-validar: la cita pudo cancelarse o reagendarse después de agendar el push.
        const uri = `https://api.calendly.com/scheduled_events/${p.event_uuid}`;
        let ev = null;
        try {
          ev = await d.getEvent(uri);
        } catch {
          /* si la verificación falla, entregamos igual para no perder el push */
        }
        if (ev) {
          if (ev.status !== 'active') {
            d.markCalendlyPushSkipped(p.id, `cita ${ev.status}`, SKIP_SLUGS.CANCELADA);
            console.log(`[Calendly] Push 3 #${p.id} omitido: cita ${ev.status}`);
            continue;
          }
          if (toSqliteUtc(new Date(ev.start_time)) !== p.call_start) {
            d.markCalendlyPushSkipped(p.id, 'reagendada', SKIP_SLUGS.REAGENDADA);
            console.log(`[Calendly] Push 3 #${p.id} omitido: reagendada (el poll agendará la nueva hora)`);
            continue;
          }
        }

        // El mensaje se reconstruye AQUÍ (no se usa el `p.message` guardado en el
        // poll) por dos razones: (1) el `join_url` de la llamada puede no haber
        // estado listo al agendar (google_conference pasa por 'processing' antes de
        // 'pushed') y al entregar ya lo está; (2) un cambio de template tras un
        // deploy NO se propaga a filas ya agendadas — `decidePushAction` devuelve
        // 'unchanged' mientras la hora no cambie, así que el mensaje quedaba congelado
        // al texto del código viejo. Reconstruir con el `ev` fresco arregla ambos y
        // sana solo las filas viejas. Sin `ev` (getEvent falló) caemos al guardado.
        let message = p.message;
        if (ev) {
          const closer = resolveCloser(p.closer_email);
          // El teléfono pudo quedar null al agendar (Calendly sin número Y HubSpot aún sin
          // el contacto/teléfono en ESE instante). Los digests Push 1/2 lo re-resuelven en
          // vivo cada mañana, pero el Push 3/0 usaba el `prospect_phone` CONGELADO del poll
          // → salía "sin teléfono, mándalo manual" aunque HubSpot ya lo tenga. Reintentar el
          // fallback AQUÍ (solo si sigue vacío) sana la fila sin costo extra en el caso normal.
          // Guardrail por empresa: la cuenta del CLOSER (accountOfCloser) decide si se busca
          // en el HubSpot conectado — igual que el resto del flujo de envío.
          let phone = p.prospect_phone;
          if (!phone) {
            try {
              const acct = accountOf(accountOfCloser(p.closer_email));
              const invitee = await d.getFirstInvitee(ev.uri, { token: acct?.token?.() });
              phone = await resolvePhone(d, invitee, acct);
            } catch {
              /* sin invitee → queda null → "mándalo manual", exactamente como hoy */
            }
          }
          message =
            p.push_n === 0
              ? buildPush0Message({
                  name: fullNameFrom(p.prospect_name),
                  firstName: firstNameFrom(p.prospect_name),
                  phone,
                  startIso: ev.start_time,
                  programKey: programKeyOf(ev.event_type),
                  // El `when` se recalcula ACÁ, no se hereda de cuando se agendó la
                  // fila: este bloque corre al entregar, y un Push 0 de "mañana"
                  // que se re-arma pasada la medianoche ya es de "hoy".
                  // El reloj va por `d.now()` (inyectable), NO por Date.now(): con el
                  // reloj del sistema el harness comparaba contra la fecha real y
                  // todo Push 0 salía como "mañana".
                  when: isSameDayInTz(ev.start_time, TZ(), new Date(d.now())) ? 'hoy' : 'mañana',
                })
              : buildPush3Message({
                  name: fullNameFrom(p.prospect_name),
                  firstName: firstNameFrom(p.prospect_name),
                  phone,
                  startIso: ev.start_time,
                  programKey: programKeyOf(ev.event_type),
                  closer: closer ? firstNameFrom(closer.name) : '',
                  linkLlamada: eventJoinUrl(ev),
                });
        }

        const result = await deliver(d, p.closer_phone, message, `push${p.push_n}`, p.closer_email);
        if (result === 'sent' || result === 'dry-run') {
          d.markCalendlyPushSent(p.id);
        } else if (result === 'paused' || result === 'paused-closer') {
          // Pausa = botón de pánico TEMPORAL: no consumir el push. Revertir a
          // 'scheduled' para reanudar al despausar (la llamada puede seguir en el futuro).
          if (d.revertCalendlyPush) d.revertCalendlyPush(p.id);
        } else if (result === 'skipped-optin' || result === 'skipped-no-thread') {
          // Falta de opt-in / de hilo es TRANSITORIA: el closer puede escribirle a Juanito
          // cinco minutos después. Antes se quemaba el push en el primer intento y ni
          // arreglar la causa lo revivía (`decidePushAction` → 'inactive-status'). Se
          // revierte a 'scheduled' y se reintenta al minuto siguiente, igual que la pausa.
          //
          // El reintento está ACOTADO por el guard de obsolescencia de arriba, que mata la
          // fila apenas la llamada empieza: techo de ~LEAD_MIN intentos. Por eso esto vale
          // SOLO para push 0/3, que pasan por el guard — push 4 y 5 salen antes con
          // `continue` y revertirlos los volvería filas inmortales.
          if (d.revertCalendlyPush) d.revertCalendlyPush(p.id);
        } else {
          // Cualquier resultado no contemplado. Antes caía acá y se etiquetaba como
          // 'closer sin opt-in', que ensuciaba el diagnóstico con una causa falsa.
          d.markCalendlyPushSkipped(p.id, `resultado inesperado: ${result}`, SKIP_SLUGS.INESPERADO);
          console.warn(`[Calendly] Push ${p.push_n} #${p.id}: resultado inesperado "${result}"`);
        }
        procesados++;
      } catch (e) {
        // Falló el envío (ej. WA caído): devolver a 'scheduled' para reintentar.
        if (d.revertCalendlyPush) d.revertCalendlyPush(p.id);
        console.error(`[Calendly] Error entregando push 3 #${p.id}:`, e.message);
      }
    }
    return procesados;
  } finally {
    _delivering = false;
  }
}

// ─── Digests Push 1 / Push 2 ──────────────────────────────────────────────────

function whenLabel(offsetDays, nowMs = Date.now()) {
  const base = new Date(nowMs + offsetDays * 86400000);
  const fmt = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ(),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(base);
  return offsetDays === 1 ? `mañana (${fmt})` : `hoy (${fmt})`;
}

// Las citas que un closer agenda A MANO dentro del CRM no existen en Calendly, así que
// `listEventsAllAccounts` no las ve y el digest las omitía (§18.AU). No era un hueco menor:
// medido el 2026-07-29, el Push 2 listó 27 citas cuando el día tenía 43 calls vivas — 14 calls
// de 6 closers distintos sin ningún aviso anticipado. El closer solo se enteraba con el Push 3,
// 25 minutos antes, porque `agenda-poll.js` sí las levanta para el precall. La agenda del jefe
// SÍ las contaba (lee `calendly_pushes`, no Calendly), y de ahí la asimetría que lo destapó:
// el jefe veía más calls que las que el propio closer tenía en su lista.
//
// Se reusa `pickMeetingsToSchedule` en vez de filtrar acá: trae los tres guardarraíles ya
// medidos (programa de esta empresa, horario laboral, duplicados dentro del CRM) y —lo que
// importa— la MISMA clave de dedup que el resto del sistema. Si el digest deduplicara distinto,
// una call podría salir en el digest y no tener push, o al revés.
//
// Falla suave a propósito: HubSpot apagado o caído devuelve [] y el digest sale con lo de
// Calendly, exactamente como antes. Perder el complemento no puede costar el digest entero.
async function hubspotDigestItems(d, { calendlyCalls, minStartIso, maxStartIso, pushN }) {
  if (!d.searchMeetingsInWindow || !d.getOwnerEmailMap) return [];
  if (d.hubspotEnabled && !d.hubspotEnabled()) return [];
  try {
    const [meetings, ownerEmailById] = await Promise.all([
      d.searchMeetingsInWindow({ fromIso: minStartIso, untilIso: maxStartIso }),
      d.getOwnerEmailMap(),
    ]);
    const hubspotCalls = meetingsToCalls(meetings, {
      ownerEmailById,
      ownerToCloser: HUBSPOT_OWNER_TO_CLOSER,
    });
    const { toSchedule } = pickMeetingsToSchedule({
      hubspotCalls,
      existingCalls: calendlyCalls,
      tz: TZ(),
    });

    const items = [];
    for (const call of toSchedule) {
      const startIso = callStartToIso(call.call_start);
      if (!startIso) continue;
      // El lead sale del contacto asociado, no del título ("Entrevista de Postulación…"), que
      // como nombre de prospecto no sirve y dejaría la línea del digest sin número.
      let contacto = null;
      try {
        contacto = d.getMeetingContact ? await d.getMeetingContact(call.meeting_id) : null;
      } catch {
        /* sin contacto igual listamos la cita: saberla es más valioso que su teléfono */
      }
      items.push({
        closerEmail: call.closer_email,
        item: {
          name: fullNameFrom(contacto?.name) || null,
          firstName: firstNameFrom(contacto?.name) || '',
          phone: contacto?.phone || null,
          startIso,
          programKey: call.program,
        },
      });
    }
    if (items.length) {
      console.log(`[HubSpot] digest push${pushN}: +${items.length} cita(s) que no están en Calendly`);
    }
    return items;
  } catch (e) {
    console.error(`[HubSpot] digest push${pushN}: no pude sumar las citas del CRM:`, e.message);
    return [];
  }
}

async function runDigest(pushN, offsetDays) {
  const d = await deps();
  const nowMs = d.now();
  const { minStartIso, maxStartIso } = dayRangeUtc(TZ(), offsetDays, new Date(nowMs));

  // Una cuenta caída no puede dejar sin digest a la otra → se listan por separado.
  const { events, failed } = await listEventsAllAccounts(d, {
    minStartIso,
    maxStartIso,
    tag: `digest push${pushN}`,
  });
  // Calendly caído entero → no se manda nada. Con HubSpot como segunda fuente la tentación es
  // mandar igual, pero ese digest diría "tienes 2 llamadas" a un closer que tiene 8: un conteo
  // incompleto que se lee como completo es peor que no mandar.
  if (failed && !events.length) return 0;

  const byCloser = new Map(); // phone -> { name, email, items[] }
  const calendlyCalls = []; // { closer_email, call_start } — para deduplicar contra HubSpot
  for (const { ev, account } of events) {
    const email = closerEmailOf(ev);
    const closer = resolveCloser(email);
    if (!closer) {
      if (isIgnoredCloser(email)) continue; // host conocido, no gestionado aún → silencio
      recordUnmapped(email);
      console.warn(`[Calendly] digest push${pushN}: sin closer para "${email}" — omito cita`);
      await notifyAdmins(d, `Closer sin mapear en Calendly: ${email}. Esa(s) cita(s) no recibirán pushes — agrégalo a src/calendly/closers.js.`, `unmapped:${email}`);
      continue;
    }
    let invitee = null;
    try {
      invitee = await d.getFirstInvitee(ev.uri, { token: account.token() });
    } catch {
      /* sin invitee igual listamos la cita */
    }
    if (!byCloser.has(closer.phone))
      byCloser.set(closer.phone, { name: closer.name, email, items: [] });
    byCloser.get(closer.phone).items.push({
      name: fullNameFrom(invitee?.name),
      firstName: firstNameFrom(invitee?.name),
      phone: await resolvePhone(d, invitee, account),
      startIso: ev.start_time,
      programKey: programKeyOf(ev.event_type),
    });
    calendlyCalls.push({ closer_email: email, call_start: toSqliteUtc(new Date(ev.start_time)) });
  }

  // Segunda fuente: las citas que solo viven en el CRM. Se suman al MISMO mapa, así que el
  // mensaje sale idéntico —ordenado por hora y agrupado por programa— sin distinguir origen:
  // al closer le da igual por dónde entró la cita, lo que necesita es la lista completa.
  for (const { closerEmail, item } of await hubspotDigestItems(d, {
    calendlyCalls,
    minStartIso,
    maxStartIso,
    pushN,
  })) {
    const closer = resolveCloser(closerEmail);
    if (!closer) continue; // HUBSPOT_OWNER_TO_CLOSER ya lo garantiza; defensivo
    if (!byCloser.has(closer.phone))
      byCloser.set(closer.phone, { name: closer.name, email: closerEmail, items: [] });
    byCloser.get(closer.phone).items.push(item);
  }

  const desc = pushN === 1 ? 'la noche anterior' : 'en la mañana';
  const label = `Push ${pushN} (${desc})`;
  const when = whenLabel(offsetDays, nowMs);
  for (const [phone, { name, email, items }] of byCloser) {
    const msg = buildDigestMessage({
      pushLabel: label,
      whenLabel: when,
      items,
      pushN,
      closer: firstNameFrom(name),
    });
    await deliver(d, phone, msg, `push${pushN}`, email);
  }

  // Se loguea el total REAL enviado y, aparte, cuántas vinieron del CRM: el log viejo decía
  // `events.length` (solo Calendly) y por eso el hueco de las citas de HubSpot era invisible
  // justo en la línea donde se habría notado.
  const totalCitas = [...byCloser.values()].reduce((n, c) => n + c.items.length, 0);
  // Contra `calendlyCalls` y no contra `events`: los eventos de un closer sin mapear se
  // descartaron arriba y nunca llegaron al mensaje, así que restarlos daría un número negativo.
  const delCrm = totalCitas - calendlyCalls.length;
  console.log(
    `[Calendly] Digest ${label}: ${byCloser.size} closers, ${totalCitas} citas` +
      `${delCrm > 0 ? ` (${calendlyCalls.length} de Calendly + ${delCrm} solo en HubSpot)` : ''}` +
      `${DRY_RUN() ? ' [DRY-RUN]' : ''}`
  );
  return byCloser.size;
}

export const runPush1 = () => runDigest(1, 1); // mañana
export const runPush2 = () => runDigest(2, 0); // hoy

// ─── Agenda diaria a la admin de la marca (7am) ────────────────────────────────
// Pedido de Alejandro (2026-08-25) para Mariana: cuántas llamadas tiene HOY cada closer de IA
// para Abogados. No es un digest de closer —no lleva nombres ni teléfonos de leads, solo el
// conteo— sino la foto de carga del día para quien supervisa.
//
// ⚠️ Usa la MISMA doble fuente que el digest Push 1/2 (Calendly + las citas que solo viven en
// el CRM) y no solo Calendly. Contar únicamente Calendly repetiría exactamente el hueco de
// §18.AU: medido el 2026-07-29, el Push 2 listó 27 citas cuando el día tenía 43 vivas. Un
// conteo incompleto que se lee como completo es peor que no mandar nada — y acá el que lo lee
// toma decisiones de equipo con ese número.
//
// El dry-run de la conexión NO aplica: es un DM a un tercero, no un envío a un closer. Lo que
// sí aplica es el gate anti-ban de hilo previo.
async function runAdminAgenda() {
  const recipients = ADMIN_AGENDA_DM();
  if (!recipients.length) return 0;

  const connKey = ADMIN_AGENDA_CONNECTION();
  const account = accountOf(connKey);
  if (!account || !account.token()) {
    console.warn(`[Agenda] conexión "${connKey}" sin token → agenda a la admin omitida`);
    return 0;
  }

  const d = await deps();
  const nowMs = d.now();
  const { minStartIso, maxStartIso } = dayRangeUtc(TZ(), 0, new Date(nowMs));

  // Solo la conexión de esta marca. `listProgramEvents` ya filtra a los programas de ESA
  // cuenta, así que las calls de 30x/retia no se cuelan aunque compartan closer.
  let evs = [];
  try {
    evs = await d.listProgramEvents({ minStartIso, maxStartIso, account });
  } catch (e) {
    // Calendly caído ⇒ no se manda. Igual que el digest: mejor sin mensaje que con un conteo
    // parcial que Mariana leería como la agenda completa.
    console.error(`[Agenda] Calendly falló para "${connKey}", no mando la agenda:`, e.message);
    return 0;
  }

  const calls = evs.map((ev) => ({ closerEmail: closerEmailOf(ev) }));
  const calendlyCalls = evs.map((ev) => ({
    closer_email: closerEmailOf(ev),
    call_start: toSqliteUtc(new Date(ev.start_time)),
  }));

  // Segunda fuente. Falla suave por dentro (HubSpot caído devuelve []), así que si se pierde el
  // complemento el mensaje sale con lo de Calendly — se avisa en el log, no en el mensaje.
  const delCrm = await hubspotDigestItems(d, {
    calendlyCalls,
    minStartIso,
    maxStartIso,
    pushN: 2,
  });
  // ⚠️ FILTRO POR CONEXIÓN (bug del 2026-08-25, detectado en el primer envío real).
  // `hubspotDigestItems` NO filtra por conexión: devuelve las citas de TODOS los closers del CRM.
  // En runDigest eso no molesta porque cada item se enruta a SU closer; acá, en cambio, todo cae
  // en UN tally acotado al roster de esta conexión, así que las calls de los closers de 30x se
  // iban al bucket de "sin mapear" y salían en el mensaje de la admin de EstadoX, con el correo
  // crudo, bajo el título "IA para Abogados". Se mandó así una vez: 10 de las 16 calls del
  // mensaje eran de Daniela, Marín, Lozano y Mendoza — de otros programas.
  // El bucket de "sin mapear" queda para lo que de verdad es un host desconocido, que es para lo
  // que existe.
  const delCrmPropias = delCrm.filter(({ closerEmail }) => accountOfCloser(closerEmail) === connKey);
  for (const { closerEmail } of delCrmPropias) calls.push({ closerEmail });

  // Roster = los closers de ESTA conexión. Se pasa entero para que uno sin calls salga con 0.
  const roster = Object.entries(CLOSERS)
    .filter(([email]) => accountOfCloser(email) === connKey)
    .map(([email, c]) => ({ email, name: c.name }));
  if (!roster.length) {
    console.warn(`[Agenda] la conexión "${connKey}" no tiene closers en el roster → omito`);
    return 0;
  }

  const dateLabel = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ(),
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(nowMs));

  const tally = tallyByCloser(calls, roster);
  const programLabel = [...new Set(Object.values(account.eventTypes).map(programLabelOf))].join(' + ');
  const msg = buildAgendaMessage({ tally, dateLabel, programLabel });

  let enviados = 0;
  for (const to of recipients) {
    if (d.hasDmThread && !d.hasDmThread(to)) {
      console.warn(`[Agenda] OMITIDO → ${to}: no tiene hilo con Juanito (anti-ban).`);
      continue;
    }
    try {
      await d.sendMessage(to, msg);
      enviados++;
    } catch (e) {
      console.error(`[Agenda] fallo enviando la agenda a ${to}:`, e.message);
    }
  }
  console.log(
    `[Agenda] ${connKey}: ${calls.length} call(s) hoy, ${roster.length} closer(s), ` +
      `enviada a ${enviados}/${recipients.length} destinatario(s)` +
      `${delCrmPropias.length ? ` (${calendlyCalls.length} de Calendly + ${delCrmPropias.length} solo en HubSpot)` : ''}` +
      `${delCrm.length - delCrmPropias.length ? ` [${delCrm.length - delCrmPropias.length} del CRM descartadas: son de otra conexión]` : ''}`
  );
  return enviados;
}

export { runAdminAgenda };

// ─── Insistencia + expiración de outcomes (§18.AB, cumplimiento v1) ────────────
// Un recordatorio a los outcomes sin responder pasados ~30 min; los que siguen sin
// respuesta ~30 min DESPUÉS del recordatorio quedan 'no_answer' ("sin registrar").
export async function runOutcomeReminders() {
  const d = await deps();
  const due = d.getDueOutcomeReminders ? d.getDueOutcomeReminders(OUTCOME_REMIND_AFTER_MIN()) : [];
  let sent = 0;
  for (const o of due) {
    const startIso = `${o.call_start.replace(' ', 'T')}Z`;
    const msg = buildOutcomeReminder({
      name: fullNameFrom(o.lead_name),
      firstName: firstNameFrom(o.lead_name),
      startIso,
    });
    const r = await deliver(d, o.closer_phone, msg, 'outcome-remind', o.closer_email);
    // Solo marcamos 'reminded' si de verdad salio; si estaba pausado/sin opt-in se
    // reintenta en el proximo tick (no se quema la unica insistencia de v1).
    //
    // 'dry-run' SI marca, y eso es deliberado: `reminded` es el ledger de ESTE job (sin el,
    // una cuenta muda repreguntaria cada tick hasta que la fila caduque). Lo que el dry-run
    // no hace es CREAR filas de call_outcomes — eso se corto en el Push 4, que es de donde
    // salian. Sin filas nuevas, este camino ya no se alimenta de una cuenta en dry-run.
    if (r === 'sent' || r === 'dry-run') {
      if (d.markOutcomeReminded) d.markOutcomeReminded(o.id);
      sent++;
    }
  }
  // Expira contra asked_at + (recordatorio + gracia) → garantiza la ventana posterior
  // al recordatorio antes de declarar "sin registrar".
  const expired = d.expireUnansweredOutcomes
    ? d.expireUnansweredOutcomes(OUTCOME_REMIND_AFTER_MIN() + OUTCOME_EXPIRE_AFTER_MIN())
    : { changes: 0 };
  if (sent || expired.changes) {
    console.log(
      `[Calendly] Outcomes: ${sent} recordatorio(s), ${expired.changes || 0} marcado(s) sin registrar${DRY_RUN() ? ' [DRY-RUN]' : ''}`
    );
  }
  return sent;
}

// ─── Insistencia por la fecha de una reagenda (§18.AC) ────────────────────────
// El closer dijo "reagendó" pero aún no sabía para cuándo. Una vez al día Juanito le
// vuelve a pedir la fecha; al tercer intento la reagenda se cierra sin fecha (cuenta como
// movida en el reporte y deja de ocupar la ventana de captura de ese closer).
export async function runReschedulePrompts() {
  const d = await deps();
  if (!d.getAwaitingDateOutcomes) return 0;

  const due = d.getAwaitingDateOutcomes({ maxAsked: RESCHEDULE_MAX_ASKED() });
  let sent = 0;
  for (const o of due) {
    const msg = buildReschedulePromptMessage({
      name: fullNameFrom(o.lead_name),
      firstName: firstNameFrom(o.lead_name),
    });
    const r = await deliver(d, o.closer_phone, msg, 'reagenda-fecha', o.closer_email);
    // Solo cuenta el intento si de verdad salió: si estaba pausado o sin opt-in, se
    // reintenta mañana en vez de quemar una de las tres insistencias.
    if (r === 'sent' || r === 'dry-run') {
      if (d.markReschedulePrompted) d.markReschedulePrompted(o.id);
      sent++;
    }
  }

  const expired = d.expireAwaitingDateOutcomes
    ? d.expireAwaitingDateOutcomes({ maxAsked: RESCHEDULE_MAX_ASKED() })
    : { changes: 0 };
  if (sent || expired.changes) {
    console.log(
      `[Calendly] Reagendas sin fecha: ${sent} repregunta(s), ${expired.changes || 0} cerrada(s) sin fecha${DRY_RUN() ? ' [DRY-RUN]' : ''}`
    );
  }
  return sent;
}

// ─── Barrido periódico de cosecha (§18.AH) ────────────────────────────────────
// El harvest de planNudge es una sola foto en el momento del Push 4 (call_end + gracia).
// Si el closer todavía no había actualizado el deal en HubSpot en ese instante, la fila
// cae al nudge y —sin respuesta por WhatsApp— cierra sola como 'no_answer' 30 min después,
// sin que nadie vuelva a mirar HubSpot. Este job re-consulta esas filas abandonadas cada
// N horas (HARVEST_SWEEP_CRON): si para entonces el closer YA actualizó el deal, se recupera
// el outcome en silencio (sin re-mandar el nudge). Si sigue igual, se deja para el próximo
// barrido hasta el tope de `maxAgeHours` (después queda "sin registrar" definitivo).
export async function runHarvestSweep() {
  const d = await deps();
  if (!d.hubspotEnabled?.() || !d.getStaleHarvestCandidates || !d.applyHarvestedOutcome) return 0;

  const candidatos = d.getStaleHarvestCandidates({ maxAgeHours: HARVEST_SWEEP_MAX_AGE_HOURS() });
  let recuperados = 0;
  for (const o of candidatos) {
    if (!isCoveredProgram(o.program)) continue;

    // Reconstruye un "push" a partir de la fila guardada: planNudge solo necesita
    // event_uuid (para pedirle el invitee a Calendly), program y los datos del lead/closer.
    const pseudoP = {
      event_uuid: o.event_uuid,
      program: o.program,
      closer_email: o.closer_email,
      closer_phone: o.closer_phone,
      prospect_name: o.lead_name,
      prospect_phone: o.lead_phone,
      call_start: o.call_start,
    };

    let plan;
    try {
      plan = await planNudge(d, pseudoP);
    } catch (e) {
      console.error(`[Calendly] harvest-sweep #${o.id}: error re-consultando HubSpot:`, e.message);
      continue;
    }

    if (plan.handled && plan.harvest) {
      const resultado = plan.harvest === 'show' && plan.won ? 'venta_cerrada' : null;
      d.applyHarvestedOutcome(o.id, { asistencia: plan.harvest, resultado });
      recuperados++;
      console.log(
        `[Calendly] harvest-sweep #${o.id}: agenda_status=${plan.reason} → '${plan.harvest}'${resultado ? ` + resultado='${resultado}'` : ''} recuperado (el closer ya había actualizado HubSpot)`
      );
      continue;
    }

    if (plan.handled && plan.reschedule) {
      d.applyHarvestedOutcome(o.id, { asistencia: 'reagendado' });
      recuperados++;
      const startMs = Date.parse(plan.nextMeetingStart || '');
      if (RESCHEDULE_ENABLED() && startMs && startMs > d.now()) {
        const rp = planRescheduledPushes(pendingOutcomeFrom(pseudoP), new Date(startMs), {
          nowMs: d.now(),
          leadMin: RESCHED_LEAD_MIN(),
          durationMin: CALL_DURATION_MIN(),
          graceMin: PUSH4_GRACE_MIN(),
          maxChain: RESCHED_MAX_CHAIN(),
        });
        if (rp.ok) for (const push of rp.pushes) d.scheduleCalendlyPush(push);
      }
      console.log(`[Calendly] harvest-sweep #${o.id}: RESCHEDULED → reagenda recuperada`);
      continue;
    }

    // silent / nudge / ask / uncovered → el closer sigue sin actualizar (o el deal no da
    // estado claro). No se reintenta el mensaje de WhatsApp: se deja para el próximo barrido.
  }

  if (recuperados) {
    console.log(`[Calendly] Harvest sweep: ${recuperados} outcome(s) recuperado(s) de closers que actualizaron HubSpot tarde`);
  }
  return recuperados;
}

// ─── Arranque de los jobs ─────────────────────────────────────────────────────

// ─── Auditoría de skips: avisar cuando un closer pierde pushes ────────────────
// Cierra el pendiente de "detectar pushes que no salen sin depender del reporte del closer".
// Corre cada hora sobre una ventana de 24h y solo mira las causas ACCIONABLES: cancelaciones,
// reagendas y duplicados son operación normal y alertar por ellas volvería esto ruido.
//
// Es la red de seguridad, no la defensa principal: lo que se puede curar solo (falta de opt-in
// antes de la call) ya se reintenta en el bucle de entrega. Acá cae lo que ya no tiene arreglo
// automático y necesita que un humano mire.
// ¿La causa de este skip YA SE CURÓ? Un push perdido no se recupera nunca, pero su CAUSA sí
// puede haber desaparecido, y avisar de una causa que ya no existe es peor que no avisar: manda
// a diagnosticar algo que está bien.
//
// 🩸 El caso que lo motivó (2026-08-26): a Dana se le perdieron dos pushes de madrugada por no
// tener opt-in; escribió a Juanito a las 14:28 y quedó registrada. La alerta siguió diciendo
// "el closer no ha escrito a Juanito" durante horas, porque `skip_reason` es la etiqueta
// CONGELADA en el momento del skip y la auditoría la leía como si fuera el estado de ahora.
//
// Solo se curan las causas que se pueden VERIFICAR contra el estado vivo: las de registro.
// `obsoleto` e `inesperado` NO se curan aunque el closer se registre después — puede que la
// causa fuera esa, pero puede que fuera WhatsApp caído o el bot reiniciándose, y borrar en
// silencio "a este lead se le perdió su precall" por una corazonada es justo lo que esta
// auditoría existe para impedir. Ante la duda, se avisa.
function curado(d, closerEmail, slug) {
  if (slug !== SKIP_SLUGS.SIN_OPTIN && slug !== SKIP_SLUGS.SIN_HILO) return false;
  const phone = resolveCloser(closerEmail)?.phone;
  if (!phone) return false; // fuera del roster: no hay con qué verificar nada
  if (slug === SKIP_SLUGS.SIN_OPTIN) return !!d.isOptedIn?.(phone);
  return !!d.getOptin?.(phone)?.contact_jid;
}

export async function runSkipAudit() {
  const d = await deps();
  if (!d.getSkipsAlertablesPorCloser) return 0; // job inerte si la DB no expone la consulta
  const minimo = SKIP_ALERT_MIN();
  const filas = d.getSkipsAlertablesPorCloser([...SKIP_ALERTABLES], 24);

  // Se agrupa acá y no en SQL porque antes hay que descartar los motivos YA CURADOS.
  const porCloser = new Map();
  for (const f of filas) {
    if (curado(d, f.closer_email, f.skip_reason)) continue;
    const e = porCloser.get(f.closer_email) || { closer_email: f.closer_email, n: 0, motivos: [], ejemplo: null };
    e.n += f.n;
    e.motivos.push(f.skip_reason);
    e.ejemplo = e.ejemplo || f.ejemplo;
    porCloser.set(f.closer_email, e);
  }

  let avisados = 0;
  for (const f of [...porCloser.values()].sort((a, b) => b.n - a.n)) {
    if (f.n < minimo) continue;
    const nombre = resolveCloser(f.closer_email)?.name || f.closer_email;
    const motivos = f.motivos.map((s) => ETIQUETA_SKIP[s] || s).join(' · ');
    // La recomendación de revisar el roster solo tiene sentido si el problema ES de registro.
    // Colgarla de TODA alerta mandaba a revisar el teléfono de un closer cuyo teléfono nunca
    // fue el problema —pasó con Dana— y eso quema la credibilidad del aviso entero.
    const esDeRegistro = f.motivos.some((s) => s === SKIP_SLUGS.SIN_OPTIN || s === SKIP_SLUGS.SIN_HILO);
    await notifyAdmins(
      d,
      `${nombre}: ${f.n} push(es) NO entregados en 24h — ${motivos}. Ej: ${f.ejemplo || 's/d'}.` +
        (esDeRegistro
          ? ` Primero revisa que su teléfono en src/calendly/closers.js sea el mismo del hilo en calendly_optins.`
          : ''),
      `skips:${f.closer_email}`,
      { persistent: true } // es historia, no un fallo vivo: no re-avisar por cada reinicio
    );
    avisados++;
  }
  // Latido: loguea SIEMPRE, aunque no haya nada que reportar. Una red de seguridad que no se
  // puede ver correr no sirve de red — si este job se cayera en silencio, el modo de fallo
  // sería idéntico al que vino a resolver (nadie se entera de nada). Una línea por hora.
  if (avisados) console.warn(`[Calendly] auditoría de skips: ${avisados} closer(s) con pushes perdidos`);
  else console.log(`[Calendly] auditoría de skips ✅ nadie sobre el umbral (${filas.length} closer(s) con algún push perdido)`);
  return avisados;
}

export function startCalendlyJobs() {
  // Auto-desactivación: sin ninguna cuenta con token no hay nada que pollear.
  const accounts = activeAccounts();
  if (!accounts.length) {
    console.warn('[Calendly] ninguna cuenta con token — jobs de Calendly desactivados');
    return;
  }
  const tz = TZ();
  const job = (cron, fn, name) =>
    new CronJob(cron, () => fn().catch((e) => console.error(`[Calendly] ${name}:`, e.message)), null, true, tz);

  job(POLL_CRON(), runCalendlyPoll, 'poll');
  job(DELIVER_CRON(), runCalendlyDelivery, 'deliver');
  job(PUSH1_CRON(), runPush1, 'push1');
  job(PUSH2_CRON(), runPush2, 'push2');
  if (PUSH4_ENABLED()) job(OUTCOME_CRON(), runOutcomeReminders, 'outcomes');
  if (PUSH4_ENABLED() && RESCHEDULE_ENABLED())
    job(RESCHEDULE_PROMPT_CRON(), runReschedulePrompts, 'reagendas');
  if (HARVEST_ENABLED() && HARVEST_SWEEP_ENABLED())
    job(HARVEST_SWEEP_CRON(), runHarvestSweep, 'harvest-sweep');
  // Sin condición: la auditoría no depende de ninguna integración opcional y su valor está
  // justamente en correr siempre. Sin ADMIN_LID no se cae — notifyAdmins deja la alerta en el log.
  job(SKIP_AUDIT_CRON(), runSkipAudit, 'skip-audit');
  // Agenda diaria a la admin de la marca. Solo si hay destinatarios: sin ADMIN_AGENDA_DM el
  // job ni se registra (mismo patrón de auto-desactivación que el resto del scheduler).
  const agendaDms = ADMIN_AGENDA_DM();
  if (agendaDms.length) job(ADMIN_AGENDA_CRON(), runAdminAgenda, 'agenda-admin');

  console.log(
    `[Calendly] Jobs activos ✅  (reagendas: ${RESCHEDULE_ENABLED()}, harvest-sweep: ${HARVEST_ENABLED() && HARVEST_SWEEP_ENABLED()}` +
      `, poll HubSpot: ${HUBSPOT_POLL_ENABLED()}, scan de reagendas: ${HUBSPOT_RESCHEDULE_SCAN()}` +
      `, agenda admin: ${agendaDms.length ? `${ADMIN_AGENDA_CRON()} → ${agendaDms.length} DM(s) de ${ADMIN_AGENDA_CONNECTION()}` : 'off'}) — cuentas: ` +
      accounts.map((a) => `${a.key}[dry-run:${a.dryRun()}, push4:${a.push4()}]`).join(' · ')
  );
}
