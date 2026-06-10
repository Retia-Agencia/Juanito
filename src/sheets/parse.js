// src/sheets/parse.js
// PURO. Parseo de la marca temporal "Submitted At" del Form → instante comparable.
//
// El valor llega como hora de pared local de Bogotá SIN zona horaria, en formato
// D/M/YYYY H:MM:SS (día primero, reloj de 24h, segundos opcionales). Ejemplos reales:
//   "9/6/2026 17:03:04", "10/6/2026 0:34:09"
//
// Lo convertimos a un epoch "naive" (Date.UTC sobre los componentes tal cual, sin
// aplicar zona). Mientras la ventana (window.js) se calcule con el MISMO criterio,
// la comparación es consistente y libre de bugs de zona horaria.

const RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

// Devuelve el epoch naive en ms, o null si el valor no es una marca temporal válida
// (p.ej. la fila de encabezado "Submitted At" → null → queda fuera de la ventana).
export function parseSubmittedAt(value) {
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
  return Date.UTC(y, mo - 1, d, h, mi, s);
}
