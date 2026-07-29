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

// ─── Identidad de una call (§18.AU) ───────────────────────────────────────────
// Dos filas de `calendly_pushes` son la MISMA call si coinciden closer, minuto de arranque y
// LEAD. Las tres condiciones importan, y la del lead es la que se había pasado por alto:
// hay tres fuentes que acuñan uuid propio (Calendly pelado, 'hubspot:<id>', 'manual:<raíz>:<n>')
// y los supersedes que las reconcilian no cubren todos los cruces, así que una misma call puede
// quedar con dos filas vivas y contarse dos veces en la agenda del jefe.
//
// ⚠️ Deduplicar por closer+minuto A SECAS es incorrecto y se midió: de 14 colisiones en 2 meses,
// solo 6 eran la misma call. Las otras 8 son DOBLES RESERVAS reales — dos leads distintos, con
// teléfonos distintos, en el mismo slot del mismo closer (pasa con event types que comparten
// disponibilidad). Descartarlas le habría escondido al jefe calls que sí existen, que es
// exactamente el error que este arreglo venía a corregir, pero al revés.
//
// Precedencia de la superviviente: Calendly > HubSpot > manual. La misma que manda en el resto
// del flujo, y deja la fila de mejor procedencia (el uuid pelado trae el programa por event_type,
// dato duro, no inferido del título).
export const sourceRankOf = (uuid) => {
  const s = String(uuid || '');
  if (s.startsWith('manual:')) return 2;
  if (s.startsWith('hubspot:')) return 1;
  return 0;
};

// `rows` = filas con { event_uuid, closer_email, call_start, prospect_name, prospect_phone }.
// Devuelve las mismas filas sin las gemelas, preservando el orden de entrada.
export function dedupeSameCall(rows = []) {
  const survivors = [];
  for (const row of [...rows].sort((a, b) => sourceRankOf(a.event_uuid) - sourceRankOf(b.event_uuid))) {
    const closer = String(row.closer_email || '').trim().toLowerCase();
    const slot = String(row.call_start || '').slice(0, 16);
    const gemela = survivors.find(
      (s) =>
        // Sin closer no hay identidad de call que valga: se deja pasar en vez de agrupar
        // huérfanas entre sí (dos calls sin closer al mismo minuto son calls distintas).
        closer &&
        String(s.closer_email || '').trim().toLowerCase() === closer &&
        String(s.call_start || '').slice(0, 16) === slot &&
        isSameLead(
          { phone: s.prospect_phone, name: s.prospect_name },
          { phone: row.prospect_phone, name: row.prospect_name }
        )
    );
    if (!gemela) survivors.push(row);
  }
  const orden = new Map(rows.map((r, i) => [r.event_uuid, i]));
  return survivors.sort((a, b) => orden.get(a.event_uuid) - orden.get(b.event_uuid));
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
