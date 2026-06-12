// src/scheduler/group-messages.js
// Job de mensajes recurrentes a grupos (ej: invitación todos los jueves 8pm).
// Las filas las crea el jefe/admin por DM (tool schedule_group_message); aquí solo
// se entregan. La decisión de "¿toca ahora?" es pura (recurring-logic.js).
//
// Garantías:
//  - anti doble-envío: last_sent_date por fila (un envío por día como máximo)
//  - catch-up de 30 min: si el bot estaba reiniciando a la hora exacta, igual sale
//  - solo grupos AUTORIZADOS (si la autorización se revocó después de programar,
//    el mensaje se omite — default-deny coherente con el anti-secuestro)
//  - el envío pasa por la cola anti-ban global de sendMessage

import { CronJob } from 'cron';
import {
  listScheduledMessages,
  markScheduledMessageSent,
  isGroupAuthorized,
} from '../db/index.js';
import { sendMessage } from '../whatsapp/index.js';
import { isRecurringDue, zonedNowParts } from './recurring-logic.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const WINDOW_MIN = 30;

// Una pasada (exportada para disparo manual/diagnóstico).
export async function runScheduledMessagesCycle(now = new Date()) {
  const nowParts = zonedNowParts(now, TZ());
  let sent = 0;

  for (const row of listScheduledMessages()) {
    try {
      if (!isRecurringDue({ days: row.days, timeHm: row.time_hm, lastSentDate: row.last_sent_date, nowParts, windowMin: WINDOW_MIN })) {
        continue;
      }
      if (!isGroupAuthorized(row.group_id)) {
        console.log(`[Scheduler] Mensaje programado #${row.id} omitido: grupo no autorizado (${row.group_name || row.group_id})`);
        continue;
      }
      await sendMessage(row.group_id, row.text);
      markScheduledMessageSent(row.id, nowParts.date);
      sent++;
      console.log(`[Scheduler] Mensaje programado #${row.id} enviado a "${row.group_name || row.group_id}"`);
    } catch (err) {
      // NO se marca como enviado → el próximo minuto reintenta mientras dure la ventana.
      console.error(`[Scheduler] Mensaje programado #${row.id} falló: ${err.message}`);
    }
  }

  return sent;
}

export function startGroupMessagesJob() {
  new CronJob('* * * * *', () => runScheduledMessagesCycle(), null, true, TZ());
  console.log('[Scheduler] Job de mensajes programados a grupos activo ✅');
}
