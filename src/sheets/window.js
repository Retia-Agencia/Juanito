// src/sheets/window.js
// PURO. Ventana diaria [ayer 20:00, hoy 20:00) en America/Bogota.
//
// El reporte corre por cron a las 20:00 y cuenta las entradas de las últimas 24h
// hasta ese corte. Devuelve los límites como epoch "naive" (MISMO criterio que
// parse.js: Date.UTC sobre componentes de hora de pared de Bogotá), para que la
// comparación con `parseSubmittedAt` sea directa.

const TZ = 'America/Bogota';

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
