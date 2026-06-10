// src/sheets/client.js
// IMPURO. Lector del Google Sheet de leads vía Sheets API v4. Es el ÚNICO archivo
// del módulo que toca la red; el resto (parse/window/aggregate/report) es puro y
// testeable sin credenciales.
//
// ── PENDIENTE: requiere que el owner entregue el service account ──────────────────
// Checklist (ver §18.B del handoff):
//   1. Crear un service account en GCP + habilitar "Google Sheets API".
//   2. Generar su JSON key → llega al VPS como secreto (env GOOGLE_SA_KEY), NO al repo.
//   3. Compartir el Sheet (…JmtlV4) con el email del SA, permiso Viewer.
//
// Env que consumirá:
//   GOOGLE_SA_KEY     JSON del service account (o path a un archivo montado).
//   SHEETS_LEADS_ID   ID del Sheet (default abajo).
//   SHEETS_LEADS_TAB  Nombre de la pestaña a leer.
//
// Plan de implementación (sin dependencias nuevas): firmar un JWT RS256 con la
// private_key del SA usando el `crypto` nativo, intercambiarlo por un access token
// en https://oauth2.googleapis.com/token, y llamar
//   GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{tab}
// devolviendo `data.values` (arreglo de filas). Eso alimenta a summarize().

export const LEADS_ID = () =>
  process.env.SHEETS_LEADS_ID || '1pg3cP9w9ag7Re8QF5ZM8S2ktNwMRZDCihE7UYJmtlV4';

export const LEADS_TAB = () => process.env.SHEETS_LEADS_TAB || 'IA para abogados _ EstadoX';

// Devuelve las filas crudas del tab (arreglo de arreglos de celdas), encabezado
// incluido. summarize() tolera el encabezado (no parsea como fecha → fuera de ventana).
export async function fetchLeadRows() {
  throw new Error(
    '[sheets] fetchLeadRows aún no implementado: falta el service account (GOOGLE_SA_KEY). Ver §18.B.'
  );
}
