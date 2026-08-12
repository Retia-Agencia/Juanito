// src/sheets/window.js
// PURO. Ventana diaria [ayer 20:00, hoy 20:00) en America/Bogota.
//
// El reporte corre por cron a las 20:00 y cuenta las entradas de las últimas 24h
// hasta ese corte. Devuelve los límites como epoch "naive" (MISMO criterio que
// parse.js: Date.UTC sobre componentes de hora de pared de Bogotá), para que la
// comparación con `parseSubmittedAt` sea directa.

const TZ = 'America/Bogota';
const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Componentes de fecha/hora de `date` vistos en una zona (default Bogotá).
export function zonedParts(date, tz = TZ) {
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
  const H = +p.hour;
  return {
    y: +p.year,
    m: +p.month,
    d: +p.day,
    H: H === 24 ? 0 : H, // algunos runtimes devuelven "24" a medianoche
    M: +p.minute,
    S: +p.second,
  };
}

// Ventana que CIERRA a las `cutoffHour`:00 (Bogotá) del día en que cae `now`, y
// abre `windowHours` antes. Por defecto: [ayer 20:00, hoy 20:00).
export function computeWindow(now = new Date(), { cutoffHour = 20, windowHours = 24, tz = TZ } = {}) {
  const { y, m, d } = zonedParts(now, tz);
  const endMs = Date.UTC(y, m - 1, d, cutoffHour, 0, 0);
  const startMs = endMs - windowHours * 3600 * 1000;
  return { startMs, endMs };
}

// Epoch "naive" del instante `date`: Date.UTC sobre sus componentes de pared en la
// zona. Es la conversión epoch REAL → naive (Stripe entrega `created` en epoch real;
// el resto del módulo compara en naive).
export function toNaiveMs(date, tz = TZ) {
  const { y, m, d, H, M, S } = zonedParts(date, tz);
  return Date.UTC(y, m - 1, d, H, M, S);
}

// Naive epoch del lunes 00:00 de la semana (Bogotá) en la que cae `now`.
export function startOfWeekMonday(now = new Date(), tz = TZ) {
  const { y, m, d } = zonedParts(now, tz);
  const midnight = Date.UTC(y, m - 1, d);
  // Sobre naive epoch, getUTCDay() devuelve el día de semana de Bogotá (0=domingo).
  const dow = new Date(midnight).getUTCDay();
  return midnight - ((dow + 6) % 7) * DAY_MS;
}

// Última semana COMPLETA: [lunes pasado 00:00, este lunes 00:00).
export function lastFullWeekWindow(now = new Date(), tz = TZ) {
  const endMs = startOfWeekMonday(now, tz);
  return { startMs: endMs - WEEK_MS, endMs };
}

// Días que tiene el mes `m` (1-based) del año `y`. Date.UTC(y, m, 0) = último día del
// mes anterior a `m+1`, o sea el último de `m`.
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Mes a la fecha (MTD) y el MISMO tramo del mes anterior, para el bloque de venta neta
// del reporte (§18.B). Si hoy es 12 de agosto y el corte son las 20:00:
//   cur  = [1 ago 00:00, 12 ago 20:00)
//   prev = [1 jul 00:00, 12 jul 20:00)
// El día del mes anterior se CLAMPEA a su último día: el 31 de marzo compara contra el
// 28 (o 29) de febrero, no contra un 31 que no existe. Mismo epoch "naive" que el resto
// del módulo.
export function monthToDateWindows(now = new Date(), { cutoffHour = 20, tz = TZ } = {}) {
  const { y, m, d } = zonedParts(now, tz);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const pd = Math.min(d, daysInMonth(py, pm));
  return {
    cur: { startMs: Date.UTC(y, m - 1, 1), endMs: Date.UTC(y, m - 1, d, cutoffHour) },
    prev: { startMs: Date.UTC(py, pm - 1, 1), endMs: Date.UTC(py, pm - 1, pd, cutoffHour) },
  };
}

// Ventanas parciales like-for-like de las últimas `weeks` semanas (incluida la
// actual): [lunes 00:00, hoy cutoffHour:00) desplazada k·7d — si hoy es miércoles,
// lunes→miércoles de cada semana, todas con el mismo corte horario. Índice 0 =
// semana en curso. Bogotá es UTC-5 fijo (sin DST) → restar 7·24h es exacto.
export function partialWeekWindows(now = new Date(), { weeks = 4, cutoffHour = 20, tz = TZ } = {}) {
  const startMs = startOfWeekMonday(now, tz);
  const { endMs } = computeWindow(now, { cutoffHour, tz });
  const wins = [];
  for (let k = 0; k < weeks; k++) {
    wins.push({ startMs: startMs - k * WEEK_MS, endMs: endMs - k * WEEK_MS });
  }
  return wins;
}
