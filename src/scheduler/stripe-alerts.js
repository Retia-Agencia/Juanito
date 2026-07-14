// src/scheduler/stripe-alerts.js
// Aviso de pago en (casi) tiempo real a la admin de EstadoX (§18.AD).
//
// Por qué polling y no webhook: el `docker-compose.yml` NO expone puertos a propósito
// (Baileys es una conexión SALIENTE; abrir un puerto en el VPS es superficie de ataque y
// rompe esa premisa). Un cron que le pregunta a Stripe cada pocos minutos da la misma
// señal sin abrir nada.
//
// Anti-ban: el envío pasa por `hasDmThread()` — Juanito NUNCA le escribe en frío a alguien
// que no le ha escrito antes. Si la destinataria no tiene hilo, el aviso se salta y se
// avisa por log (no se encola ni se reintenta a ciegas).
//
// Dedup: cada PaymentIntent se marca con `markIfNew('stripe:<id>')`. La tabla vive en el
// volumen, así que un redeploy no reenvía avisos. La ventana del poll (minutos) es mucho
// más corta que la purga de esa tabla (7 días) → no hay forma de re-avisar un pago viejo.

import { CronJob } from 'cron';
import { STRIPE_API_KEY, fetchRecentPayments } from '../stripe/client.js';
import { buildPaymentAlert } from '../stripe/alerts.js';

// La DB (nativa) y WhatsApp se resuelven PEREZOSAMENTE: así los tests inyectan dobles y el
// módulo se puede importar sin compilar better-sqlite3 (mismo patrón que scheduler/calendly.js).
async function realDeps() {
  const [db, wa] = await Promise.all([import('../db/index.js'), import('../whatsapp/index.js')]);
  return {
    fetchRecentPayments,
    sendMessage: wa.sendMessage,
    markIfNew: db.markIfNew,
    hasDmThread: db.hasDmThread,
    getSetting: db.getSetting,
    setSetting: db.setSetting,
  };
}

const TZ = () => process.env.TZ || 'America/Bogota';
const CRON = () => process.env.STRIPE_ALERT_CRON || '*/5 * * * *';
const LOOKBACK_MIN = () => Number(process.env.STRIPE_ALERT_LOOKBACK_MIN || 120);

// Destinatarios del aviso: JIDs de WhatsApp (CSV). Debe ser el JID desde el que la persona
// LE ESCRIBIÓ a Juanito (`/whoami` se lo dice) — no un número suelto, o el hilo no existe.
const RECIPIENTS = () =>
  (process.env.STRIPE_ALERT_JIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const SEEDED_KEY = 'stripe_alerts_seeded';

// Núcleo sin cron (testeable / invocable a mano). Devuelve cuántos avisos salieron.
export async function runStripeAlerts({ now = new Date(), deps = null } = {}) {
  const recipients = RECIPIENTS();
  if (!recipients.length || !STRIPE_API_KEY()) return 0;

  const d = deps || (await realDeps());

  const createdGteSec = Math.floor(now.getTime() / 1000) - LOOKBACK_MIN() * 60;
  let pagos;
  try {
    pagos = await d.fetchRecentPayments({ createdGteSec });
  } catch (e) {
    console.warn('[StripeAlert] no pude leer Stripe:', e.message);
    return 0;
  }
  if (!pagos.length) return 0;

  // Arranque en frío: la PRIMERA vez solo se marcan los pagos ya existentes, sin avisar.
  // Si no, al desplegar la feature saldría una ráfaga con las últimas 2 horas de pagos.
  const seeded = d.getSetting(SEEDED_KEY);
  if (!seeded) {
    for (const p of pagos) d.markIfNew(`stripe:${p.id}`);
    d.setSetting(SEEDED_KEY, new Date(now).toISOString());
    console.log(`[StripeAlert] arranque en frío: ${pagos.length} pago(s) marcados sin avisar`);
    return 0;
  }

  const nuevos = pagos.filter((p) => d.markIfNew(`stripe:${p.id}`));
  if (!nuevos.length) return 0;

  let enviados = 0;
  for (const p of nuevos.sort((a, b) => a.created - b.created)) {
    const msg = buildPaymentAlert(p, { tz: TZ() });
    for (const to of recipients) {
      if (!d.hasDmThread(to)) {
        console.warn(
          `[StripeAlert] OMITIDO → ${to}: no tiene hilo con Juanito. Que le escriba un mensaje primero (anti-ban).`
        );
        continue;
      }
      try {
        await d.sendMessage(to, msg);
        enviados++;
      } catch (e) {
        console.error(`[StripeAlert] fallo enviando a ${to}:`, e.message);
      }
    }
  }
  if (enviados) console.log(`[StripeAlert] ${nuevos.length} pago(s) nuevo(s) → ${enviados} aviso(s)`);
  return enviados;
}

export function startStripeAlertsJob() {
  if (!STRIPE_API_KEY()) {
    console.warn('[StripeAlert] sin STRIPE_API_KEY → avisos de pago desactivados');
    return;
  }
  if (!RECIPIENTS().length) {
    console.warn('[StripeAlert] sin STRIPE_ALERT_JIDS → avisos de pago desactivados');
    return;
  }
  new CronJob(
    CRON(),
    () => runStripeAlerts().catch((e) => console.error('[StripeAlert]', e.message)),
    null,
    true,
    TZ()
  );
  console.log(
    `[StripeAlert] Avisos de pago activos ✅ (cron "${CRON()}", ${RECIPIENTS().length} destinatario(s))`
  );
}
