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
import { summarize, countSelfCheckout, averagePriorDays } from '../sheets/aggregate.js';
import { formatReport } from '../sheets/report.js';
import { STRIPE_API_KEY, fetchPaidIntents, paidTodayAndAvg } from '../stripe/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const DAY_MS = 24 * 3600 * 1000;

// Reemplaza el `pagaron:` (hoy + promedio de 7 días) por la verdad de Stripe cuando
// hay STRIPE_API_KEY. El `reached` (llegaron al self-checkout sin pagar) SIEMPRE se
// queda del Sheet: Stripe solo conoce pagos exitosos, no quién llegó y no pagó.
// Baja los intents del span más amplio (hoy + 7 previos) en UNA sola llamada. Si algo
// falla, deja la cuenta del Sheet intacta (no rompe el reporte) y lo registra.
async function applyStripePaid(summary, now) {
  if (!STRIPE_API_KEY()) return summary;
  try {
    // Span = desde el inicio de la ventana de hace 7 días hasta el fin de la de hoy.
    const span = {
      startMs: computeWindow(new Date(now.getTime() - 7 * DAY_MS)).startMs,
      endMs: computeWindow(now).endMs,
    };
    const { intents } = await fetchPaidIntents(span, { now });
    const { today, avgPrior } = paidTodayAndAvg(intents, now, { days: 7 });
    if (summary.selfCheckout) summary.selfCheckout.paid = today;
    if (summary.avg7) summary.avg7.paid = avgPrior;
    summary.paidSource = 'stripe';
    console.log(`[Stripe] pagos reales → hoy: ${today}, prom. 7d: ${avgPrior.toFixed(1)}`);
  } catch (e) {
    console.error('[Stripe] no pude leer pagos, uso la cuenta del Sheet:', e.message);
  }
  return summary;
}
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
  // Promedio de los 7 días previos (sin hoy) para comparar las métricas de funnel.
  summary.avg7 = averagePriorDays(rows, setteoRows, now, 7);
  // Si hay Stripe, el `pagaron:` (hoy y promedio) se sobreescribe con pagos reales.
  await applyStripePaid(summary, now);
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
