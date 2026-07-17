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
import { hasDmThread, getOutcomesInWindow } from '../db/index.js';
import { fetchLeadRows, fetchSetteoRows } from '../sheets/index.js';
import { computeWindow, toNaiveMs } from '../sheets/window.js';
import { summarize, countSelfCheckout, averagePriorDays } from '../sheets/aggregate.js';
import { buildWeeklySections } from '../sheets/weekly.js';
import { formatReport } from '../sheets/report.js';
import { formatEstadoxAdminReport, invBreakdown } from '../sheets/estadox-report.js';
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

// Entrega el reporte a quien corresponda: el grupo (solo si está habilitado) + los DMs.
// Devuelve cuántos envíos salieron.
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

  enviados += await deliverToDMs(message, DM_RECIPIENTS());
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

// Núcleo orquestador (sin cron): lee → cuenta → formatea. Devuelve el mensaje y el
// resumen para que el caller (o una prueba) decida qué hacer.
// Días de historial a pedirle a Stripe: cubre la semana previa a la pasada (~21d)
// y la parcial más vieja (~27d), con margen.
const STRIPE_LOOKBACK_DAYS = 35;

export async function buildSheetsReport({ now = new Date() } = {}) {
  const win = computeWindow(now);
  // El total/Calendly salen del tab de leads; el self-checkout del tab "Setteo Pendiente".
  const [rows, setteoRows] = await Promise.all([fetchLeadRows(), fetchSetteoRows()]);
  // Sin desglose por categorías (pedido del owner 2026-07-09: fuera la sección de
  // "Dispuesto a invertir $1000 USD") y sin prom. 7d — la comparación histórica
  // ahora es el bloque semanal en promedio diario.
  const summary = { ...summarize(rows, win, []), selfCheckout: countSelfCheckout(setteoRows, win) };

  // Pagos reales (PaymentIntents succeeded) si hay key; si Stripe falla, el reporte
  // sale igual con el tag manual del Sheet — nunca tumba el job.
  let paymentsNaive = null;
  if (STRIPE_API_KEY()) {
    try {
      const createdGteSec = Math.floor(now.getTime() / 1000) - STRIPE_LOOKBACK_DAYS * 24 * 3600;
      const secs = await fetchSucceededPaymentTimestamps({ createdGteSec });
      paymentsNaive = secs.map((s) => toNaiveMs(new Date(s * 1000)));
    } catch (e) {
      console.warn('[Sheets] Stripe falló, uso el tag del Sheet:', e.message);
    }
  }
  if (paymentsNaive) {
    summary.stripeToday = paymentsNaive.filter((ms) => ms >= win.startMs && ms < win.endMs).length;
  }
  // Comparativas: semana pasada completa (lun-dom) + últimas 4 semanas like-for-like.
  summary.weekly = buildWeeklySections(rows, setteoRows, now, paymentsNaive);

  return { message: formatReport(summary, win), summary, win };
}

// Bogotá es UTC-5 fijo (sin DST). La ventana de window.js viene en epoch "naive"
// (hora de pared de Bogotá); sumarle 5h da el instante UTC real, que es como
// call_outcomes guarda `call_start` (toSqliteUtc → ISO UTC "YYYY-MM-DD HH:MM:SS").
const BOGOTA_OFFSET_MS = 5 * 3600 * 1000;
const naiveToSqliteUtc = (naiveMs) =>
  new Date(naiveMs + BOGOTA_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');

// Llamadas efectivas del día = calls del programa `program` cuyo call_start cae en la
// ventana y el closer marcó "Show" en el Push 4. ⚠️ Solo cuenta calls de closers con
// Push 4 activo (allowlist CALENDLY_PUSH4_CLOSERS); si un closer de abogados no está
// en esa lista, su call no aparece acá.
function countEfectivas(win, program = 'abogados') {
  const fromUtc = naiveToSqliteUtc(win.startMs);
  const toUtc = naiveToSqliteUtc(win.endMs);
  let efectivas = 0;
  for (const r of getOutcomesInWindow(fromUtc, toUtc)) {
    if (program && r.program !== program) continue;
    if (r.asistencia === 'show') efectivas += 1;
  }
  return efectivas;
}

// Payment Link del self-checkout de EstadoX (§18.AD). Si está vacío, el conteo por Stripe
// se apaga solo y el reporte sigue con el tag del Sheet — regla del repo: ningún job se
// cae por falta de config.
const SELF_CHECKOUT_PLINK = () => (process.env.STRIPE_SELF_CHECKOUT_PLINK || '').trim();

// Margen hacia atrás al listar Checkout Sessions: se filtra por el `created` de la Session
// pero se cuenta por el del PaymentIntent, que es posterior. Una Session de payment link
// expira a las 24h → 48h de margen cubre cualquier pago de la ventana con holgura. El
// exceso lo descarta el filtro de ventana de abajo; solo cuesta unas filas de más.
const SESSION_LOOKBACK_SEC = 48 * 3600;

// Pagos por self-checkout dentro de la ventana, atribuidos por Payment Link en vez de por
// el tag manual del Sheet. Devuelve null si no hay key/link o si Stripe falla — el caller
// trata null como "no se pudo medir", que NO es lo mismo que cero.
async function countSelfCheckoutFromStripe(win) {
  const plink = SELF_CHECKOUT_PLINK();
  if (!STRIPE_API_KEY() || !plink) return null;
  try {
    // win.startMs es epoch "naive" (hora de pared de Bogotá); +5h lo lleva al instante UTC
    // real, que es la escala en la que Stripe filtra `created`.
    const createdGteSec =
      Math.floor((win.startMs + BOGOTA_OFFSET_MS) / 1000) - SESSION_LOOKBACK_SEC;
    const secs = await fetchSucceededPaymentTimestampsForLink({
      paymentLink: plink,
      createdGteSec,
    });
    const naive = secs.map((s) => toNaiveMs(new Date(s * 1000)));
    return naive.filter((ms) => ms >= win.startMs && ms < win.endMs).length;
  } catch (e) {
    console.warn('[Sheets][EstadoX] self-checkout por link falló:', e.message);
    return null;
  }
}

// Reporte ADMIN de EstadoX (§18.AD) — el mensaje DISTINTO que pidió Mariana. Reusa las
// mismas fuentes que el reporte estándar (Sheet de leads + tab Setteo + Stripe) más los
// outcomes del Push 4 para las llamadas efectivas. Devuelve mensaje + data para pruebas.
export async function buildEstadoxAdminReport({ now = new Date() } = {}) {
  const win = computeWindow(now);
  const [rows, setteoRows] = await Promise.all([fetchLeadRows(), fetchSetteoRows()]);

  const today = summarize(rows, win); // total + desglose inversión + calendlyBooked
  const avg30 = averagePriorDays(rows, setteoRows, now, 30).total;
  const sc = countSelfCheckout(setteoRows, win);

  // Total de pagos Stripe del día (para derivar "fuera de self-checkout" = total − SC).
  // Si Stripe falla, stripeToday queda null y el formatter muestra "n/d".
  let stripeToday = null;
  if (STRIPE_API_KEY()) {
    try {
      const createdGteSec = Math.floor(now.getTime() / 1000) - STRIPE_LOOKBACK_DAYS * 24 * 3600;
      const secs = await fetchSucceededPaymentTimestamps({ createdGteSec });
      const naive = secs.map((s) => toNaiveMs(new Date(s * 1000)));
      stripeToday = naive.filter((ms) => ms >= win.startMs && ms < win.endMs).length;
    } catch (e) {
      console.warn('[Sheets][EstadoX] Stripe falló, "fuera de self-checkout" saldrá n/d:', e.message);
    }
  }

  // EN OBSERVACIÓN (desde 2026-07-16): el mensaje sigue usando el tag manual del Sheet
  // (`sc.paid`); el conteo por Payment Link corre al lado y solo se loguea. Cuando el log
  // muestre varios días sin DIFF, `scPaid` pasa a ser `scPaidStripe`, el tag deja de leerse
  // para esta métrica y esto se borra. Si aparece DIFF, el log dice cuál de los dos miente
  // ANTES de que el número llegue a Mariana.
  const scPaidStripe = await countSelfCheckoutFromStripe(win);
  if (scPaidStripe != null) {
    const ok = scPaidStripe === sc.paid;
    console.log(
      `[EstadoX] scPaid — sheet:${sc.paid} stripe:${scPaidStripe} ${ok ? '✓' : '⚠ DIFF'}`
    );
  }

  const data = {
    total: today.total,
    avg30,
    inv: invBreakdown(today.breakdown),
    agendadas: today.calendlyBooked,
    efectivas: countEfectivas(win, 'abogados'),
    scPaid: sc.paid,
    scPaidStripe, // en observación, todavía no sale en el mensaje — ver nota arriba
    stripeToday,
  };
  return { message: formatEstadoxAdminReport(data, win), data, win };
}

export function startSheetsReportJob() {
  if (!process.env.GOOGLE_SA_KEY) {
    console.warn('[Sheets] sin GOOGLE_SA_KEY → reporte diario desactivado');
    return;
  }

  const dms = DM_RECIPIENTS();
  const estadoxDms = ESTADOX_DM_RECIPIENTS();
  const grupo = GROUP_ENABLED() && TARGET();
  if (!dms.length && !estadoxDms.length && !grupo) {
    console.warn(
      '[Sheets] sin destinatarios (grupo apagado, sin SHEETS_REPORT_DM ni SHEETS_REPORT_ESTADOX_DM) → reporte diario desactivado'
    );
    return;
  }

  // Los dos reportes son EXCLUYENTES por destinatario: quien está en la lista de EstadoX
  // recibe el mensaje admin EN LUGAR del estándar. Estar en ambas listas no rompe nada,
  // pero le llegan dos reportes el mismo día — casi siempre es un error de config.
  const enAmbas = estadoxDms.filter((j) => dms.includes(j));
  if (enAmbas.length) {
    console.warn(
      `[Sheets] ⚠️ ${enAmbas.join(', ')} está en SHEETS_REPORT_DM y en SHEETS_REPORT_ESTADOX_DM → recibirá los DOS reportes. ¿Querías solo el admin?`
    );
  }

  new CronJob(
    CRON(),
    async () => {
      // Los dos reportes van en try/catch separados a propósito: si el admin de EstadoX
      // falla (Stripe caído, Sheet raro), el reporte estándar sale igual, y al revés.
      try {
        const { message, summary } = await buildSheetsReport();
        const n = await deliverReport(message);
        console.log(`[Sheets] reporte diario: ${n} envío(s) (${summary.total} entradas)`);
      } catch (e) {
        console.error('[Sheets] error en el reporte diario:', e.message);
      }

      if (!ESTADOX_DM_RECIPIENTS().length) return;
      try {
        const { message, data } = await buildEstadoxAdminReport();
        const n = await deliverToDMs(message, ESTADOX_DM_RECIPIENTS(), 'EstadoX');
        console.log(`[EstadoX] reporte admin: ${n} envío(s) (${data.total} typeforms)`);
      } catch (e) {
        console.error('[EstadoX] error en el reporte admin:', e.message);
      }
    },
    null,
    true,
    TZ()
  );
  console.log(
    `[Sheets] Job de reporte diario activo ✅ (cron "${CRON()}", grupo: ${grupo ? `"${TARGET()}"` : 'APAGADO'}, DMs: ${dms.length}, DMs admin EstadoX: ${estadoxDms.length})`
  );
}
