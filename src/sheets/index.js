// src/sheets/index.js
// API pública del módulo de reporte diario desde Google Sheets (§18.B).
//
// Reparto de responsabilidades (un archivo por concern):
//   columns.js    índices de columna + definición de categorías del desglose
//   parse.js      PURO  — parseSubmittedAt (D/M/YYYY H:MM:SS → epoch naive)
//   window.js     PURO  — ventana [ayer 20:00, hoy 20:00) America/Bogota
//   aggregate.js  PURO  — summarize(rows, window) → total + conteos/% por categoría
//   report.js     PURO  — formatReport(summary, window) → mensaje WhatsApp sin PII
//   client.js     IMPURO— fetchLeadRows() lee el Sheet (pendiente del service account)
//
// El cron que orquesta todo esto vive en src/scheduler/sheets-report.js (pendiente).

export { COL, CATEGORIES, SETTEO } from './columns.js';
export { parseSubmittedAt } from './parse.js';
export {
  zonedParts,
  computeWindow,
  toNaiveMs,
  startOfWeekMonday,
  lastFullWeekWindow,
  partialWeekWindows,
} from './window.js';
export { summarize, countSelfCheckout, countCohortStudents, averagePriorDays } from './aggregate.js';
export { windowTotals, buildWeeklySections } from './weekly.js';
export { formatReport, formatWeeklySections } from './report.js';
export { formatMetrics, COMPANIES } from './metrics.js';
export {
  fetchLeadRows,
  fetchSetteoRows,
  fetchCohortRows,
  fetchSheetValues,
  LEADS_ID,
  LEADS_TAB,
  SETTEO_TAB,
  COHORT_TAB,
  COHORT_LABEL,
} from './client.js';
