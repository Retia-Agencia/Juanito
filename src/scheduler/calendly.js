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
import {
  firstNameFrom,
  fullNameFrom,
  closerEmailOf,
  prospectPhoneOf,
  buildPush3Message,
  buildDigestMessage,
  programKeyOf,
  eventJoinUrl,
  dayRangeUtc,
  toSqliteUtc,
  formatCallTime,
  buildPush0Message,
  isSameDayInTz,
  push2HasRunToday,
  push4DueUtc,
  buildPush4Message,
  buildOutcomeReminder,
  buildReschedulePromptMessage,
} from '../calendly/index.js';
import { computePush3Schedule, decidePush0 } from '../calendly/push-logic.js';
import { pickSupersededPushes, isManualUuid, planRescheduledPushes } from '../calendly/reschedule-logic.js';
import { isCoveredProgram, decideFromAgenda } from '../hubspot/deals.js';
import { decideNudgeAction, buildDealNudgeMessage, buildCreateDealNudgeMessage, dealUrl } from '../hubspot/nudge.js';
import { meetingsToCalls } from '../hubspot/meetings.js';
import { pickMeetingsToSchedule, callStartToIso } from '../hubspot/agenda-poll.js';
import { resolveCloser, isIgnoredCloser, accountOfCloser, HUBSPOT_OWNER_TO_CLOSER } from '../calendly/closers.js';
import { accountOf, activeAccounts, DEFAULT_ACCOUNT } from '../calendly/accounts.js';
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
    // §18.AF: modelo nudge — matchea la call con su deal y clasifica el estado.
    matchCallToDeal: hubspot.matchCallToDeal,
    // §18.AN: poll de las citas que solo viven en HubSpot.
    searchMeetingsInWindow: hubspot.searchMeetingsInWindow,
    getOwnerEmailMap: hubspot.getOwnerEmailMap,
    getMeetingContact: hubspot.getMeetingContact,
    getScheduledCallsInWindow: db.getScheduledCallsInWindow,
    supersedeHubspotPushes: db.supersedeHubspotPushes,
    scheduleCalendlyPush: db.scheduleCalendlyPush,
    getDueCalendlyPushes: db.getDueCalendlyPushes,
    claimCalendlyPush: db.claimCalendlyPush,
    revertCalendlyPush: db.revertCalendlyPush,
    markCalendlyPushSent: db.markCalendlyPushSent,
    markCalendlyPushSkipped: db.markCalendlyPushSkipped,
    // §18.AB: outcomes post-call.
    createPendingOutcome: db.createPendingOutcome,
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
  if (!email || !d.hubspotEnabled?.() || !d.getContactPhone) return null;
  const p = await d.getContactPhone(email).catch(() => null);
  if (p) console.log(`[HubSpot] teléfono de ${email} recuperado (Calendly sin número)`);
  return p;
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
  // Email del lead desde Calendly (no está en la fila del push).
  let email = null;
  try {
    const inv = await d.getFirstInvitee(`https://api.calendly.com/scheduled_events/${p.event_uuid}`);
    email = inv?.email || null;
  } catch {
    /* sin invitee → sin email → cae a clásico */
  }
  if (!email) return { handled: false };

  const match = await d.matchCallToDeal({ email, programKey: p.program });
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
      return { handled: true, message: buildDealNudgeMessage({ name: lead, url: dealUrl(match.deal?.id) }) };
    // a.action === 'ask' → sin estado claro → cae al modelo por etapa / clásico.
  }

  // Modelo por etapa (§18.AF): fallback. Solo activo con HUBSPOT_NUDGE_ENABLED.
  if (!NUDGE_ENABLED()) return { handled: false };
  const decision = decideNudgeAction(match);
  if (decision.action === 'silent') return { handled: true, silent: true, reason: match.status };
  if (decision.action === 'nudge_update')
    return { handled: true, message: buildDealNudgeMessage({ name: lead, url: decision.dealUrl }) };
  if (decision.action === 'nudge_create')
    return { handled: true, message: buildCreateDealNudgeMessage({ name: lead, reason: decision.reason }) };
  return { handled: false }; // 'ask' / unknown / error → Push 4 clásico
}

// ─── Alertas a admins (decisión 5) ────────────────────────────────────────────
// DM inmediato a los ADMIN_LID solo para fallos que tiran pushes de un closer real
// al piso: token muerto y closer sin mapear. Deduplicado por `dedupKey` (6h) para
// no spamear cada poll. Si no hay ADMIN_LID configurado, queda en el log.
async function notifyAdmins(d, text, dedupKey) {
  if (dedupKey && !shouldAlert(dedupKey)) return;
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

// Devuelve 'sent' | 'dry-run' | 'skipped-optin' | 'skipped-no-thread'
//          | 'paused' | 'paused-closer'.
// Anti-baneo: nunca enviamos a un closer que no haya escrito antes a Juanito.
// `to` es el número canónico del closer (closers.js): sirve de clave del opt-in y
// para agrupar digests. El ENVÍO, en cambio, va EXCLUSIVAMENTE a la identidad que YA
// estableció hilo con Juanito (`contact_jid` del opt-in). Entrega ESTRICTA (Item 1):
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
async function deliver(d, to, text, tag, closerEmail) {
  // 1) Pausa global: botón de pánico — apaga absolutamente todo.
  if (d.isCalendlyPaused && d.isCalendlyPaused()) {
    console.log(`[Calendly] PAUSADO (global) → ${to}: omito (${tag})`);
    return 'paused';
  }
  // 2) Opt-in GANADO requerido (anti-ban).
  if (REQUIRE_OPTIN() && !d.isOptedIn(to)) {
    console.log(`[Calendly] OMITIDO (${tag}) → ${to}: el closer aún no le ha escrito a Juanito (sin opt-in)`);
    return 'skipped-optin';
  }
  const optin = d.getOptin ? d.getOptin(to) : null;
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
    console.log(`[Calendly] OMITIDO (${tag}) → ${to}: sin hilo establecido (contact_jid) — no se entrega para evitar envío en frío`);
    return 'skipped-no-thread';
  }
  const via = ` [hilo de opt-in; closer ${to}]`;
  // 5) Dry-run de la cuenta del closer (último filtro, igual que antes).
  if (dryRunForCloser(closerEmail)) {
    console.log(`[Calendly][DRY-RUN:${accountOfCloser(closerEmail)}] (${tag}) → ${target}${via}\n${text}\n`);
    return 'dry-run';
  }
  await d.sendMessage(target, text);
  console.log(`[Calendly] enviado (${tag}) → ${target}${via}`);
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

      // ─── Push 0: aviso de "nueva call HOY" (§18.C) ───────────────────────────
      // Solo para reservas genuinamente nuevas de calls de hoy, una vez ya pasaron
      // los digests. Reusa la misma fila/dedup que los demás pushes (push_n=0,
      // due=ahora) → lo entrega `runCalendlyDelivery` con todos los gates anti-ban.
      if (PUSH0_ENABLED()) {
        const d0 = decidePush0({
          startMs: new Date(ev.start_time).getTime(),
          createdAtMs: ev.created_at ? new Date(ev.created_at).getTime() : NaN,
          nowMs,
          isToday: isSameDayInTz(ev.start_time, TZ(), now),
          push2HasRun: push2HasRunToday(PUSH2_CRON(), TZ(), now),
          recentMs: PUSH0_RECENT_MIN() * 60000,
        });
        if (d0.notify) {
          const msg0 = buildPush0Message({ name, firstName, phone, startIso: ev.start_time, programKey });
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
  const existingCalls = d.getScheduledCallsInWindow(toDb(minStartIso), toDb(maxStartIso));
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
          recentMs: PUSH0_RECENT_MIN() * 60000,
        });
        if (d0.notify) {
          d.scheduleCalendlyPush({
            ...base,
            push_n: 0,
            due_at: toSqliteUtc(new Date(nowMs)),
            message: buildPush0Message({ name, firstName, phone, startIso, programKey: call.program }),
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
            d.markCalendlyPushSkipped(p.id, 'reagendada (el poll reagenda el push 4)');
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
          if (r4 === 'sent' || r4 === 'dry-run') {
            d.markCalendlyPushSent(p.id);
            // El pendiente se crea recién ahora: el closer YA recibió el mensaje, así que
            // su respuesta (incl. una reagenda) podrá matchearse (getActiveOutcomeForCloser).
            if (d.createPendingOutcome)
              d.createPendingOutcome(pendingOutcomeFrom(p, { reminded: remindedFlag }));
          } else if (r4 === 'paused' || r4 === 'paused-closer') {
            if (d.revertCalendlyPush) d.revertCalendlyPush(p.id); // reintentar al despausar
          } else if (r4 === 'skipped-no-thread') {
            d.markCalendlyPushSkipped(p.id, 'sin hilo establecido (contact_jid)');
          } else {
            d.markCalendlyPushSkipped(p.id, 'closer sin opt-in');
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
          d.markCalendlyPushSkipped(p.id, 'llamada ya pasó (push obsoleto)');
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
            d.markCalendlyPushSkipped(p.id, `cita ${ev.status}`);
            console.log(`[Calendly] Push 3 #${p.id} omitido: cita ${ev.status}`);
            continue;
          }
          if (toSqliteUtc(new Date(ev.start_time)) !== p.call_start) {
            d.markCalendlyPushSkipped(p.id, 'reagendada');
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
        } else if (result === 'skipped-no-thread') {
          d.markCalendlyPushSkipped(p.id, 'sin hilo establecido (contact_jid)');
        } else {
          d.markCalendlyPushSkipped(p.id, 'closer sin opt-in');
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
  if (failed && !events.length) return 0;

  const byCloser = new Map(); // phone -> { name, email, items[] }
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

  console.log(
    `[Calendly] Digest ${label}: ${byCloser.size} closers, ${events.length} citas${DRY_RUN() ? ' [DRY-RUN]' : ''}`
  );
  return byCloser.size;
}

export const runPush1 = () => runDigest(1, 1); // mañana
export const runPush2 = () => runDigest(2, 0); // hoy

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
    // Solo marcamos 'reminded' si de verdad salió; si estaba pausado/sin opt-in se
    // reintenta en el próximo tick (no se quema la única insistencia de v1).
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

  console.log(
    `[Calendly] Jobs activos ✅  (reagendas: ${RESCHEDULE_ENABLED()}, harvest-sweep: ${HARVEST_ENABLED() && HARVEST_SWEEP_ENABLED()}) — cuentas: ` +
      accounts.map((a) => `${a.key}[dry-run:${a.dryRun()}, push4:${a.push4()}]`).join(' · ')
  );
}
