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
} from '../calendly/index.js';
import { computePush3Schedule, decidePush0 } from '../calendly/push-logic.js';
import { resolveCloser, isIgnoredCloser } from '../calendly/closers.js';
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
const OUTCOME_REMIND_AFTER_MIN = () => Number(process.env.CALENDLY_OUTCOME_REMIND_MIN || 30);
const OUTCOME_EXPIRE_AFTER_MIN = () => Number(process.env.CALENDLY_OUTCOME_EXPIRE_MIN || 30);
const OUTCOME_CRON = () => process.env.CALENDLY_OUTCOME_CRON || '*/10 * * * *';

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
  const [calendly, db, whatsapp] = await Promise.all([
    import('../calendly/index.js'),
    import('../db/index.js'),
    import('../whatsapp/index.js'),
  ]);
  return {
    listProgramEvents: calendly.listProgramEvents,
    getEvent: calendly.getEvent,
    getFirstInvitee: calendly.getFirstInvitee,
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
    // Anti-ban: el gate de entrega exige opt-in GANADO (el closer escribió), no solo
    // que la fila exista. Una fila sembrada/sin verificar NO habilita envío en frío.
    isOptedIn: db.isVerifiedOptedIn,
    // Para enrutar al hilo real del closer (contact_jid) en vez del número canónico.
    getOptin: db.getOptin,
    // Botón de pánico global (`/calendly off`): apaga TODOS los envíos al instante.
    isCalendlyPaused: db.isCalendlyPaused,
    sendMessage: whatsapp.sendMessage,
    now: () => Date.now(),
  };
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
// pausa por-closer (`optin.paused`) corta solo a ese closer. Es ortogonal a DRY_RUN
// (master dev-only del .env) y se controla en caliente desde la DB, sin redeploy.
async function deliver(d, to, text, tag) {
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
  // 3) Pausa por-closer.
  if (optin?.paused) {
    console.log(`[Calendly] PAUSADO (closer ${to}): omito (${tag})`);
    return 'paused-closer';
  }
  // 4) Entrega estricta: solo a un hilo YA establecido (contact_jid). Sin él, no se envía.
  const target = optin?.contact_jid;
  if (!target) {
    console.log(`[Calendly] OMITIDO (${tag}) → ${to}: sin hilo establecido (contact_jid) — no se entrega para evitar envío en frío`);
    return 'skipped-no-thread';
  }
  const via = ` [hilo de opt-in; closer ${to}]`;
  if (DRY_RUN()) {
    console.log(`[Calendly][DRY-RUN] (${tag}) → ${target}${via}\n${text}\n`);
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

  let events;
  try {
    events = await d.listProgramEvents({ minStartIso, maxStartIso });
  } catch (e) {
    recordPollError(e.message);
    console.error('[Calendly] poll: error listando eventos:', e.message);
    if (isAuthError(e.message)) {
      await notifyAdmins(d, `Calendly rechazó el token (${e.message.slice(0, 80)}). Los pushes están caídos hasta rotarlo.`, 'token');
    }
    return 0;
  }

  let nuevos = 0;
  for (const ev of events) {
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
      const invitee = await d.getFirstInvitee(ev.uri);
      const firstName = firstNameFrom(invitee?.name);
      const name = fullNameFrom(invitee?.name);
      const phone = prospectPhoneOf(invitee);
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
      if (PUSH4_ENABLED() && push4AllowedFor(email)) {
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
          const msg0 = buildPush0Message({ name, firstName, phone, startIso: ev.start_time });
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
          const uri4 = `https://api.calendly.com/scheduled_events/${p.event_uuid}`;
          let ev4 = null;
          try {
            ev4 = await d.getEvent(uri4);
          } catch {
            /* si la verificación falla, preguntamos igual con lo guardado */
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

          const startIso4 = ev4?.start_time || `${p.call_start.replace(' ', 'T')}Z`;
          const msg4 = buildPush4Message({
            name: fullNameFrom(p.prospect_name),
            firstName: firstNameFrom(p.prospect_name),
            startIso: startIso4,
          });
          const r4 = await deliver(d, p.closer_phone, msg4, 'push4');
          if (r4 === 'sent' || r4 === 'dry-run') {
            d.markCalendlyPushSent(p.id);
            // Recién acá creamos el pendiente: el closer YA recibió la pregunta, así
            // que su respuesta podrá matchearse (getActiveOutcomeForCloser).
            if (d.createPendingOutcome)
              d.createPendingOutcome({
                event_uuid: p.event_uuid,
                program: p.program,
                closer_email: p.closer_email,
                closer_phone: p.closer_phone,
                closer_name: resolveCloser(p.closer_email)?.name || null,
                lead_name: p.prospect_name,
                lead_phone: p.prospect_phone,
                call_start: p.call_start,
              });
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
          message =
            p.push_n === 0
              ? buildPush0Message({
                  name: fullNameFrom(p.prospect_name),
                  firstName: firstNameFrom(p.prospect_name),
                  phone: p.prospect_phone,
                  startIso: ev.start_time,
                })
              : buildPush3Message({
                  name: fullNameFrom(p.prospect_name),
                  firstName: firstNameFrom(p.prospect_name),
                  phone: p.prospect_phone,
                  startIso: ev.start_time,
                  programKey: programKeyOf(ev.event_type),
                  closer: closer ? firstNameFrom(closer.name) : '',
                  linkLlamada: eventJoinUrl(ev),
                });
        }

        const result = await deliver(d, p.closer_phone, message, `push${p.push_n}`);
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

  let events;
  try {
    events = await d.listProgramEvents({ minStartIso, maxStartIso });
  } catch (e) {
    recordPollError(e.message);
    console.error(`[Calendly] digest push${pushN}: error listando:`, e.message);
    if (isAuthError(e.message)) {
      await notifyAdmins(d, `Calendly rechazó el token (${e.message.slice(0, 80)}). Los pushes están caídos hasta rotarlo.`, 'token');
    }
    return 0;
  }

  const byCloser = new Map(); // phone -> { name, items[] }
  for (const ev of events) {
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
      invitee = await d.getFirstInvitee(ev.uri);
    } catch {
      /* sin invitee igual listamos la cita */
    }
    if (!byCloser.has(closer.phone)) byCloser.set(closer.phone, { name: closer.name, items: [] });
    byCloser.get(closer.phone).items.push({
      name: fullNameFrom(invitee?.name),
      firstName: firstNameFrom(invitee?.name),
      phone: prospectPhoneOf(invitee),
      startIso: ev.start_time,
      programKey: programKeyOf(ev.event_type),
    });
  }

  const desc = pushN === 1 ? 'la noche anterior' : 'en la mañana';
  const label = `Push ${pushN} (${desc})`;
  const when = whenLabel(offsetDays, nowMs);
  for (const [phone, { name, items }] of byCloser) {
    const msg = buildDigestMessage({
      pushLabel: label,
      whenLabel: when,
      items,
      pushN,
      closer: firstNameFrom(name),
    });
    await deliver(d, phone, msg, `push${pushN}`);
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
    const r = await deliver(d, o.closer_phone, msg, 'outcome-remind');
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

// ─── Arranque de los jobs ─────────────────────────────────────────────────────

export function startCalendlyJobs() {
  if (!process.env.CALENDLY_TOKEN) {
    console.warn('[Calendly] CALENDLY_TOKEN ausente — jobs de Calendly desactivados');
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

  console.log(`[Calendly] Jobs activos ✅  (DRY-RUN: ${DRY_RUN()}, Push 4: ${PUSH4_ENABLED()})`);
}
