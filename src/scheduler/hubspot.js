// src/scheduler/hubspot.js
// Job de VALIDACIÓN de HubSpot como fuente del motor precall. Reusa el mismo digest de
// Calendly (runDigest) pero inyectándole una `source` que lee las citas de HubSpot en vez
// de Calendly. Se AUTODESACTIVA si falta HUBSPOT_TOKEN — mismo patrón que startCalendlyJobs.
//
// Fase 1 (esta): dos ventanas fijas — Push 1 (7pm, digest de MAÑANA) y Push 2 (6:30am,
// digest de HOY). Corre en DRY-RUN FORZADO (dryRunOverride): NUNCA envía, solo loguea con
// la etiqueta [HubSpot] para poder compararlo lado a lado contra [Calendly] y verificar que
// HubSpot ve exactamente las mismas citas antes de cortar. El poll de 25 min (Push 3) y
// Push 0/4 quedan para una fase 2.

import { CronJob } from 'cron';
import { runDigest } from './calendly.js';
import { hasHubspotCreds } from '../hubspot/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const PUSH1_CRON = () => process.env.HUBSPOT_PUSH1_CRON || '0 19 * * *'; // 7:00pm
const PUSH2_CRON = () => process.env.HUBSPOT_PUSH2_CRON || '30 6 * * *'; // 6:30am

// Construye la `source` que inyectamos a runDigest: liga la lectura de citas al adaptador
// de HubSpot y REUSA la DB + WhatsApp reales para los gates anti-ban/opt-in (mismos que
// Calendly, para que la comparación sea manzana-con-manzana y el cutover sea directo).
// dryRunOverride: true → jamás envía en esta fase. logLabel: 'HubSpot' → logs diferenciables.
let _source = null;
async function buildSource() {
  if (_source) return _source;
  const [hubspot, db, whatsapp] = await Promise.all([
    import('../hubspot/index.js'),
    import('../db/index.js'),
    import('../whatsapp/index.js'),
  ]);
  _source = {
    listProgramEvents: hubspot.listProgramEvents,
    getFirstInvitee: hubspot.getFirstInvitee,
    isOptedIn: db.isVerifiedOptedIn,
    getOptin: db.getOptin,
    isCalendlyPaused: db.isCalendlyPaused,
    sendMessage: whatsapp.sendMessage,
    now: () => Date.now(),
    dryRunOverride: true, // validación en paralelo con Calendly: no envía nunca
    logLabel: 'HubSpot',
  };
  return _source;
}

export function startHubspotJobs() {
  if (!hasHubspotCreds()) {
    console.warn('[HubSpot] HUBSPOT_TOKEN ausente — jobs de HubSpot desactivados');
    return;
  }
  const tz = TZ();
  const job = (cron, pushN, offsetDays, name) =>
    new CronJob(
      cron,
      () =>
        buildSource()
          .then((s) => runDigest(pushN, offsetDays, s))
          .catch((e) => console.error(`[HubSpot] ${name}:`, e.message)),
      null,
      true,
      tz
    );

  job(PUSH1_CRON(), 1, 1, 'push1'); // 7:00pm — digest de MAÑANA
  job(PUSH2_CRON(), 2, 0, 'push2'); // 6:30am — digest de HOY

  console.log('[HubSpot] Jobs de validación activos ✅ (DRY-RUN forzado — solo loguea, no envía)');
}
