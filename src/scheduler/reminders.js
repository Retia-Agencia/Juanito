// src/scheduler/reminders.js
// Job de recordatorios: cada minuto envía los pendientes vencidos.
// Resuelve el destinatario (to_phone o el jefe) y manda un texto plano.

import { CronJob } from 'cron';
import {
  getPendingReminders,
  markReminderSent,
  markReminderFailed,
} from '../db/index.js';
import { sendMessage } from '../whatsapp/index.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const TZ = () => process.env.TZ || 'America/Bogota';

// ─── Envío de un recordatorio ─────────────────────────────────────────────────

async function deliverReminder(reminder) {
  const to = reminder.to_phone || BOSS_PHONE();
  if (!to) throw new Error('sin destinatario ni BOSS_PHONE configurado');

  await sendMessage(to, `⏰ Recordatorio: ${reminder.text}`);
}

// ─── Arranque del job ─────────────────────────────────────────────────────────

export function startReminderJob() {
  new CronJob(
    '* * * * *',
    async () => {
      const pending = getPendingReminders();
      for (const reminder of pending) {
        try {
          await deliverReminder(reminder);
          markReminderSent(reminder.id);
          console.log(`[Scheduler] Recordatorio enviado #${reminder.id}: ${reminder.text}`);
        } catch (err) {
          markReminderFailed(reminder.id);
          console.error(
            `[Scheduler] Recordatorio #${reminder.id} marcado FAILED: ${err.message}`
          );
        }
      }
    },
    null,
    true,
    TZ()
  );

  console.log('[Scheduler] Job de recordatorios activo ✅');
}
