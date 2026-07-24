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
import { hasDmThread } from '../db/index.js';
import { fetchLeadRows, fetchSetteoRows, fetchCohortRows, COHORT_TAB, COHORT_LABEL } from '../sheets/index.js';
import { computeWindow, toNaiveMs } from '../sheets/window.js';
import { summarize, countSelfCheckout, countCohortStudents } from '../sheets/aggregate.js';
import { buildWeeklySections } from '../sheets/weekly.js';
import { formatReport } from '../sheets/report.js';
import {
  STRIPE_API_KEY,
  fetchSucceededPaymentTimestamps,
  fetchSucceededPaymentTimestampsForLink,
} from '../stripe/client.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const CRON = () => process.env.SHEETS_REPORT_CRON || '0 20 * * *';
const TARGET = () => (process.env.SHEETS_REPORT_GROUP || '').trim();

// El reporte al GRUPO está apagado desde el 2026-07-08 (pedido de Dani). `SHEETS_REPORT_GROUP`
// sigue configurado en el VPS, así que el apagado NO puede depender de que esa var esté vacía:
// hace falta un flag explícito. Sin él, reactivar el job para mandarle el DM a la admin de
// EstadoX (§18.AD) volvería a publicar en "Ventas EstadoX" sin que nadie lo pidiera.
const GROUP_ENABLED = () => process.env.SHEETS_REPORT_GROUP_ENABLED === 'true';

// Destinatarios por DM (§18.AD): JIDs de WhatsApp (CSV). Debe ser el JID desde el que la
// persona LE ESCRIBIÓ a Juanito (`/whoami` se lo dice), o no hay hilo y no se entrega.
const DM_RECIPIENTS = () =>
  (process.env.SHEETS_REPORT_DM || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Destinatarios del reporte ADMIN de EstadoX (§18.AD): reciben el mensaje DISTINTO
// (5 métricas que pidió Mariana el 2026-07-15) EN LUGAR del reporte estándar de leads.
// Mismo requisito de hilo previo que cualquier DM (anti-ban).
const ESTADOX_DM_RECIPIENTS = () =>
  (process.env.SHEETS_REPORT_ESTADOX_DM || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// SHEETS_REPORT_GROUP puede ser un group_id (…@g.us) o el NOMBRE del grupo, que se
// resuelve a id en runtime vía resolveGroupByName (más robusto que hardcodear el id).
async function resolveTarget() {
  const t = TARGET();
  if (!t) return null;
  if (t.endsWith('@g.us')) return t;
  const g = await resolveGroupByName(t);
  return g?.id || null;
}

// Entrega EL MISMO reporte a todos (unificado 2026-07-17): el grupo (solo si está
// habilitado) + la unión de SHEETS_REPORT_DM y SHEETS_REPORT_ESTADOX_DM. Antes esas dos
// listas recibían mensajes distintos (estándar vs. 5 métricas); ahora ambas reciben el
// reporte estándar rediseñado. Dedup por si un JID está en las dos listas. Devuelve
// cuántos envíos salieron.
async function deliverReport(message) {
  let enviados = 0;

  if (GROUP_ENABLED() && TARGET()) {
    const target = await resolveTarget();
    if (!target) {
      console.error(`[Sheets] no pude resolver el grupo destino "${TARGET()}" (¿Juanito está en el grupo?)`);
    } else {
      await sendMessage(target, message);
      console.log(`[Sheets] reporte enviado → grupo ${target}`);
      enviados++;
    }
  }

  const dmTargets = [...new Set([...DM_RECIPIENTS(), ...ESTADOX_DM_RECIPIENTS()])];
  enviados += await deliverToDMs(message, dmTargets);
  return enviados;
}

// Entrega un mensaje a una lista de DMs, respetando el requisito de hilo previo
// (anti-ban §18.D). Reutilizado por el reporte estándar y el reporte admin de EstadoX.
async function deliverToDMs(message, recipients, tag = 'Sheets') {
  let enviados = 0;
  for (const to of recipients) {
    // Anti-ban: nunca en frío. Sin hilo previo, no se entrega.
    if (!hasDmThread(to)) {
      console.warn(
        `[${tag}] OMITIDO → ${to}: no tiene hilo con Juanito. Que le escriba un mensaje primero (anti-ban).`
      );
      continue;
    }
    try {
      await sendMessage(to, message);
      console.log(`[${tag}] reporte enviado → DM ${to}`);
      enviados++;
    } catch (e) {
      console.error(`[${tag}] fallo enviando el reporte a ${to}:`, e.message);
    }
  }
  return enviados;
}

// Payment Link del self-checkout de EstadoX. Si está vacío, el split auto/call cae al tag
// del Sheet — regla del repo: ningún job se cae por falta de config.
const SELF_CHECKOUT_PLINK = () => (process.env.STRIPE_SELF_CHECKOUT_PLINK || '').trim();

// Núcleo orquestador (sin cron): lee → cuenta → formatea. Devuelve el mensaje y el
// resumen para que el caller (o una prueba) decida qué hacer.
// Días de historial a pedirle a Stripe: con 5 semanas like-for-like la parcial más
// vieja queda a ~32d (lun de hace 4 semanas), y la prev-week del historyOk a ~14d.
// 42d (6 semanas) las cubre con margen. Volumen bajo → el tope de paginación holgado.
const STRIPE_LOOKBACK_DAYS = 42;

export async function buildSheetsReport({ now = new Date() } = {}) {
  const win = computeWindow(now);
  // El total/Calendly salen del tab de leads; el self-checkout del tab "Setteo Pendiente".
  const [rows, setteoRows] = await Promise.all([fetchLeadRows(), fetchSetteoRows()]);
  // Sin desglose por categorías (pedido del owner 2026-07-09: fuera la sección de
  // "Dispuesto a invertir $1000 USD") y sin prom. 7d — la comparación histórica
  // ahora es el bloque semanal en promedio diario.
  const summary = { ...summarize(rows, win, []), selfCheckout: countSelfCheckout(setteoRows, win) };

  // Estudiantes confirmados de la cohorte actual (§18.B). Solo si el tab está configurado;
  // si la lectura falla, se omite la línea y el reporte sale igual (regla del repo).
  if (COHORT_TAB()) {
    try {
      const cohortRows = await fetchCohortRows();
      summary.cohort = { label: COHORT_LABEL(), count: countCohortStudents(cohortRows) };
    } catch (e) {
      console.warn('[Sheets] cohorte no disponible, se omite del reporte:', e.message);
    }
  }

  // Pagos reales (PaymentIntents succeeded) si hay key; si Stripe falla, el reporte
  // sale igual con el tag manual del Sheet — nunca tumba el job.
  let paymentsNaive = null;
  let selfCheckoutNaive = null;
  if (STRIPE_API_KEY()) {
    try {
      const createdGteSec = Math.floor(now.getTime() / 1000) - STRIPE_LOOKBACK_DAYS * 24 * 3600;
      const secs = await fetchSucceededPaymentTimestamps({ createdGteSec });
      paymentsNaive = secs.map((s) => toNaiveMs(new Date(s * 1000)));

      // Self-checkout atribuido por Payment Link (§18.AD): subconjunto de `paymentsNaive`
      // que permite partir los pagos del bloque semanal en 💳 auto (checkout automático)
      // vs 📞 call (cerrado en llamada = total − auto). Si no hay link configurado o Stripe
      // falla acá, `auto` cae al tag del Sheet — el bloque sale igual (regla del repo).
      const plink = SELF_CHECKOUT_PLINK();
      if (plink) {
        try {
          const scSecs = await fetchSucceededPaymentTimestampsForLink({ paymentLink: plink, createdGteSec });
          selfCheckoutNaive = scSecs.map((s) => toNaiveMs(new Date(s * 1000)));
        } catch (e) {
          console.warn('[Sheets] self-checkout por link falló, "auto" cae al tag del Sheet:', e.message);
        }
      }
    } catch (e) {
      console.warn('[Sheets] Stripe falló, uso el tag del Sheet:', e.message);
    }
  }
  if (paymentsNaive) {
    summary.stripeToday = paymentsNaive.filter((ms) => ms >= win.startMs && ms < win.endMs).length;
  }
  // Tendencia semanal compacta: últimas 5 semanas like-for-like (lun → corte de hoy),
  // pagos partidos en auto/call por el Payment Link del self-checkout.
  summary.weekly = buildWeeklySections(rows, setteoRows, now, paymentsNaive, {
    weeks: 5,
    selfCheckoutNaiveMs: selfCheckoutNaive,
  });

  return { message: formatReport(summary, win), summary, win };
}

export function startSheetsReportJob() {
  if (!process.env.GOOGLE_SA_KEY) {
    console.warn('[Sheets] sin GOOGLE_SA_KEY → reporte diario desactivado');
    return;
  }

  // Unión de destinatarios de DM (unificado 2026-07-17): las dos listas reciben el MISMO
  // reporte, así que se deduplican. SHEETS_REPORT_ESTADOX_DM se conserva como alias para
  // no romper la config del VPS; funcionalmente ya es equivalente a SHEETS_REPORT_DM.
  const dms = [...new Set([...DM_RECIPIENTS(), ...ESTADOX_DM_RECIPIENTS()])];
  const grupo = GROUP_ENABLED() && TARGET();
  if (!dms.length && !grupo) {
    console.warn(
      '[Sheets] sin destinatarios (grupo apagado, sin SHEETS_REPORT_DM ni SHEETS_REPORT_ESTADOX_DM) → reporte diario desactivado'
    );
    return;
  }

  new CronJob(
    CRON(),
    async () => {
      try {
        const { message, summary } = await buildSheetsReport();
        const n = await deliverReport(message);
        console.log(`[Sheets] reporte diario: ${n} envío(s) (${summary.total} entradas)`);
      } catch (e) {
        console.error('[Sheets] error en el reporte diario:', e.message);
      }
    },
    null,
    true,
    TZ()
  );
  console.log(
    `[Sheets] Job de reporte diario activo ✅ (cron "${CRON()}", grupo: ${grupo ? `"${TARGET()}"` : 'APAGADO'}, DMs: ${dms.length})`
  );
}
