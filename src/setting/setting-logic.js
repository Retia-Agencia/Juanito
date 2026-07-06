// src/setting/setting-logic.js
// Lógica de decisión PURA del setteo a leads que no agendaron (§18.AD). Sin DB, sin
// red, sin deps nativas → testeable con `node --test` en cualquier plataforma (igual
// que src/calendly/push-logic.js). El scheduler (src/scheduler/setting.js) solo orquesta.

import { normalizePhone } from '../common/utils.js';

// ─── Timestamp SQLite UTC ('YYYY-MM-DD HH:MM:SS') de un instante ──────────────
export function toSqliteUtc(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

// ─── Número marcable internacional (dígitos, con código país) ─────────────────
// El Form guarda el teléfono como lo escribió el lead: muchas veces SIN código de
// país (ej. "3105551234", móvil colombiano de 10 dígitos). La Cloud API necesita el
// número internacional. Regla conservadora: si ya trae ≥11 dígitos, se asume que el
// código de país está incluido; si trae ≤10, se antepone `defaultCc` (Colombia por
// default). Devuelve '' si no queda un número plausible. NO valida que exista.
export function toDialable(raw, defaultCc = '57') {
  const digits = normalizePhone(raw);
  if (!digits) return '';
  const cc = String(defaultCc || '').replace(/\D/g, '');
  if (digits.length >= 11) return digits;           // ya trae código de país
  if (digits.length >= 7 && cc) return cc + digits; // local → anteponer país
  return digits.length >= 7 ? digits : '';
}

// ─── ¿Enrolar este lead? (compuerta por antigüedad) ───────────────────────────
// Solo entran leads recientes: evita que, al estrenar la función (o tras una caída),
// se dispare una ráfaga de setteos a leads viejos. Devuelve { enroll, reason }.
//  - sin fecha de postulación válida → no enrolar.
//  - postulación en el futuro (desfase raro) → no enrolar.
//  - más vieja que enrollMaxAgeMs → no enrolar (demasiado tarde para settear).
export function computeEnrollment({ submittedMs, nowMs = Date.now(), enrollMaxAgeMs }) {
  if (!Number.isFinite(submittedMs)) return { enroll: false, reason: 'no-date' };
  if (submittedMs > nowMs + 60000) return { enroll: false, reason: 'future-date' };
  if (Number.isFinite(enrollMaxAgeMs) && nowMs - submittedMs > enrollMaxAgeMs) {
    return { enroll: false, reason: 'too-old' };
  }
  return { enroll: true, reason: 'ok' };
}

// ─── Cadencia: los toques de un lead recién enrolado ──────────────────────────
// Máx 2 toques (dato: el 3.º no aporta bookings y sube el riesgo de quejas/rating).
// Los `due` se cuentan desde AHORA (el momento en que Juanito ve por primera vez al
// lead sin agendar), no desde la postulación: así, al estrenar la función, un lead
// viejo-pero-dentro-de-ventana recibe su toque 1 dentro de `touch1DelayMin`, no de
// golpe. Como el agendado es idempotente (UNIQUE), esto se fija una sola vez.
// Devuelve [{ touch_n, dueMs }].
export function computeSettingTouches({ nowMs = Date.now(), touch1DelayMin = 120, touch2DelayMin = 2880 }) {
  const due1 = nowMs + touch1DelayMin * 60000;
  const due2 = due1 + touch2DelayMin * 60000;
  return [
    { touch_n: 1, dueMs: due1 },
    { touch_n: 2, dueMs: due2 },
  ];
}

// ─── Primer nombre para la variable {{1}} de la plantilla ─────────────────────
export function firstNameOf(fullName) {
  const t = String(fullName || '').trim();
  if (!t) return '';
  return t.split(/\s+/)[0];
}
