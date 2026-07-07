// src/scheduler/hubspot.js
// HubSpot como fuente del motor precall. Reusa el mismo motor de Calendly (runDigest /
// runCalendlyPoll / runCalendlyDelivery) inyectándole una `source` que lee las citas de
// HubSpot. Se AUTODESACTIVA sin HUBSPOT_TOKEN — mismo patrón que startCalendlyJobs.
//
// Dos capas:
//   1) Digests Push 1/2 (7pm/6:30am): SIEMPRE activos. En la validación en paralelo corren
//      en DRY-RUN (HUBSPOT_DRY_RUN=true, default) y solo loguean [HubSpot] para comparar
//      contra [Calendly].
//   2) Push 3 (25 min) + Push 0: DB-backed (tabla calendly_pushes). GATEADO OFF por default
//      (HUBSPOT_PUSH3_ENABLED). ⚠️ Prender SOLO en el cutover, con Calendly APAGADO: la tabla
//      calendly_pushes es COMPARTIDA, así que si Calendly sigue vivo su cron de delivery (que
//      NO está en dry-run) entregaría las filas de HubSpot. Ver docs/HUBSPOT-CUTOVER.md.

import { CronJob } from 'cron';
import { runDigest, runCalendlyPoll, runCalendlyDelivery } from './calendly.js';
import { hasHubspotCreds } from '../hubspot/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const DRY_RUN = () => process.env.HUBSPOT_DRY_RUN !== 'false'; // default true (no envía)
const PUSH3_ENABLED = () => process.env.HUBSPOT_PUSH3_ENABLED === 'true'; // default OFF (cutover)
const PUSH1_CRON = () => process.env.HUBSPOT_PUSH1_CRON || '0 19 * * *'; // 7:00pm
const PUSH2_CRON = () => process.env.HUBSPOT_PUSH2_CRON || '30 6 * * *'; // 6:30am
const POLL_CRON = () => process.env.HUBSPOT_POLL_CRON || '*/5 * * * *';
const DELIVER_CRON = () => process.env.HUBSPOT_DELIVER_CRON || '* * * * *';

// Construye la `source` inyectable (lazy, memoizada: la cola/estado vive entre ticks). Liga
// la lectura de citas al adaptador de HubSpot y REUSA la DB + WhatsApp reales para los gates
// anti-ban/opt-in (mismos que Calendly → comparación manzana-con-manzana y cutover directo).
let _source = null;
async function buildSource() {
  if (_source) return _source;
  const [hubspot, db, whatsapp] = await Promise.all([
    import('../hubspot/index.js'),
    import('../db/index.js'),
    import('../whatsapp/index.js'),
  ]);
  _source = {
    // Lectura de citas desde HubSpot (en vez de Calendly).
    listProgramEvents: hubspot.listProgramEvents,
    getFirstInvitee: hubspot.getFirstInvitee,
    getEvent: hubspot.getEvent, // re-validación en la entrega (¿cancelada?/¿reagendada?)
    eventUri: hubspot.eventUri, // identificador del deal que getEvent sabe parsear
    // DB real (calendly_pushes + opt-ins) y WhatsApp real.
    scheduleCalendlyPush: db.scheduleCalendlyPush,
    getDueCalendlyPushes: db.getDueCalendlyPushes,
    claimCalendlyPush: db.claimCalendlyPush,
    revertCalendlyPush: db.revertCalendlyPush,
    markCalendlyPushSent: db.markCalendlyPushSent,
    markCalendlyPushSkipped: db.markCalendlyPushSkipped,
    isOptedIn: db.isVerifiedOptedIn,
    getOptin: db.getOptin,
    isCalendlyPaused: db.isCalendlyPaused,
    sendMessage: whatsapp.sendMessage,
    now: () => Date.now(),
    push4Enabled: false, // el outcome post-call (Push 4) queda para una fase posterior
    dryRunOverride: DRY_RUN(), // se lee al arrancar; en el cutover se pone HUBSPOT_DRY_RUN=false
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
  const cron = (expr, fn, name) =>
    new CronJob(
      expr,
      () => buildSource().then(fn).catch((e) => console.error(`[HubSpot] ${name}:`, e.message)),
      null,
      true,
      tz
    );

  // Capa 1 — digests fijos (siempre activos).
  cron(PUSH1_CRON(), (s) => runDigest(1, 1, s), 'push1'); // 7:00pm — digest de MAÑANA
  cron(PUSH2_CRON(), (s) => runDigest(2, 0, s), 'push2'); // 6:30am — digest de HOY

  // Capa 2 — Push 3 (25 min) + Push 0, DB-backed. Solo si HUBSPOT_PUSH3_ENABLED=true (cutover).
  if (PUSH3_ENABLED()) {
    cron(POLL_CRON(), (s) => runCalendlyPoll(s), 'poll');
    cron(DELIVER_CRON(), (s) => runCalendlyDelivery(s), 'deliver');
  }

  const mode = DRY_RUN() ? 'DRY-RUN forzado (no envía)' : 'ENVÍO REAL ⚠️';
  const p3 = PUSH3_ENABLED() ? 'Push 3 ON (cutover)' : 'Push 3 OFF (solo digests)';
  console.log(`[HubSpot] Jobs activos ✅ — ${mode}, ${p3}`);
}
