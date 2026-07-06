// src/scheduler/setting.js
// Cron del setteo a leads que no agendaron (§18.AD). Enrola + entrega en cada tick.
// Se AUTODESACTIVA si faltan las credenciales de Twilio (Cloud API) o GOOGLE_SA_KEY
// (para leer el Sheet de EstadoX) — mismo patrón que startCalendlyJobs.
//
// La cadencia real (toque 1 a las ~2h, toque 2 a las ~48h) la maneja la lógica pura;
// el cron solo despierta cada N minutos para enrolar leads nuevos y entregar vencidos.

import { CronJob } from 'cron';
import { runSettingCycle, hasCloudApiCreds } from '../setting/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const SETTING_CRON = () => process.env.SETTING_CRON || '*/10 * * * *'; // cada 10 min

export function startSettingJob() {
  if (!hasCloudApiCreds()) {
    console.warn('[Setteo] credenciales Twilio ausentes (TWILIO_ACCOUNT_SID/AUTH_TOKEN/WA_FROM) — job desactivado');
    return;
  }
  if (!process.env.GOOGLE_SA_KEY) {
    console.warn('[Setteo] GOOGLE_SA_KEY ausente — no puedo leer el Sheet de EstadoX — job desactivado');
    return;
  }
  new CronJob(SETTING_CRON(), () => runSettingCycle().catch((e) => console.error('[Setteo] ciclo falló:', e.message)), null, true, TZ());
  const mode = process.env.SETTING_DRY_RUN !== 'false' ? 'DRY-RUN (no envía)' : 'ENVÍO REAL ⚠️';
  console.log(`[Setteo] Job de setteo activo ✅ — ${mode}`);
}
