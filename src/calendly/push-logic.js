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
