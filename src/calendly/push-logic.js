// src/calendly/push-logic.js
// Lógica de decisión PURA para el agendado/reagendado de pushes precall.
// Sin DB, sin red, sin deps nativas → testeable con `node --test` en cualquier
// plataforma (igual que src/calendly/index.js). La comparten el acceso a DB
// (src/db/index.js → scheduleCalendlyPush) y el harness de escenarios, de modo
// que probar estas funciones == probar el comportamiento real.

// ─── Parseo de timestamp SQLite ('YYYY-MM-DD HH:MM:SS' en UTC) → ms ───────────
export function sqliteUtcToMs(s) {
  if (!s) return NaN;
  return Date.parse(String(s).replace(' ', 'T') + 'Z');
}

// ─── Decisión 4b: ¿agendar el Push 3 y para cuándo? ───────────────────────────
// Devuelve { shouldSchedule, dueMs, immediate, reason }.
//
//  - Si la llamada YA pasó (start <= now): no agendar (un push de algo que ya
//    empezó es inútil/molesto). reason 'call-passed'.
//  - Si el `due` normal (start - lead) ya pasó pero la llamada sigue en el futuro:
//    AGENDAR para ahora mismo (catch-up). Esto cubre reservas de último minuto y
//    citas reagendadas a una hora cercana donde los 3 triggers normales ya pasaron.
//    Decisión 4b (sin piso): si la llamada está agendada y los triggers pasaron,
//    igual se manda. reason 'catch-up', immediate=true.
//  - Si todo es futuro: agendar a la hora normal. reason 'normal'.
export function computePush3Schedule({ startIso, leadMin = 25, nowMs = Date.now() }) {
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) {
    return { shouldSchedule: false, dueMs: NaN, immediate: false, reason: 'invalid-start' };
  }
  if (startMs <= nowMs) {
    return { shouldSchedule: false, dueMs: NaN, immediate: false, reason: 'call-passed' };
  }
  const dueMs = startMs - leadMin * 60000;
  if (dueMs <= nowMs) {
    return { shouldSchedule: true, dueMs: nowMs, immediate: true, reason: 'catch-up' };
  }
  return { shouldSchedule: true, dueMs, immediate: false, reason: 'normal' };
}

// ─── Push 0: aviso inmediato de "te reservaron un espacio HOY" ────────────────
// Tapa-huecos del booking tardío (idea Sebas, §18.C). Caso canónico: a un closer
// le cancelan una cita y ese MISMO día alguien reserva el slot liberado DESPUÉS de
// que ya corrieron los digests → sin esto, el closer se entera solo 25 min antes
// (Push 3). El Push 0 le avisa apenas el poll detecta la reserva.
//
// ─── La ventana ciega de la noche (2026-08-18) ────────────────────────────────
// La versión original solo miraba HOY, con este razonamiento: "las de días futuros
// las cubre el Push 1 de esa noche". Es falso para una franja concreta: el Push 1
// corre a las 19:00, así que **una cita reservada entre las 19:00 y la medianoche
// para el día siguiente no dispara nada** — el digest ya pasó y el Push 0 la
// descartaba por no ser "hoy". El closer se enteraba recién a las 6:30am (Push 2).
//
// Medido con Pablo Suarez el 2026-08-18: sus CUATRO citas de ese día se reservaron
// entre las 8:15pm y las 10:30pm de la víspera ⇒ pasó la noche entera sin un solo
// aviso. En 21 días le tocó a 8 de 64 citas. Pega distinto según el programa:
// `developers` reserva tarde, así que concentra casi todos los casos.
//
// El arreglo: si la call es MAÑANA y el Push 1 de hoy YA corrió, avisar igual. El
// gate se mantiene simétrico — para hoy el digest relevante es el Push 2, para
// mañana es el Push 1; si el digest que corresponde todavía no corrió, él avisa y
// nos callamos (misma regla anti-duplicado de siempre).
//
// Es PURO (recibe booleanos/ms ya computados; el cálculo de zona horaria vive en
// src/calendly/index.js). Devuelve { notify, reason }. Condiciones (TODAS):
//  - isToday || isTomorrow → la call cae hoy o mañana (en tz). De ahí en adelante
//                     el Push 1 de su víspera llega siempre a tiempo, sin hueco.
//  - call futura    → start > now (no avisar de algo que ya empezó).
//  - createdAt reciente → el booking se hizo dentro de `recentMs` (≈ ventana del
//                     poll). Distingue una reserva NUEVA de una vieja que recién
//                     entró a la ventana / del primer poll tras un deploy.
//  - push2HasRun    → (caso HOY) el digest del Push 2 de hoy YA pasó. Si aún no,
//                     ese digest avisará → omitimos el Push 0 para no duplicar.
//  - push1HasRun    → (caso MAÑANA) el digest del Push 1 de hoy YA pasó. Si aún
//                     no, la cita entrará en él esta noche → nos callamos.
export function decidePush0({
  startMs,
  createdAtMs,
  nowMs = Date.now(),
  isToday,
  push2HasRun,
  isTomorrow = false,
  push1HasRun = false,
  recentMs = 10 * 60000,
}) {
  if (!isToday && !isTomorrow) return { notify: false, reason: 'not-today' };
  if (!Number.isFinite(startMs) || startMs <= nowMs) {
    return { notify: false, reason: 'call-passed' };
  }
  if (!Number.isFinite(createdAtMs)) return { notify: false, reason: 'no-created-at' };
  if (createdAtMs > nowMs + 60000) return { notify: false, reason: 'created-in-future' };
  if (nowMs - createdAtMs > recentMs) return { notify: false, reason: 'not-recent' };
  // `isToday` gana si por algún motivo llegan los dos: el aviso de hoy es más urgente
  // y su gate (push 2) es el correcto para una call que ocurre en unas horas.
  if (isToday) {
    if (!push2HasRun) return { notify: false, reason: 'push2-pending' };
    return { notify: true, reason: 'new-booking-today' };
  }
  if (!push1HasRun) return { notify: false, reason: 'push1-pending' };
  return { notify: true, reason: 'new-booking-tomorrow' };
}

// ─── Bug #2: ¿qué hacer ante una cita ya conocida? ────────────────────────────
// `existing` = fila actual de calendly_pushes (o null), `incoming` = datos del
// poll (incluye call_start y due_at en formato SQLite UTC).
// Devuelve { action: 'insert' | 'reschedule' | 'unchanged', resetFromSent?, reason? }.
//
//  - Sin fila previa → insert.
//  - call_start NO cambió → unchanged (idempotente; el poll corre cada 5 min).
//  - call_start cambió y la fila sigue 'scheduled' → reschedule normal.
//  - call_start cambió y la fila ya está 'sent' (bug #2): si la hora NUEVA del
//    push sigue en el futuro, re-armar (resetFromSent → status vuelve a 'scheduled').
//    Si la nueva hora del push ya pasó, no re-armar (no tiene sentido). Esto cubre
//    "ya mandé el Push 3 y luego reagendaron a más tarde".
//  - 'skipped'/otros → unchanged (no se resucitan automáticamente).
export function decidePushAction({ existing, incoming, nowMs = Date.now() }) {
  if (!existing) return { action: 'insert', reason: 'new' };

  if (existing.call_start === incoming.call_start) {
    return { action: 'unchanged', reason: 'same-time' };
  }

  if (existing.status === 'scheduled') {
    return { action: 'reschedule', resetFromSent: false, reason: 'rescheduled' };
  }

  if (existing.status === 'sent') {
    const dueMs = sqliteUtcToMs(incoming.due_at);
    if (Number.isFinite(dueMs) && dueMs > nowMs) {
      return { action: 'reschedule', resetFromSent: true, reason: 'rescheduled-from-sent' };
    }
    return { action: 'unchanged', reason: 'sent-new-due-past' };
  }

  return { action: 'unchanged', reason: 'inactive-status' };
}
