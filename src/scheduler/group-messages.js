// src/scheduler/group-messages.js
// Job de mensajes recurrentes a grupos. Dos tipos (kind en scheduled_messages):
//   'fixed'     → texto exacto guardado; se publica directo a la hora (§18.E).
//   'generated' → Claude redacta un borrador con anticipación según el `brief`,
//                 se manda al JEFE por DM para aprobación, y SOLO se publica si
//                 está aprobado. Aprobación tardía (mismo día) publica al minuto.
//                 Con AUTO-ENVÍO prendido para esa fila (§18.BS) el borrador se
//                 aprueba solo al generarse y sale sin visto bueno; la consola de
//                 aprobaciones recibe una COPIA después de publicar (bitácora, no
//                 compuerta). Se prende con `/programados auto <id> on`.
//
// Garantías:
//  - anti doble-envío: last_sent_date por fila + UNIQUE(scheduled_id, publish_date)
//  - solo grupos AUTORIZADOS (default-deny coherente con el anti-secuestro)
//  - los envíos pasan por la cola anti-ban global de sendMessage
//
// Deps inyectables (__setDeps) para testear el ciclo sin DB/WA/Claude reales.

import { CronJob } from 'cron';
import { isRecurringDue, isDraftDue, isGeneratedPublishDue, isAutoPublish, zonedNowParts } from './recurring-logic.js';
import { bossDmTarget } from '../common/roles.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const WINDOW_MIN = 30;
const DRAFT_LEAD_MIN = () => Number(process.env.DRAFT_LEAD_MIN || 60);

let _injectedDeps = null;
export function __setDeps(deps) {
  _injectedDeps = deps;
}
export function __resetDeps() {
  _injectedDeps = null;
}

async function resolveDeps() {
  if (_injectedDeps) return _injectedDeps;
  const [db, whatsapp, claude, routing] = await Promise.all([
    import('../db/index.js'),
    import('../whatsapp/index.js'),
    import('../claude/index.js'),
    import('../common/approval-routing.js'),
  ]);
  return {
    listScheduledMessages: db.listScheduledMessages,
    markScheduledMessageSent: db.markScheduledMessageSent,
    isGroupAuthorized: db.isGroupAuthorized,
    createDraft: db.createDraft,
    getDraftFor: db.getDraftFor,
    approveDraft: db.approveDraft,
    markDraftPublished: db.markDraftPublished,
    markDraftReminded: db.markDraftReminded,
    listRecentPublishedDrafts: db.listRecentPublishedDrafts,
    getSetting: db.getSetting,
    sendMessage: whatsapp.sendMessage,
    generateScheduledDraft: claude.generateScheduledDraft,
    approvalsTarget: routing.approvalsTarget,
  };
}

// ─── kind='fixed': publicar directo a la hora ─────────────────────────────────

async function processFixed(d, row, nowParts) {
  if (!isRecurringDue({ days: row.days, timeHm: row.time_hm, lastSentDate: row.last_sent_date, nowParts, windowMin: WINDOW_MIN })) {
    return false;
  }
  if (!d.isGroupAuthorized(row.group_id)) {
    console.log(`[Scheduler] Mensaje programado #${row.id} omitido: grupo no autorizado (${row.group_name || row.group_id})`);
    return false;
  }
  await d.sendMessage(row.group_id, row.text);
  d.markScheduledMessageSent(row.id, nowParts.date);
  console.log(`[Scheduler] Mensaje programado #${row.id} enviado a "${row.group_name || row.group_id}"`);
  return true;
}

// ─── kind='generated': generar borrador → aprobar → publicar ──────────────────

async function processGenerated(d, row, nowParts) {
  const draft = d.getDraftFor(row.id, nowParts.date);

  // 1) Fase de borrador: aún no existe y ya estamos dentro del lead → generar + DM al jefe.
  if (!draft && isDraftDue({ days: row.days, timeHm: row.time_hm, nowParts, leadMin: DRAFT_LEAD_MIN() })) {
    if (row.last_sent_date === nowParts.date) return false; // ya publicado hoy
    const auto = isAutoPublish(d.getSetting, row.id);
    const boss = d.approvalsTarget ? await d.approvalsTarget() : bossDmTarget();
    // Sin auto-envío, un borrador que nadie puede aprobar nunca se publica: no gastamos tokens.
    // Con auto-envío el destino de aprobación es opcional (solo lleva la copia posterior).
    if (!auto && !boss) {
      console.error(`[Scheduler] Borrador #${row.id}: sin BOSS_LID/BOSS_PHONE para aprobar — omitido`);
      return false;
    }
    const feedback = d.getSetting(`editorial_feedback:${row.id}`, '') || '';
    const recents = d.listRecentPublishedDrafts(row.id, 3);
    const text = await d.generateScheduledDraft({
      brief: row.brief || '',
      groupName: row.group_name || row.group_id,
      feedback,
      recentTexts: recents,
    });
    const draftId = d.createDraft({ scheduledId: row.id, publishDate: nowParts.date, draft: text });
    if (draftId === null) return false; // carrera: otro ciclo lo creó

    // Auto-envío: se aprueba solo y sale a la hora por la MISMA ruta que un aprobado a mano
    // (grupo autorizado + cola anti-ban + markDraftPublished, que alimenta el anti-repetición).
    // El lead de DRAFT_LEAD_MIN queda como ventana de veto: `/aprobaciones rechazar <id>`.
    if (auto) {
      d.approveDraft(draftId);
      console.log(
        `[Scheduler] Borrador #${draftId} (programado #${row.id}) generado y AUTO-APROBADO — ` +
          `sale a las ${row.time_hm} sin aprobación`
      );
      return false;
    }

    await d.sendMessage(
      boss,
      `📝 *Borrador #${draftId}* para *${row.group_name || row.group_id}* (sale hoy a las ${row.time_hm} si lo apruebas):\n\n` +
        `${text}\n\n` +
        `Respóndeme *"apruebo"* para publicarlo, o dime qué corregir y te muestro la nueva versión. Sin tu visto bueno NO se publica.\n_Tip: cítame este mensaje (reply) para decidir sobre este borrador exacto._`
    );
    console.log(`[Scheduler] Borrador #${draftId} (programado #${row.id}) generado y enviado al jefe`);
    return false;
  }

  if (!draft) return false;

  // 2) Fase de publicación: hora cumplida + borrador APROBADO → publicar.
  if (isGeneratedPublishDue({ days: row.days, timeHm: row.time_hm, lastSentDate: row.last_sent_date, nowParts })) {
    if (draft.status === 'approved') {
      if (!d.isGroupAuthorized(row.group_id)) {
        console.log(`[Scheduler] Borrador #${draft.id} omitido: grupo no autorizado`);
        return false;
      }
      await d.sendMessage(row.group_id, draft.draft);
      d.markScheduledMessageSent(row.id, nowParts.date);
      d.markDraftPublished(draft.id);
      console.log(`[Scheduler] Borrador #${draft.id} PUBLICADO en "${row.group_name || row.group_id}"`);
      // Copia a la consola SOLO si salió sin aprobación: quien aprueba a mano ya lo vio.
      // Va en su propio try: una bitácora que falla no puede parecer un envío que falló
      // (el mensaje ya salió y la fila ya está marcada — reintentar sería doble publicación).
      if (isAutoPublish(d.getSetting, row.id)) {
        try {
          const boss = d.approvalsTarget ? await d.approvalsTarget() : bossDmTarget();
          if (boss) {
            await d.sendMessage(
              boss,
              `✅ *Publicado automáticamente* en *${row.group_name || row.group_id}* ` +
                `(borrador #${draft.id}, sin aprobación):\n\n${draft.draft}`
            );
          }
        } catch (err) {
          console.error(`[Scheduler] Copia del borrador #${draft.id} a la consola falló: ${err.message}`);
        }
      }
      return true;
    }
    // Pendiente a la hora de publicar → recordarle al jefe UNA vez. No se publica.
    if (draft.status === 'pending' && !draft.reminded) {
      d.markDraftReminded(draft.id);
      const boss = d.approvalsTarget ? await d.approvalsTarget() : bossDmTarget();
      if (boss) {
        await d.sendMessage(
          boss,
          `⏳ El borrador #${draft.id} para *${row.group_name || row.group_id}* sigue SIN aprobar y ya pasó ` +
            `su hora (${row.time_hm}). No se publicó. Si lo apruebas ahora, sale de inmediato.`
        );
      }
      console.log(`[Scheduler] Borrador #${draft.id} pendiente a la hora de publicar — recordatorio enviado`);
    }
  }
  return false;
}

// ─── Una pasada (exportada para tests / disparo manual) ───────────────────────

// Guarda de re-entrada: el cron corre cada minuto, pero generar un borrador es una llamada a
// Claude (segundos). Sin esto, un 2º ciclo entraría mientras el 1º genera, vería getDraftFor()
// aún en null y volvería a generar el MISMO borrador → doble gasto de tokens (el ON CONFLICT de
// createDraft evita el duplicado en DB, pero no la 2ª generación, que es lo caro).
let _running = false;

export async function runScheduledMessagesCycle(now = new Date()) {
  if (_running) {
    console.log('[Scheduler] group-messages: ciclo anterior aún en curso — salto este minuto');
    return 0;
  }
  _running = true;
  try {
    return await _runScheduledMessagesCycle(now);
  } finally {
    _running = false;
  }
}

async function _runScheduledMessagesCycle(now = new Date()) {
  const d = await resolveDeps();
  const nowParts = zonedNowParts(now, TZ());
  let sent = 0;

  for (const row of d.listScheduledMessages()) {
    try {
      const ok =
        row.kind === 'generated'
          ? await processGenerated(d, row, nowParts)
          : await processFixed(d, row, nowParts);
      if (ok) sent++;
    } catch (err) {
      // NO se marca enviado → el próximo minuto reintenta mientras aplique.
      console.error(`[Scheduler] Mensaje programado #${row.id} falló: ${err.message}`);
    }
  }

  return sent;
}

export function startGroupMessagesJob() {
  new CronJob('* * * * *', () => runScheduledMessagesCycle(), null, true, TZ());
  console.log('[Scheduler] Job de mensajes programados a grupos activo ✅');
}
