// src/scheduler/boss-report.js
// Entrega del reporte del JEFE (Dani): scorecard consolidado de TODOS los programas desde
// call_outcomes (la fuente de verdad). El núcleo puro vive en calendly/boss-report.js; este
// archivo solo lee la ventana del día y entrega por DM (cron) o arma el texto para el comando.
//
// El reporte DIARIO por DM está APAGADO por default (decisión del jefe 2026-07-17): requiere
// BOSS_REPORT_ENABLED=true + BOSS_REPORT_DM. El comando on-demand `/reportejefe` funciona
// SIEMPRE, independiente de ese flag.

import { CronJob } from 'cron';
import { sendMessage } from '../whatsapp/index.js';
import { getOutcomesInWindow } from '../db/index.js';
import { formatBossScorecard } from '../calendly/boss-report.js';
import { dayRangeUtc } from '../calendly/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const CRON = () => process.env.BOSS_REPORT_CRON || '30 20 * * *'; // 20:30 Bogotá, tras las calls del día
// Gate explícito: el reporte diario NO sale salvo que se prenda a propósito.
const DAILY_ENABLED = () => process.env.BOSS_REPORT_ENABLED === 'true';
// Destinatarios del DM diario (CSV de JIDs). Debe ser el JID desde el que la persona LE
// ESCRIBIÓ a Juanito (anti-ban: sin hilo previo no se entrega).
const DM_RECIPIENTS = () =>
  (process.env.BOSS_REPORT_DM || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' → 'YYYY-MM-DD HH:MM:SS' (formato UTC de call_start).
const toDbUtc = (iso) => iso.slice(0, 19).replace('T', ' ');

function dateLabel(now) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ(),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(now);
}

// Builder impuro: lee la ventana de UN día y devuelve el texto (o null si no hubo calls).
// `daysBack` permite pedir un día anterior (0 = hoy). Lo usan el cron y el comando.
export function buildBossReport({ now = new Date(), daysBack = 0 } = {}) {
  const { minStartIso, maxStartIso } = dayRangeUtc(TZ(), daysBack, now);
  const rows = getOutcomesInWindow(toDbUtc(minStartIso), toDbUtc(maxStartIso));
  return formatBossScorecard(rows, { dateLabel: dateLabel(now) });
}

export function startBossReportJob() {
  if (!DAILY_ENABLED()) {
    console.log('[BossReport] reporte diario del jefe DESACTIVADO (BOSS_REPORT_ENABLED != true)');
    return;
  }
  const recipients = DM_RECIPIENTS();
  if (!recipients.length) {
    console.warn('[BossReport] BOSS_REPORT_ENABLED=true pero sin BOSS_REPORT_DM → nada que enviar, desactivado');
    return;
  }
  new CronJob(
    CRON(),
    async () => {
      try {
        const message = buildBossReport({});
        if (!message) {
          console.log('[BossReport] sin calls hoy → no se envía el reporte del jefe');
          return;
        }
        for (const jid of recipients) {
          await sendMessage(jid, message).catch((e) => console.error(`[BossReport] envío → ${jid}:`, e.message));
        }
        console.log(`[BossReport] reporte del jefe enviado a ${recipients.length} destinatario/s`);
      } catch (e) {
        console.error('[BossReport] error en el reporte del jefe:', e.message);
      }
    },
    null,
    true,
    TZ()
  );
  console.log(`[BossReport] Job diario del jefe activo ✅ (cron "${CRON()}", ${recipients.length} DM)`);
}
