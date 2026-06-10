// src/sheets/parse.js
// PURO. Parseo de la marca temporal "Submitted At" del Form → instante comparable.
//
// El valor llega como hora de pared SIN zona, en formato D/M/YYYY H:MM:SS (día
// primero, reloj de 24h, segundos opcionales). Ejemplos reales:
//   "9/6/2026 17:03:04", "10/6/2026 0:34:09"
//
// ⚠️ Zona horaria: el Form sella "Submitted At" en GMT-2 (3h ADELANTE de Bogotá,
// que es GMT-5). Como la ventana (window.js) se calcula en hora de pared de Bogotá,
// traemos la marca a ese mismo reloj RESTANDO el desfase. Así ambos lados quedan en
// el "reloj de pared de Bogotá" y la comparación es consistente. El desfase es
// configurable por si el Form cambia de zona (env SHEETS_SRC_AHEAD_HOURS).

const RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

// Cuántas horas ADELANTE de Bogotá viene "Submitted At" (GMT-2 vs GMT-5 = 3h).
export const SRC_AHEAD_HOURS = () => Number(process.env.SHEETS_SRC_AHEAD_HOURS ?? 3);

// Devuelve el epoch (en el reloj de pared de Bogotá) en ms, o null si el valor no es
// una marca temporal válida (p.ej. el encabezado "Submitted At" → null → fuera de ventana).
export function parseSubmittedAt(value, aheadHours = SRC_AHEAD_HOURS()) {
  if (value == null) return null;
  const m = RE.exec(String(value).trim());
  if (!m) return null;

  const d = +m[1];
  const mo = +m[2];
  const y = +m[3];
  const h = +m[4];
  const mi = +m[5];
  const s = m[6] != null ? +m[6] : 0;

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  // Date.UTC sobre los componentes (naive) y luego desfase GMT-2 → Bogotá.
  return Date.UTC(y, mo - 1, d, h, mi, s) - aheadHours * 3600 * 1000;
}
