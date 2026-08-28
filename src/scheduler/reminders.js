// src/scheduler/reminders.js
// Job de recordatorios: cada minuto envía los pendientes vencidos.
// Resuelve el destinatario (to_phone o el jefe) y manda un texto plano.

import { CronJob } from 'cron';
import {
  getPendingReminders,
  markReminderSent,
  registrarFalloRecordatorio,
  MAX_INTENTOS_RECORDATORIO,
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
          // Un fallo NO mata el recordatorio: se posterga con backoff y se reintenta.
          // El caso real que motivó esto es un hipo de la cola de WhatsApp o un
          // `bossDmTarget()` que todavía no resolvió — transitorios los dos, y antes
          // dejaban el recordatorio en 'failed' sin que nadie lo notara.
          const { intentos, agotado, esperaMin } = registrarFalloRecordatorio(reminder.id);
          if (agotado) {
            console.error(
              `[Scheduler] Recordatorio #${reminder.id} marcado FAILED tras ${intentos} intentos: ${err.message}`
            );
          } else {
            console.warn(
              `[Scheduler] Recordatorio #${reminder.id} falló (intento ${intentos}/${MAX_INTENTOS_RECORDATORIO}), ` +
                `reintento en ${esperaMin} min: ${err.message}`
            );
          }
        }
      }
    },
    null,
    true,
    TZ()
  );

  console.log('[Scheduler] Job de recordatorios activo ✅');
}
