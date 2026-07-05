// src/stripe/index.js
// API pública del módulo de pagos reales (Stripe) que alimenta el `pagaron:` del
// reporte diario de EstadoX. Reemplaza la cuenta tagueada a mano en el Sheet (que
// tenía falsos positivos) por la verdad de Stripe: PaymentIntents `succeeded`.
//
// Reparto (mismo criterio que src/sheets/):
//   count.js   PURO  — windowToUnixSeconds + countPaid (bucketizables por día)
//   client.js  IMPURO— fetchPaidIntents() baja los intents de la ventana (1× red)
//
// El cableado al cron vive en src/scheduler/sheets-report.js; se activa solo si hay
// STRIPE_API_KEY, y si falla cae a la cuenta del Sheet (no rompe el reporte).

export { tzOffsetMs, windowToUnixSeconds, countPaid, paidTodayAndAvg } from './count.js';
export { fetchPaidIntents, STRIPE_API_KEY } from './client.js';
