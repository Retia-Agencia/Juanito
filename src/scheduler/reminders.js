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
import { bossDmTarget } from '../common/roles.js';

const TZ = () => process.env.TZ || 'America/Bogota';

// ─── Envío de un recordatorio ─────────────────────────────────────────────────

async function deliverReminder(reminder) {
  // to_group_id (§18.Q) → se publica EN el grupo; si no, a la persona (to_phone) o al jefe.
  // Cualquiera de los tres sale por la cola anti-ban de sendMessage.
  const to = reminder.to_group_id || reminder.to_phone || bossDmTarget();
  if (!to) throw new Error('sin destinatario ni BOSS_LID/BOSS_PHONE configurado');

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
