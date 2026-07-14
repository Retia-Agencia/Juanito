// src/calendly/reschedule-logic.js
// PURO (sin red, sin DB → testeable en Windows, y el scheduler lo puede importar sin
// arrastrar better-sqlite3). Las decisiones de una reagenda (§18.AC): qué uuid le toca, qué
// pushes hay que crear y cuándo, y si la reagenda ya volvió a entrar por Calendly. El efecto
// (escribir esas filas) es lo único que vive en reschedule.js.

import {
  buildPush3Message,
  buildPush4Message,
  push4DueUtc,
  toSqliteUtc,
  firstNameFrom,
  fullNameFrom,
} from './index.js';
import { resolveCloser } from './closers.js';

// Un uuid sintético es 'manual:<uuid-raíz>:<n>'. La raíz es SIEMPRE el evento original de
// Calendly, así que una reagenda de una reagenda no anida prefijos: solo sube el contador.
export function rootUuidOf(uuid) {
  const m = /^manual:(.+):(\d+)$/.exec(String(uuid || ''));
  return m ? m[1] : String(uuid || '');
}

export function chainDepthOf(uuid) {
  const m = /^manual:(.+):(\d+)$/.exec(String(uuid || ''));
  return m ? Number(m[2]) : 0;
}

export function nextManualUuid(uuid) {
  return `manual:${rootUuidOf(uuid)}:${chainDepthOf(uuid) + 1}`;
}

export function isManualUuid(uuid) {
  return String(uuid || '').startsWith('manual:');
}

// ─── Dedup contra Calendly (lo usa el poll) ───────────────────────────────────
// Si la reagenda que el closer nos dictó terminó entrando por Calendly, aparece un evento
// REAL para el mismo closer y el mismo lead. Ese evento manda: hay que cancelar los pushes
// sintéticos o se le pregunta al closer dos veces y el lead cuenta dos veces.

const digits = (s) => String(s || '').replace(/\D/g, '');

const normName = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// El teléfono manda cuando ambos lo tienen (últimos 8 dígitos: los prefijos de país varían).
// Calendly deja `text_reminder_number` en null en varias reservas —justo las reagendadas—,
// así que sin teléfono caemos al nombre completo.
export function isSameLead(a, b) {
  const pa = digits(a.phone);
  const pb = digits(b.phone);
  if (pa && pb) return pa.slice(-8) === pb.slice(-8);
  const na = normName(a.name);
  return !!na && na === normName(b.name);
}

export function pickSupersededPushes(manualPushes = [], { closerPhone, leadPhone, leadName }) {
  const cp = digits(closerPhone).slice(-8);
  if (!cp) return [];
  return manualPushes.filter(
    (p) =>
      digits(p.closer_phone).slice(-8) === cp &&
      isSameLead(
        { phone: p.prospect_phone, name: p.prospect_name },
        { phone: leadPhone, name: leadName }
      )
  );
}

// ─── Plan de la call reagendada ───────────────────────────────────────────────
// Qué filas de calendly_pushes hay que crear para que la call reagendada exista para
// Juanito. Devuelve { ok, uuid, depth, pushes } o { ok: false, reason: 'chain' } cuando el
// lead ya lleva demasiadas reagendas encadenadas (a la cuarta, el problema no es la agenda).
export function planRescheduledPushes(
  outcome,
  startUtc,
  { nowMs = Date.now(), leadMin = 25, durationMin = 30, graceMin = 5, maxChain = 3 } = {}
) {
  const depth = chainDepthOf(outcome.event_uuid) + 1;
  if (depth > maxChain) return { ok: false, reason: 'chain', depth };

  const uuid = nextManualUuid(outcome.event_uuid);
  const startIso = new Date(startUtc).toISOString();
  const closer = resolveCloser(outcome.closer_email);
  const name = fullNameFrom(outcome.lead_name);
  const firstName = firstNameFrom(outcome.lead_name);

  const base = {
    event_uuid: uuid,
    program: outcome.program,
    closer_email: outcome.closer_email,
    closer_phone: outcome.closer_phone,
    prospect_name: outcome.lead_name,
    prospect_phone: outcome.lead_phone,
    call_start: toSqliteUtc(new Date(startUtc)),
  };

  const pushes = [];

  // Push 3 (recordatorio precall). Solo si su disparo sigue en el futuro: una reagenda para
  // dentro de 10 min no necesita el aviso de "en 25 min". Sin link de llamada — en una
  // reagenda por fuera de Calendly no lo tenemos; el copy precall ya contempla ese caso.
  const push3DueMs = new Date(startUtc).getTime() - leadMin * 60000;
  if (push3DueMs > nowMs) {
    pushes.push({
      ...base,
      push_n: 3,
      due_at: toSqliteUtc(new Date(push3DueMs)),
      message: buildPush3Message({
        name,
        firstName,
        phone: outcome.lead_phone,
        startIso,
        programKey: outcome.program,
        closer: firstNameFrom(closer?.name || outcome.closer_name),
        linkLlamada: '',
      }),
    });
  }

  // Push 4 (registro post-call) — el que hace que esta call SÍ cuente en las métricas.
  pushes.push({
    ...base,
    push_n: 4,
    due_at: toSqliteUtc(push4DueUtc(startIso, durationMin, graceMin)),
    message: buildPush4Message({ name, firstName, startIso }),
  });

  return { ok: true, uuid, depth, pushes };
}
