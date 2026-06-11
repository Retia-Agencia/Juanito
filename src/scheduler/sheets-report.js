// src/scheduler/sheets-report.js
// Cron del reporte diario de leads (§18.B). A las 20:00 (America/Bogota) lee el
// Sheet, cuenta las entradas de la ventana [ayer 20:00, hoy 20:00), arma el mensaje
// (sin PII) y lo publica en el grupo "Ventas EstadoX".
//
// El ENVÍO sale del proceso principal (tiene el socket de WA); un `node -e` aparte
// no podría mandar el mensaje. El job se autodesactiva si falta la key del service
// account o el grupo destino, para no romper el arranque.

import { CronJob } from 'cron';
import { sendMessage, resolveGroupByName } from '../whatsapp/index.js';
import { fetchLeadRows, fetchSetteoRows } from '../sheets/index.js';
import { computeWindow } from '../sheets/window.js';
import { summarize, countSelfCheckout } from '../sheets/aggregate.js';
import { formatReport } from '../sheets/report.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const CRON = () => process.env.SHEETS_REPORT_CRON || '0 20 * * *';
const TARGET = () => (process.env.SHEETS_REPORT_GROUP || '').trim();

// SHEETS_REPORT_GROUP puede ser un group_id (…@g.us) o el NOMBRE del grupo, que se
// resuelve a id en runtime vía resolveGroupByName (más robusto que hardcodear el id).
async function resolveTarget() {
  const t = TARGET();
  if (!t) return null;
  if (t.endsWith('@g.us')) return t;
  const g = await resolveGroupByName(t);
  return g?.id || null;
}

// Núcleo orquestador (sin cron): lee → cuenta → formatea. Devuelve el mensaje y el
// resumen para que el caller (o una prueba) decida qué hacer.
export async function buildSheetsReport({ now = new Date() } = {}) {
  const win = computeWindow(now);
  // El total/Calendly salen del tab de leads; el self-checkout del tab "Setteo Pendiente".
  const [rows, setteoRows] = await Promise.all([fetchLeadRows(), fetchSetteoRows()]);
  const summary = { ...summarize(rows, win), selfCheckout: countSelfCheckout(setteoRows, win) };
  return { message: formatReport(summary, win), summary, win };
}

export function startSheetsReportJob() {
  if (!process.env.GOOGLE_SA_KEY) {
    console.warn('[Sheets] sin GOOGLE_SA_KEY → reporte diario desactivado');
    return;
  }
  if (!TARGET()) {
    console.warn('[Sheets] sin SHEETS_REPORT_GROUP → reporte diario desactivado');
    return;
  }

  new CronJob(
    CRON(),
    async () => {
      try {
        const target = await resolveTarget();
        if (!target) {
          console.error(`[Sheets] no pude resolver el grupo destino "${TARGET()}" (¿Juanito está en el grupo?)`);
          return;
        }
        const { message, summary } = await buildSheetsReport();
        await sendMessage(target, message);
        console.log(`[Sheets] reporte enviado → ${target} (${summary.total} entradas)`);
      } catch (e) {
        console.error('[Sheets] error en el reporte diario:', e.message);
      }
    },
    null,
    true,
    TZ()
  );
  console.log(`[Sheets] Job de reporte diario activo ✅ (cron "${CRON()}", grupo "${TARGET()}")`);
}
