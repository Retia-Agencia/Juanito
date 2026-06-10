// src/scheduler/calendly.js
// Recordatorios precall a closers desde Calendly.
//
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
} from '../calendly/index.js';
import { computePush3Schedule } from '../calendly/push-logic.js';
import { resolveCloser } from '../calendly/closers.js';
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
        recordUnmapped(email);
        console.warn(`[Calendly] poll: sin closer mapeado para "${email}" (evento ${uuid}) — omito`);
        await notifyAdmins(d, `Closer sin mapear en Calendly: ${email}. Esa(s) cita(s) no recibirán pushes — agrégalo a src/calendly/closers.js.`, `unmapped:${email}`);
        continue;
      }

      const invitee = await d.getFirstInvitee(ev.uri);
      const firstName = firstNameFrom(invitee?.name);
      const name = fullNameFrom(invitee?.name);
      const phone = prospectPhoneOf(invitee);
      const message = buildPush3Message({
        name,
        firstName,
        phone,
        startIso: ev.start_time,
        programKey: programKeyOf(ev.event_type),
        closer: firstNameFrom(closer.name),
        linkLlamada: eventJoinUrl(ev),
      });

      const result = d.scheduleCalendlyPush({
        event_uuid: uuid,
        push_n: 3,
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
          message = buildPush3Message({
            name: fullNameFrom(p.prospect_name),
            firstName: firstNameFrom(p.prospect_name),
            phone: p.prospect_phone,
            startIso: ev.start_time,
            programKey: programKeyOf(ev.event_type),
            closer: closer ? firstNameFrom(closer.name) : '',
            linkLlamada: eventJoinUrl(ev),
          });
        }

        const result = await deliver(d, p.closer_phone, message, 'push3');
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

  console.log(`[Calendly] Jobs activos ✅  (DRY-RUN: ${DRY_RUN()})`);
}
