// src/scheduler/daily-reports.js
// Los 3 reportes diarios por DM (pedido del jefe 2026-07-22), todos desde call_outcomes
// (la fuente de verdad que alimenta el agenda_status de HubSpot vía Push 4):
//   1. 07:00 — AGENDA del día: calls agendadas hoy por closer/programa (aún sin resultados).
//   2. 12:00 — PROGRESO: scorecard consolidado con lo resuelto hasta el momento.
//   3. 21:00 — CIERRE: scorecard consolidado final del día.
//
// Los 2 y 3 son el mismo scorecard del jefe (calendly/boss-report.js) a distinta hora,
// cambiando solo el título. El 1 usa el formatter de agenda (calendly/agenda-report.js).
//
// APAGADO por default: requiere DAILY_REPORTS_ENABLED=true + DAILY_REPORTS_DM. Va por DM a un
// destinatario configurable (hoy: prueba a un solo número). OJO anti-ban: el JID debe ser el
// @lid del hilo persistido desde el que la persona le ESCRIBIÓ a Juanito, no el phone-JID de
// /whoami (ver docs/JUANITO-HANDOFF.md §18 y la memoria juanito-dm-recipient-lid).

import { CronJob } from 'cron';
import { sendMessage } from '../whatsapp/index.js';
import { getOutcomesInWindow } from '../db/index.js';
import { formatBossScorecard } from '../calendly/boss-report.js';
import { formatAgendaScorecard } from '../calendly/agenda-report.js';
import { dayRangeUtc } from '../calendly/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const ENABLED = () => process.env.DAILY_REPORTS_ENABLED === 'true';
const DM_RECIPIENTS = () =>
  (process.env.DAILY_REPORTS_DM || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const AM_CRON = () => process.env.DAILY_REPORT_AM_CRON || '0 7 * * *'; // agenda del día
const MID_CRON = () => process.env.DAILY_REPORT_MID_CRON || '0 12 * * *'; // progreso
const PM_CRON = () => process.env.DAILY_REPORT_PM_CRON || '0 21 * * *'; // cierre

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

function rowsForToday(now) {
  const { minStartIso, maxStartIso } = dayRangeUtc(TZ(), 0, now);
  return getOutcomesInWindow(toDbUtc(minStartIso), toDbUtc(maxStartIso));
}

// Builders impuros (leen la ventana de hoy). Exportados para test/preview.
export function buildAgendaReport({ now = new Date() } = {}) {
  return formatAgendaScorecard(rowsForToday(now), { dateLabel: dateLabel(now) });
}

export function buildProgressReport({ now = new Date() } = {}) {
  return formatBossScorecard(rowsForToday(now), { dateLabel: dateLabel(now), heading: 'Progreso del día' });
}

export function buildFinalReport({ now = new Date() } = {}) {
  return formatBossScorecard(rowsForToday(now), { dateLabel: dateLabel(now), heading: 'Cierre del día' });
}

async function deliver(tag, message, recipients) {
  if (!message) {
    console.log(`[DailyReports] ${tag}: sin calls hoy → no se envía`);
    return;
  }
  for (const jid of recipients) {
    await sendMessage(jid, message).catch((e) => console.error(`[DailyReports] ${tag} → ${jid}:`, e.message));
  }
  console.log(`[DailyReports] ${tag} enviado a ${recipients.length} DM`);
}

export function startDailyReportsJob() {
  if (!ENABLED()) {
    console.log('[DailyReports] reportes diarios por DM DESACTIVADOS (DAILY_REPORTS_ENABLED != true)');
    return;
  }
  const recipients = DM_RECIPIENTS();
  if (!recipients.length) {
    console.warn('[DailyReports] DAILY_REPORTS_ENABLED=true pero sin DAILY_REPORTS_DM → nada que enviar, desactivado');
    return;
  }
  const mk = (cron, tag, builder) =>
    new CronJob(
      cron,
      async () => {
        try {
          await deliver(tag, builder({}), recipients);
        } catch (e) {
          console.error(`[DailyReports] error en ${tag}:`, e.message);
        }
      },
      null,
      true,
      TZ()
    );
  mk(AM_CRON(), 'agenda 7am', buildAgendaReport);
  mk(MID_CRON(), 'progreso 12pm', buildProgressReport);
  mk(PM_CRON(), 'cierre 9pm', buildFinalReport);
  console.log(
    `[DailyReports] Jobs activos ✅ (agenda "${AM_CRON()}" · progreso "${MID_CRON()}" · cierre "${PM_CRON()}", ${recipients.length} DM)`
  );
}
