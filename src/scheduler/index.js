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
import { startBossReportJob } from './boss-report.js';
import { startStripeAlertsJob } from './stripe-alerts.js';
import { startGroupMessagesJob } from './group-messages.js';
import { startGroupRepliesJob } from './group-replies.js';
import { startOutreachJob } from './outreach.js';
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

  // Reporte diario de leads del Sheet (§18.B, 8pm).
  //
  // La publicación AL GRUPO "Ventas EstadoX" sigue APAGADA (pedido del jefe 2026-07-08):
  // ahora la corta el flag `SHEETS_REPORT_GROUP_ENABLED` (default false), no el hecho de
  // que el job no arranque. El job SÍ corre cuando hay destinatarios por DM
  // (`SHEETS_REPORT_DM`, §18.AD: la admin de EstadoX). Sin DMs y sin el flag del grupo, se
  // autodesactiva igual que antes.
  try {
    startSheetsReportJob();
  } catch (err) {
    console.warn('[Scheduler] Reporte de Sheets no disponible:', err.message);
  }

  // Aviso de pago en (casi) tiempo real a la admin de EstadoX (§18.AD). Poll a Stripe;
  // se autodesactiva sin STRIPE_API_KEY o sin STRIPE_ALERT_JIDS.
  try {
    startStripeAlertsJob();
  } catch (err) {
    console.warn('[Scheduler] Avisos de pago no disponibles:', err.message);
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

  // Reporte del JEFE (Dani): scorecard consolidado de todos los programas por DM. APAGADO
  // por default (BOSS_REPORT_ENABLED != true); el comando /reportejefe funciona igual.
  try {
    startBossReportJob();
  } catch (err) {
    console.warn('[Scheduler] Reporte del jefe no disponible:', err.message);
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
}
