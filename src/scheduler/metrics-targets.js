// src/scheduler/metrics-targets.js
// PURO (sin deps de runtime). Mapea cada sección del reporte de métricas (programa) a
// su grupo de WhatsApp destino. El reporte diario ya NO va por DM: cada sección se
// publica en su propio grupo (§18.N).
//
//   SHEETS_METRICS_30X_GROUP       → sección "AI SECOND BRAIN" (antes "30X")
//   SHEETS_METRICS_ESTADOX_GROUP   → sección "ESTADOX"
//   SHEETS_METRICS_LINKEDIN_GROUP  → sección "LINKEDIN SALES"
//
// El valor puede ser el NOMBRE del grupo (se resuelve en runtime) o un group_id (…@g.us).
// Sólo se incluyen las secciones que tengan grupo configurado. Las secciones (y su orden)
// son fuente única de verdad en `src/sheets/metrics.js`.

import { COMPANIES } from '../sheets/metrics.js';

// Programa (col A del sheet) → variable de entorno con su grupo destino. El nombre de la
// env de AI SECOND BRAIN se conserva como `_30X_` por retrocompatibilidad con el VPS.
const GROUP_ENV = {
  'AI SECOND BRAIN': 'SHEETS_METRICS_30X_GROUP',
  ESTADOX: 'SHEETS_METRICS_ESTADOX_GROUP',
  'LINKEDIN SALES': 'SHEETS_METRICS_LINKEDIN_GROUP',
};

export function sectionTargets() {
  return COMPANIES.map((company) => ({
    company,
    group: (process.env[GROUP_ENV[company]] || '').trim(),
  })).filter((s) => s.group);
}
