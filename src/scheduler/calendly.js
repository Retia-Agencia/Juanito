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

import { CronJob } from 'cron';
import {
  listProgramEvents,
  getEvent,
  getFirstInvitee,
  firstNameFrom,
  closerEmailOf,
  prospectPhoneOf,
  buildPush3Message,
  buildDigestMessage,
  dayRangeUtc,
  push3DueUtc,
  toSqliteUtc,
  formatCallTime,
} from '../calendly/index.js';
import { resolveCloser } from '../calendly/closers.js';
import {
  scheduleCalendlyPush,
  getDueCalendlyPushes,
  markCalendlyPushSent,
  markCalendlyPushSkipped,
  isOptedIn,
} from '../db/index.js';
import { sendMessage } from '../whatsapp/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const DRY_RUN = () => process.env.CALENDLY_DRY_RUN !== 'false'; // default true
const REQUIRE_OPTIN = () => process.env.CALENDLY_REQUIRE_OPTIN !== 'false'; // default true
const LEAD_MIN = () => Number(process.env.CALENDLY_PUSH3_LEAD_MIN || 25);

const POLL_CRON = () => process.env.CALENDLY_POLL_CRON || '*/5 * * * *';
const DELIVER_CRON = () => process.env.CALENDLY_DELIVER_CRON || '* * * * *';
const PUSH1_CRON = () => process.env.CALENDLY_PUSH1_CRON || '0 19 * * *'; // 7:00pm
const PUSH2_CRON = () => process.env.CALENDLY_PUSH2_CRON || '30 6 * * *'; // 6:30am

// ─── Envío (respeta DRY-RUN) ──────────────────────────────────────────────────

// Devuelve 'sent' | 'dry-run' | 'skipped-optin'.
// Anti-baneo: nunca enviamos a un closer que no haya escrito antes a Juanito.
async function deliver(to, text, tag) {
  if (REQUIRE_OPTIN() && !isOptedIn(to)) {
    console.log(`[Calendly] OMITIDO (${tag}) → ${to}: el closer aún no le ha escrito a Juanito (sin opt-in)`);
    return 'skipped-optin';
  }
  if (DRY_RUN()) {
    console.log(`[Calendly][DRY-RUN] (${tag}) → ${to}\n${text}\n`);
    return 'dry-run';
  }
  await sendMessage(to, text);
  console.log(`[Calendly] enviado (${tag}) → ${to}`);
  return 'sent';
}

// ─── Poll: descubre citas y agenda Push 3 ─────────────────────────────────────

export async function runCalendlyPoll() {
  const now = new Date();
  const minStartIso = new Date(now.getTime() - 5 * 60000).toISOString();
  const maxStartIso = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();

  let events;
  try {
    events = await listProgramEvents({ minStartIso, maxStartIso });
  } catch (e) {
    console.error('[Calendly] poll: error listando eventos:', e.message);
    return 0;
  }

  let nuevos = 0;
  for (const ev of events) {
    try {
      const uuid = ev.uri.split('/').pop();
      const due = push3DueUtc(ev.start_time, LEAD_MIN());
      if (due.getTime() <= now.getTime()) continue; // la hora del push 3 ya pasó

      const email = closerEmailOf(ev);
      const closer = resolveCloser(email);
      if (!closer) {
        console.warn(`[Calendly] poll: sin closer mapeado para "${email}" (evento ${uuid}) — omito`);
        continue;
      }

      const invitee = await getFirstInvitee(ev.uri);
      const firstName = firstNameFrom(invitee?.name);
      const phone = prospectPhoneOf(invitee);
      const message = buildPush3Message({ firstName, phone, startIso: ev.start_time });

      const result = scheduleCalendlyPush({
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
        console.log(
          `[Calendly] Push 3 ${result} → ${closer.name} | ${firstName} | ${formatCallTime(ev.start_time)} (due ${toSqliteUtc(due)} UTC)`
        );
      }
    } catch (e) {
      console.error(`[Calendly] poll: error en evento ${ev.uri}:`, e.message);
    }
  }

  console.log(
    `[Calendly] Poll completo: ${events.length} citas, ${nuevos} push 3 agendados/actualizados${DRY_RUN() ? ' [DRY-RUN]' : ''}`
  );
  return nuevos;
}

// ─── Entrega de Push 3 vencidos ───────────────────────────────────────────────

export async function runCalendlyDelivery() {
  const due = getDueCalendlyPushes();
  for (const p of due) {
    try {
      // Re-validar: la cita pudo cancelarse o reagendarse después de agendar el push.
      const uri = `https://api.calendly.com/scheduled_events/${p.event_uuid}`;
      let ev = null;
      try {
        ev = await getEvent(uri);
      } catch {
        /* si la verificación falla, entregamos igual para no perder el push */
      }
      if (ev) {
        if (ev.status !== 'active') {
          markCalendlyPushSkipped(p.id, `cita ${ev.status}`);
          console.log(`[Calendly] Push 3 #${p.id} omitido: cita ${ev.status}`);
          continue;
        }
        if (toSqliteUtc(new Date(ev.start_time)) !== p.call_start) {
          markCalendlyPushSkipped(p.id, 'reagendada');
          console.log(`[Calendly] Push 3 #${p.id} omitido: reagendada (el poll agendará la nueva hora)`);
          continue;
        }
      }

      const result = await deliver(p.closer_phone, p.message, 'push3');
      if (result === 'skipped-optin') {
        markCalendlyPushSkipped(p.id, 'closer sin opt-in');
      } else {
        markCalendlyPushSent(p.id);
      }
    } catch (e) {
      console.error(`[Calendly] Error entregando push 3 #${p.id}:`, e.message);
    }
  }
  return due.length;
}

// ─── Digests Push 1 / Push 2 ──────────────────────────────────────────────────

function whenLabel(offsetDays) {
  const base = new Date(Date.now() + offsetDays * 86400000);
  const fmt = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ(),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(base);
  return offsetDays === 1 ? `mañana (${fmt})` : `hoy (${fmt})`;
}

async function runDigest(pushN, offsetDays) {
  const { minStartIso, maxStartIso } = dayRangeUtc(TZ(), offsetDays);

  let events;
  try {
    events = await listProgramEvents({ minStartIso, maxStartIso });
  } catch (e) {
    console.error(`[Calendly] digest push${pushN}: error listando:`, e.message);
    return 0;
  }

  const byCloser = new Map(); // phone -> { name, items[] }
  for (const ev of events) {
    const email = closerEmailOf(ev);
    const closer = resolveCloser(email);
    if (!closer) {
      console.warn(`[Calendly] digest push${pushN}: sin closer para "${email}" — omito cita`);
      continue;
    }
    let invitee = null;
    try {
      invitee = await getFirstInvitee(ev.uri);
    } catch {
      /* sin invitee igual listamos la cita */
    }
    if (!byCloser.has(closer.phone)) byCloser.set(closer.phone, { name: closer.name, items: [] });
    byCloser.get(closer.phone).items.push({
      firstName: firstNameFrom(invitee?.name),
      phone: prospectPhoneOf(invitee),
      startIso: ev.start_time,
    });
  }

  const label = `Push ${pushN}`;
  const when = whenLabel(offsetDays);
  for (const [phone, { items }] of byCloser) {
    const msg = buildDigestMessage({ pushLabel: label, whenLabel: when, items });
    await deliver(phone, msg, `push${pushN}`);
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
