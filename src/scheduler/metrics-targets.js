// src/scheduler/metrics-targets.js
// PURO (sin deps). Mapea cada sección del reporte de métricas (empresa) a su grupo de
// WhatsApp destino. El reporte diario ya NO va por DM: la sección 30X se publica en un
// grupo y la de ESTADOX en otro (§18.N).
//
//   SHEETS_METRICS_30X_GROUP      → grupo para la sección "30X"
//   SHEETS_METRICS_ESTADOX_GROUP  → grupo para la sección "ESTADOX"
//
// El valor puede ser el NOMBRE del grupo (se resuelve en runtime) o un group_id (…@g.us).
// Sólo se incluyen las secciones que tengan grupo configurado.

export function sectionTargets() {
  return [
    { company: '30X', group: (process.env.SHEETS_METRICS_30X_GROUP || '').trim() },
    { company: 'ESTADOX', group: (process.env.SHEETS_METRICS_ESTADOX_GROUP || '').trim() },
  ].filter((s) => s.group);
}
