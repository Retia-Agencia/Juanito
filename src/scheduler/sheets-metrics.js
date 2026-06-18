// src/scheduler/sheets-metrics.js
// Cron del reporte diario de "métricas de desempeño" (§18.N). A las 20:00 lee una
// pestaña con las métricas YA CALCULADAS (otro spreadsheet) y la envía por DM a una
// lista de personas (el jefe y Sebastián Rodríguez), en paralelo al reporte de leads
// del grupo "Ventas EstadoX" (que es un job aparte y no se toca).
//
// El ENVÍO sale del proceso principal (tiene el socket de WA) y pasa por la cola
// anti-ban. El job se autodesactiva si falta la key del SA, el ID/pestaña, o los
// destinatarios — para no romper el arranque.

import { CronJob } from 'cron';
import { sendMessage } from '../whatsapp/index.js';
import { fetchSheetValues } from '../sheets/index.js';
import { formatMetrics } from '../sheets/metrics.js';
import { resolveRecipients } from './metrics-recipients.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const CRON = () => process.env.SHEETS_METRICS_CRON || '0 20 * * *';
const METRICS_ID = () => (process.env.SHEETS_METRICS_ID || '').trim();
const METRICS_TAB = () => (process.env.SHEETS_METRICS_TAB || '').trim();

export { resolveRecipients };

// Núcleo orquestador (sin cron): lee la pestaña → formatea. Exportado para el preview
// on-demand (/metricas) y para tests.
export async function buildMetricsReport({ now = new Date() } = {}) {
  const rows = await fetchSheetValues({ id: METRICS_ID(), tab: METRICS_TAB() });
  return { message: formatMetrics(rows, { now }), rows };
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
  const recipients = resolveRecipients();
  if (!recipients.length) {
    console.warn('[Métricas] sin SHEETS_METRICS_RECIPIENTS → reporte de métricas desactivado');
    return;
  }

  new CronJob(
    CRON(),
    async () => {
      try {
        const { message } = await buildMetricsReport();
        // Un fallo a un destinatario no debe frenar al otro (cada envío con su catch).
        for (const to of recipients) {
          await sendMessage(to, message).catch((e) =>
            console.error(`[Métricas] error enviando a ${to}:`, e.message)
          );
        }
        console.log(`[Métricas] reporte enviado a ${recipients.length} destinatario(s)`);
      } catch (e) {
        console.error('[Métricas] error en el reporte de métricas:', e.message);
      }
    },
    null,
    true,
    TZ()
  );
  console.log(
    `[Métricas] Job de métricas activo ✅ (cron "${CRON()}", ${resolveRecipients().length} destinatario(s))`
  );
}
