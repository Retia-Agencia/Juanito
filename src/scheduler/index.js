// src/scheduler/index.js
// Agregador de cron jobs. Reúne los jobs de cada track.
//  - reminders.js     (Track A): recordatorios
//  - summaries.js     (Track B): resumen de grupos  -> import dinámico
//  - cleanup (aquí)   (Track A): limpieza diaria de la DB

import { CronJob } from 'cron';
import { startReminderJob } from './reminders.js';
import { startCalendlyJobs } from './calendly.js';
import { startSheetsReportJob } from './sheets-report.js';
import { startSheetsMetricsJob } from './sheets-metrics.js';
import { startOutcomeReportJob } from './outcome-report.js';
import { startGroupMessagesJob } from './group-messages.js';
import { startGroupRepliesJob } from './group-replies.js';
import { startOutreachJob } from './outreach.js';
import { startSettingJob } from './setting.js';
import { startBusinessExtractionJob } from './business-extraction.js';
import { cleanup } from '../db/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';

// ─── Job de limpieza diaria (3am) ─────────────────────────────────────────────

export function startCleanupJob() {
  new CronJob(
    '0 3 * * *',
    () => {
      try {
        const deleted = cleanup();
        console.log(`[Scheduler] Limpieza diaria: ${deleted} registros eliminados`);
      } catch (err) {
        console.error('[Scheduler] Error en limpieza:', err.message);
      }
    },
    null,
    true,
    TZ()
  );
  console.log('[Scheduler] Job de limpieza activo ✅');
}

// ─── Arrancar todos los jobs ──────────────────────────────────────────────────

export async function startAllJobs() {
  startReminderJob();
  startCleanupJob();
  startGroupMessagesJob();
  startGroupRepliesJob();
  startOutreachJob();

  // Recordatorios precall de Calendly (se autodesactiva si falta CALENDLY_TOKEN)
  try {
    startCalendlyJobs();
  } catch (err) {
    console.warn('[Scheduler] Calendly no disponible:', err.message);
  }

  // Reporte diario de leads del Sheet (se autodesactiva si falta GOOGLE_SA_KEY o grupo)
  try {
    startSheetsReportJob();
  } catch (err) {
    console.warn('[Scheduler] Reporte de Sheets no disponible:', err.message);
  }

  // Reporte diario de métricas de desempeño por DM (se autodesactiva si falta
  // GOOGLE_SA_KEY, el ID/pestaña o los destinatarios)
  try {
    startSheetsMetricsJob();
  } catch (err) {
    console.warn('[Scheduler] Reporte de métricas no disponible:', err.message);
  }

  // Reporte diario de "Registro de calls" (§18.AB) desde call_outcomes → grupo por
  // programa. Se autodesactiva si no hay grupos por sección configurados.
  try {
    startOutcomeReportJob();
  } catch (err) {
    console.warn('[Scheduler] Reporte de calls no disponible:', err.message);
  }

  // El job de resúmenes lo aporta el Track B. Mientras no exista en la rama,
  // se omite sin romper el arranque (se activa solo tras el merge de SYNC 2).
  try {
    const { startGroupSummaryJob } = await import('./summaries.js');
    startGroupSummaryJob();
  } catch (err) {
    console.warn('[Scheduler] summaries.js no disponible todavía, omitiendo resúmenes');
  }

  // Extracción de contexto de negocio desde los resúmenes (Fase 2B). Se autodesactiva sin
  // ANTHROPIC_API_KEY. Propone hechos (status='proposed') → admin confirma con /negocio ok.
  try {
    startBusinessExtractionJob();
  } catch (err) {
    console.warn('[Scheduler] Extracción de negocio no disponible:', err.message);
  }

  // Setteo a leads que no agendaron (§18.AD) por la Cloud API oficial. Se autodesactiva
  // sin credenciales Twilio o sin GOOGLE_SA_KEY. Default DRY_RUN (no envía).
  try {
    startSettingJob();
  } catch (err) {
    console.warn('[Scheduler] Setteo no disponible:', err.message);
  }
}
