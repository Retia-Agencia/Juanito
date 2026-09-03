// src/scheduler/recurring-logic.js
// Lógica PURA de los mensajes recurrentes a grupos (sin DB, sin red, sin timers).
// Decide si una fila de scheduled_messages debe enviarse AHORA. Testeable nativo
// en Windows; el scheduler (group-messages.js) solo orquesta.

// Días en español → número (0=domingo, igual que JS getDay). Acepta con/sin tilde.
const DAY_NAMES = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
};

export const DAY_LABELS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// 'jueves' → 4. Devuelve null si no es un día válido.
export function dayNameToNumber(name) {
  const n = DAY_NAMES[String(name || '').trim().toLowerCase()];
  return Number.isInteger(n) ? n : null;
}

// ['jueves','domingo'] → '0,4' (CSV ordenado, dedup). null si alguno es inválido o vacío.
export function daysToCsv(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const nums = names.map(dayNameToNumber);
  if (nums.some((n) => n === null)) return null;
  return [...new Set(nums)].sort((a, b) => a - b).join(',');
}

// '0,4' → 'domingo y jueves' (para confirmaciones legibles).
export function csvToDayLabels(csv) {
  const parts = String(csv || '')
    .split(',')
    .map((s) => DAY_LABELS[Number(s)])
    .filter(Boolean);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

// Valida y normaliza una hora 'H:MM' / 'HH:MM' 24h → 'HH:MM'. null si inválida.
export function normalizeTimeHm(str) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Componentes "de pared" de un instante en una zona horaria (via Intl, sin tzdata
// del SO — mismo enfoque que el resto del proyecto en Alpine).
export function zonedNowParts(date = new Date(), tz = process.env.TZ || 'America/Bogota') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = p.hour === '24' ? '00' : p.hour; // algunos ICU dan '24' a medianoche
  return {
    date: `${p.year}-${p.month}-${p.day}`, // 'YYYY-MM-DD' local
    hm: `${hour}:${p.minute}`,             // 'HH:MM' local
    dow: dowMap[p.weekday],                // 0=domingo
  };
}

// 'YYYY-MM-DD HH:MM:SS' de un instante en la TZ del bot (comparable como string con
// due_at/next_due_at/until_at, que se guardan en el mismo formato y zona). Mismo enfoque
// que zonedNowParts (Intl, sin tzdata del SO).
export function zonedStamp(date = new Date(), tz = process.env.TZ || 'America/Bogota') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}`;
}

// ¿Toca enviar AHORA este outreach a un tercero? Decisión PURA (sin DB/red).
//  - 'once':     due_at ya pasó (<= ahora).
//  - 'interval': next_due_at ya pasó (<= ahora). El catch-up es natural: si quedó atrás
//                (bot caído o pausa por quiet hours) dispara al reanudar.
//  - 'daily':    reusa isRecurringDue (día + ventana de hora + anti doble-envío).
export function isOutreachDue(row, { nowStamp, nowParts, windowMin = 30 }) {
  if (row.recur_kind === 'once') return !!row.due_at && row.due_at <= nowStamp;
  if (row.recur_kind === 'interval') return !!row.next_due_at && row.next_due_at <= nowStamp;
  if (row.recur_kind === 'daily') {
    return isRecurringDue({
      days: row.days,
      timeHm: row.time_hm,
      lastSentDate: row.last_sent_date,
      nowParts,
      windowMin,
    });
  }
  return false;
}

const toMinutes = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

// ¿Toca enviar AHORA esta fila?
//  - el día de hoy está en `days` (CSV 0-6)
//  - la hora actual está en [time_hm, time_hm + windowMin) — la ventana da catch-up
//    si el bot estaba reiniciando justo a la hora exacta
//  - no se envió ya hoy (last_sent_date)
// Nota: una ventana que cruce medianoche no dispara al día siguiente (el dow ya no
// coincide) — aceptado, no programar mensajes a las 23:5x con ventana larga.
export function isRecurringDue({ days, timeHm, lastSentDate, nowParts, windowMin = 30 }) {
  const dayList = String(days || '')
    .split(',')
    .map(Number)
    .filter(Number.isInteger);
  if (!dayList.includes(nowParts.dow)) return false;
  if (lastSentDate === nowParts.date) return false;
  const target = toMinutes(timeHm);
  const now = toMinutes(nowParts.hm);
  return now >= target && now < target + windowMin;
}

const isPublishDay = (days, dow) =>
  String(days || '').split(',').map(Number).filter(Number.isInteger).includes(dow);

// ¿Toca GENERAR el borrador de un mensaje kind='generated'? Se genera con
// `leadMin` de anticipación a la hora de publicar, durante todo el resto del día
// (sin tope superior: si el bot estuvo caído, genera tarde y el jefe aprueba tarde).
// El dedup real es el UNIQUE(scheduled_id, publish_date) de scheduled_drafts.
export function isDraftDue({ days, timeHm, nowParts, leadMin = 60 }) {
  if (!isPublishDay(days, nowParts.dow)) return false;
  const target = toMinutes(timeHm);
  const now = toMinutes(nowParts.hm);
  return now >= target - leadMin;
}

// ¿Toca PUBLICAR un mensaje kind='generated'? Requiere borrador APROBADO.
// Sin tope superior dentro del día: una aprobación tardía publica al minuto
// siguiente, mientras siga siendo el día programado.
export function isGeneratedPublishDue({ days, timeHm, lastSentDate, nowParts }) {
  if (!isPublishDay(days, nowParts.dow)) return false;
  if (lastSentDate === nowParts.date) return false;
  return toMinutes(nowParts.hm) >= toMinutes(timeHm);
}

// Clave del setting que marca un mensaje kind='generated' como AUTO-PUBLICABLE (§18.BS):
// el borrador se aprueba solo al generarse y sale a la hora SIN visto bueno humano.
// Es POR FILA a propósito (mismo patrón que `editorial_feedback:<id>`): el auto-envío se
// prende únicamente donde ya se verificó la calidad del copy — hoy Patah — y no arrastra
// a los demás generados que puedan existir mañana. Vive en `settings` y no en una columna
// para que prenderlo/apagarlo sea un comando por WhatsApp y no un deploy (que reconecta
// Baileys y arriesga softban).
export const autoPublishKey = (scheduledId) => `auto_publish:${scheduledId}`;

// ¿Está prendido el auto-envío para esta fila? `getSetting` es el lector inyectado.
export function isAutoPublish(getSetting, scheduledId) {
  return getSetting?.(autoPublishKey(scheduledId), '') === '1';
}
