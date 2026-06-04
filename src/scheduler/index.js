// src/scheduler/index.js
// Cron jobs: recordatorios, resúmenes de grupos y limpieza de la DB

import { CronJob } from 'cron';
import {
  getPendingReminders,
  markReminderSent,
  saveGroupContext,
  cleanup,
} from '../db/index.js';
import { sendMessage } from '../meta/index.js';
import { listGroups, getRecentMessages } from '../openwa/index.js';
import { summarizeGroupMessages } from '../claude/index.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const TZ = () => process.env.TZ || 'America/Bogota';
const MAX_GROUPS = () => Number(process.env.MAX_GROUPS_PER_CYCLE || 10);

// ─── Job 1: Revisar recordatorios cada minuto ─────────────────────────────────

export function startReminderJob() {
  new CronJob(
    '* * * * *',
    async () => {
      const pending = getPendingReminders();
      for (const reminder of pending) {
        try {
          await sendMessage(BOSS_PHONE(), `⏰ Recordatorio: ${reminder.text}`);
          markReminderSent(reminder.id);
          console.log(`[Scheduler] Recordatorio enviado: ${reminder.text}`);
        } catch (err) {
          // No marcamos como enviado si falló → se reintenta el próximo minuto
          console.error(`[Scheduler] Error enviando recordatorio ${reminder.id}:`, err.message);
        }
      }
    },
    null,
    true,
    TZ()
  );

  console.log('[Scheduler] Job de recordatorios activo ✅');
}

// ─── Job 2: Resumir grupos cada 4 horas ──────────────────────────────────────

export function startGroupSummaryJob() {
  new CronJob(
    '0 */4 * * *',
    async () => {
      console.log('[Scheduler] Resumiendo grupos del jefe...');
      try {
        const groups = await listGroups();

        for (const group of groups.slice(0, MAX_GROUPS())) {
          try {
            const messages = await getRecentMessages(group.id, 50);
            if (!messages.length) continue;

            const formatted = messages
              .filter((m) => m.body)
              .map((m) => `${m.sender?.pushname || m.sender?.id || '?'}: ${m.body}`)
              .join('\n');

            if (!formatted.trim()) continue;

            const summary = await summarizeGroupMessages(group.name || group.id, formatted);

            saveGroupContext({
              groupId: group.id,
              groupName: group.name,
              summary,
              rawSnippet: formatted.slice(0, 500),
            });

            console.log(`[Scheduler] Grupo resumido: ${group.name}`);
          } catch (err) {
            console.error(`[Scheduler] Error resumiendo grupo ${group.id}:`, err.message);
          }
        }
      } catch (err) {
        console.error('[Scheduler] Error listando grupos:', err.message);
      }
    },
    null,
    true,
    TZ()
  );

  console.log('[Scheduler] Job de resumen de grupos activo ✅');
}

// ─── Job 3: Limpieza diaria de la DB (3am) ────────────────────────────────────

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

export function startAllJobs() {
  startReminderJob();
  startGroupSummaryJob();
  startCleanupJob();
}
