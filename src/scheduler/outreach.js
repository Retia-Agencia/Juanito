// src/scheduler/outreach.js
// Job de mensajes/recordatorios a TERCEROS por instrucción del jefe (tabla
// outreach_schedules, tool schedule_outreach). Cada minuto revisa las filas activas
// y, cuando toca, Juanito REDACTA un mensaje natural de parte del jefe, se lo envía a
// la persona por la cola anti-ban, y le avisa al jefe con una copia.
//
// Modalidades (recur_kind):
//   'once'     → una sola vez a una hora (due_at). Tras enviar, status='done'.
//   'interval' → cada N minutos (interval_min/next_due_at). Para por until_at o max_count.
//   'daily'    → días + hora fija (igual que los mensajes de grupo, vía isRecurringDue).
//
// Garantías:
//  - No escribe dentro de las horas de descanso si la fila respeta quiet hours (pausa, no para).
//  - Los envíos pasan por la cola anti-ban global de sendMessage.
//  - Una fila que falla NO avanza su estado → el próximo minuto reintenta.
//
// Deps inyectables (__setDeps) para testear el ciclo sin DB/WA/Claude reales.

import { CronJob } from 'cron';
import { isOutreachDue, zonedNowParts, zonedStamp } from './recurring-logic.js';
import { isWithinQuietHours } from '../common/utils.js';
import { bossDmTarget } from '../common/roles.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const WINDOW_MIN = 30;

let _injectedDeps = null;
export function __setDeps(deps) {
  _injectedDeps = deps;
}
export function __resetDeps() {
  _injectedDeps = null;
}

async function resolveDeps() {
  if (_injectedDeps) return _injectedDeps;
  const [db, whatsapp, claude] = await Promise.all([
    import('../db/index.js'),
    import('../whatsapp/index.js'),
    import('../claude/index.js'),
  ]);
  return {
    listActiveOutreach: db.listActiveOutreach,
    markOutreachSent: db.markOutreachSent,
    finishOutreach: db.finishOutreach,
    sendMessage: whatsapp.sendMessage,
    generateOutreachMessage: claude.generateOutreachMessage,
    bossTarget: async () => bossDmTarget(),
    isWithinQuietHours,
  };
}

// ─── Entrega de una fila ──────────────────────────────────────────────────────

async function deliverOutreach(d, row, { now, nowStamp, nowParts }) {
  const text = await d.generateOutreachMessage({ intent: row.intent, toName: row.to_name });
  await d.sendMessage(row.to_phone, text);

  // Aviso al jefe (FYI, no aprobación): ya dio la orden, pero ve cada salida.
  const boss = d.bossTarget ? await d.bossTarget() : bossDmTarget();
  if (boss) {
    await d.sendMessage(boss, `✅ Le escribí a ${row.to_name || row.to_phone}:\n«${text}»`);
  }

  // Avanzar estado + evaluar parada según el tipo.
  if (row.recur_kind === 'once') {
    d.finishOutreach(row.id, 'done');
    return;
  }
  if (row.recur_kind === 'interval') {
    const nextDueAt = zonedStamp(new Date(now.getTime() + row.interval_min * 60000), TZ());
    d.markOutreachSent(row.id, { nextDueAt });
    const newCount = (row.sent_count || 0) + 1;
    const reachedCount = row.max_count && newCount >= row.max_count;
    const reachedUntil = row.until_at && nextDueAt > row.until_at;
    if (reachedCount || reachedUntil) d.finishOutreach(row.id, 'done');
    return;
  }
  if (row.recur_kind === 'daily') {
    d.markOutreachSent(row.id, { lastSentDate: nowParts.date });
  }
}

// ─── Una pasada (exportada para tests / disparo manual) ───────────────────────

// Guarda de re-entrada: generar el mensaje es una llamada a Claude (segundos) y el cron corre
// cada minuto; sin esto, un 2º ciclo enviaría de nuevo lo mismo antes de que el 1º marque estado.
let _running = false;

export async function runOutreachCycle(now = new Date()) {
  if (_running) {
    console.log('[Scheduler] outreach: ciclo anterior aún en curso — salto este minuto');
    return 0;
  }
  _running = true;
  try {
    return await _runOutreachCycle(now);
  } finally {
    _running = false;
  }
}

async function _runOutreachCycle(now = new Date()) {
  const d = await resolveDeps();
  const nowStamp = zonedStamp(now, TZ());
  const nowParts = zonedNowParts(now, TZ());
  const quiet = (d.isWithinQuietHours || isWithinQuietHours)(now);
  let sent = 0;

  for (const row of d.listActiveOutreach()) {
    try {
      // Parada por límite de tiempo ya vencido (interval): cerrar aunque no toque enviar.
      if (row.recur_kind === 'interval' && row.until_at && nowStamp > row.until_at) {
        d.finishOutreach(row.id, 'done');
        continue;
      }
      if (!isOutreachDue(row, { nowStamp, nowParts, windowMin: WINDOW_MIN })) continue;
      // Horas de descanso: la fila que las respeta no escribe ni avanza (pausa, reanuda al salir).
      if (quiet && row.respect_quiet) continue;

      await deliverOutreach(d, row, { now, nowStamp, nowParts });
      sent++;
      console.log(`[Scheduler] Outreach #${row.id} enviado a "${row.to_name || row.to_phone}"`);
    } catch (err) {
      // NO se avanza estado → el próximo minuto reintenta mientras aplique.
      console.error(`[Scheduler] Outreach #${row.id} falló: ${err.message}`);
    }
  }

  return sent;
}

export function startOutreachJob() {
  new CronJob('* * * * *', () => runOutreachCycle(), null, true, TZ());
  console.log('[Scheduler] Job de mensajes a terceros activo ✅');
}
