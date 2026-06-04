// src/scheduler/index.js
// Agregador de cron jobs. Reúne los jobs de cada track.
//  - reminders.js     (Track A): recordatorios
//  - summaries.js     (Track B): resumen de grupos  -> import dinámico
//  - cleanup (aquí)   (Track A): limpieza diaria de la DB

import { CronJob } from 'cron';
import { startReminderJob } from './reminders.js';
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

  // El job de resúmenes lo aporta el Track B. Mientras no exista en la rama,
  // se omite sin romper el arranque (se activa solo tras el merge de SYNC 2).
  try {
    const { startGroupSummaryJob } = await import('./summaries.js');
    startGroupSummaryJob();
  } catch (err) {
    console.warn('[Scheduler] summaries.js no disponible todavía, omitiendo resúmenes');
  }
}
