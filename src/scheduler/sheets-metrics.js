// src/scheduler/sheets-metrics.js
// Cron del reporte diario de "métricas de desempeño" (§18.N). A las 22:00 lee la
// pestaña con las métricas YA CALCULADAS (otro spreadsheet) y publica CADA SECCIÓN en
// su grupo de WhatsApp: cada programa (AI SECOND BRAIN / ESTADOX / LINKEDIN SALES) en su
// propio grupo (ya NO va por DM). Corre en paralelo al reporte de leads del grupo
// "Ventas EstadoX" (job aparte).
//
// El ENVÍO sale del proceso principal (tiene el socket de WA) y pasa por la cola
// anti-ban. El job se autodesactiva si falta la key del SA, el ID/pestaña, o el mapeo
// de secciones a grupos.

import { CronJob } from 'cron';
import { sendMessage, resolveGroupByName } from '../whatsapp/index.js';
import { fetchSheetValues } from '../sheets/index.js';
import { formatMetrics } from '../sheets/metrics.js';
import { sectionTargets } from './metrics-targets.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const CRON = () => process.env.SHEETS_METRICS_CRON || '0 22 * * *';
const METRICS_ID = () => (process.env.SHEETS_METRICS_ID || '').trim();
const METRICS_TAB = () => (process.env.SHEETS_METRICS_TAB || '').trim();

export { sectionTargets };

// Un grupo puede venir como group_id (…@g.us) o como NOMBRE (se resuelve en runtime).
async function resolveTarget(t) {
  if (!t) return null;
  if (t.endsWith('@g.us')) return t;
  const g = await resolveGroupByName(t);
  return g?.id || null;
}

// Núcleo orquestador: lee la pestaña → formatea. Sin `company` devuelve el reporte
// COMPLETO (preview /reportes metricas); con `company` devuelve sólo esa sección.
export async function buildMetricsReport({ now = new Date(), company } = {}) {
  const rows = await fetchSheetValues({ id: METRICS_ID(), tab: METRICS_TAB() });
  return { message: formatMetrics(rows, { now, company }), rows };
}

export function startSheetsMetricsJob() {
  if (!process.env.GOOGLE_SA_KEY) {
    console.warn('[Métricas] sin GOOGLE_SA_KEY → reporte de métricas desactivado');
    return;
  }
  if (!METRICS_ID() || !METRICS_TAB()) {
    console.warn('[Métricas] sin SHEETS_METRICS_ID/TAB → reporte de métricas desactivado');
    return;
  }
  const targets = sectionTargets();
  if (!targets.length) {
    console.warn('[Métricas] sin grupos por sección (SHEETS_METRICS_30X_GROUP / _ESTADOX_GROUP / _LINKEDIN_GROUP) → desactivado');
    return;
  }

  new CronJob(
    CRON(),
    async () => {
      try {
        const rows = await fetchSheetValues({ id: METRICS_ID(), tab: METRICS_TAB() });
        for (const { company, group } of targets) {
          const target = await resolveTarget(group);
          if (!target) {
            console.error(`[Métricas] no pude resolver el grupo "${group}" para ${company} (¿Juanito está en el grupo?)`);
            continue;
          }
          const message = formatMetrics(rows, { company });
          await sendMessage(target, message).catch((e) =>
            console.error(`[Métricas] envío ${company} → ${group}:`, e.message)
          );
        }
      } catch (e) {
        console.error('[Métricas] error en el reporte de métricas:', e.message);
      }
    },
    null,
    true,
    TZ()
  );
  console.log(`[Métricas] Job de métricas activo ✅ (cron "${CRON()}", ${targets.length} sección/es → grupos)`);
}
