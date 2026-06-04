// src/scheduler/reminders.js
// Job de recordatorios: cada minuto envía los pendientes vencidos.
// Resuelve el destinatario (to_phone o el jefe) y decide texto vs template
// según la ventana de servicio de 24 h de Meta.

import { CronJob } from 'cron';
import db, {
  getPendingReminders,
  markReminderSent,
  markReminderFailed,
  incrementReminderAttempt,
} from '../db/index.js';
import { sendMessage, sendTemplate } from '../meta/index.js';
import { phonesMatch } from '../common/utils.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const TZ = () => process.env.TZ || 'America/Bogota';
const TEMPLATE_NAME = () => process.env.REMINDER_TEMPLATE_NAME || 'reminder_utility';
const TEMPLATE_LANG = () => process.env.REMINDER_TEMPLATE_LANG || 'es';
const MAX_ATTEMPTS = 3;

// ─── Selección de canal (pura, testeable) ─────────────────────────────────────
// Texto plano solo si es para el jefe y está dentro de su ventana de 24 h;
// para terceros (o fuera de ventana) hay que usar template aprobado.

export function selectDelivery({ toPhone, bossPhone, bossInWindow }) {
  const isBoss = !toPhone || phonesMatch(toPhone, bossPhone);
  return isBoss && bossInWindow ? 'text' : 'template';
}

// ¿El jefe escribió al bot en las últimas 24 h? (abre la ventana de servicio)
function bossInServiceWindow() {
  const row = db
    .prepare(`SELECT MAX(created_at) AS last FROM messages WHERE source = 'bot' AND role = 'user'`)
    .get();
  if (!row?.last) return false;
  const lastMs = new Date(row.last.replace(' ', 'T') + 'Z').getTime(); // SQLite guarda UTC
  return Date.now() - lastMs < 24 * 60 * 60 * 1000;
}

// ─── Envío de un recordatorio ─────────────────────────────────────────────────

async function deliverReminder(reminder) {
  const to = reminder.to_phone || BOSS_PHONE();
  if (!to) throw new Error('sin destinatario ni BOSS_PHONE configurado');

  const mode = selectDelivery({
    toPhone: reminder.to_phone,
    bossPhone: BOSS_PHONE(),
    bossInWindow: bossInServiceWindow(),
  });

  if (mode === 'text') {
    await sendMessage(to, `⏰ Recordatorio: ${reminder.text}`);
  } else {
    await sendTemplate(to, TEMPLATE_NAME(), TEMPLATE_LANG(), [
      { type: 'body', parameters: [{ type: 'text', text: reminder.text }] },
    ]);
  }
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
          const attempts = incrementReminderAttempt(reminder.id);
          if (attempts >= MAX_ATTEMPTS) {
            markReminderFailed(reminder.id);
            console.error(
              `[Scheduler] Recordatorio #${reminder.id} marcado FAILED tras ${attempts} intentos: ${err.message}`
            );
          } else {
            console.error(
              `[Scheduler] Error enviando recordatorio #${reminder.id} (intento ${attempts}/${MAX_ATTEMPTS}): ${err.message}`
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
