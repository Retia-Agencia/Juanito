// src/scheduler/group-replies.js
// Job de respuestas de grupo con aprobación. Cada minuto:
//   1) envía al grupo las respuestas APROBADAS por el jefe (vía cola anti-ban) → 'sent'.
//   2) caduca las pendientes con más de REPLY_APPROVAL_TTL_MIN minutos → 'expired' + avisa al jefe.
//
// Garantías:
//  - solo entrega a grupos AUTORIZADOS (default-deny: si se revocó tras retener, se descarta).
//  - los envíos pasan por la cola anti-ban global de sendMessage.
//  - un fallo de envío no rompe el ciclo (se reintenta el minuto siguiente).
//
// Deps inyectables (__setDeps) para testear el ciclo sin DB/WA reales.

import { CronJob } from 'cron';
import { bossDmTarget } from '../common/roles.js';

const TZ = () => process.env.TZ || 'America/Bogota';
const TTL_MIN = () => Number(process.env.REPLY_APPROVAL_TTL_MIN || 30);

let _injectedDeps = null;
export function __setDeps(deps) {
  _injectedDeps = deps;
}
export function __resetDeps() {
  _injectedDeps = null;
}

async function resolveDeps() {
  if (_injectedDeps) return _injectedDeps;
  const [db, whatsapp] = await Promise.all([
    import('../db/index.js'),
    import('../whatsapp/index.js'),
  ]);
  return {
    listApprovedPendingReplies: db.listApprovedPendingReplies,
    markPendingReplySent: db.markPendingReplySent,
    discardPendingReply: db.discardPendingReply,
    listExpiredPendingReplies: db.listExpiredPendingReplies,
    markPendingReplyExpired: db.markPendingReplyExpired,
    isGroupAuthorized: db.isGroupAuthorized,
    sendMessage: whatsapp.sendMessage,
  };
}

export async function runPendingRepliesCycle(deps) {
  const d = deps || (await resolveDeps());

  // 1) Enviar las aprobadas.
  for (const r of d.listApprovedPendingReplies() || []) {
    try {
      // Default-deny: si el grupo se revocó después de aprobar, no se envía y se saca de la cola.
      if (!d.isGroupAuthorized(r.group_id)) {
        d.discardPendingReply(r.id);
        console.log(`[Scheduler] Respuesta #${r.id} descartada: grupo no autorizado`);
        continue;
      }
      // Citar el mensaje que disparó la respuesta (reply nativo) para que no se confunda
      // con quién preguntó, dado que sale minutos después. Si la fila es pre-migración
      // (sin trigger_msg_id) → sin cita (degradación segura).
      const quoted = r.trigger_msg_id
        ? {
            key: {
              remoteJid: r.group_id,
              id: r.trigger_msg_id,
              participant: r.trigger_participant || undefined,
              fromMe: false,
            },
            message: { conversation: r.trigger_text || '' },
          }
        : undefined;
      await d.sendMessage(r.group_id, r.draft, { quoted });
      d.markPendingReplySent(r.id);
      console.log(`[Scheduler] Respuesta aprobada #${r.id} enviada a "${r.group_name || r.group_id}"`);
    } catch (err) {
      console.error(`[Scheduler] Respuesta #${r.id}: error al enviar — ${err.message}`);
    }
  }

  // 2) Caducar las pendientes que llevan demasiado tiempo sin decisión.
  for (const r of d.listExpiredPendingReplies(TTL_MIN()) || []) {
    d.markPendingReplyExpired(r.id);
    const boss = bossDmTarget();
    if (boss) {
      await d
        .sendMessage(
          boss,
          `⌛ La respuesta pendiente #${r.id} para "${r.group_name || r.group_id}" caducó ` +
            `(más de ${TTL_MIN()} min sin tu visto bueno) y se descartó.`
        )
        .catch(() => {});
    }
    console.log(`[Scheduler] Respuesta #${r.id} caducada (${TTL_MIN()} min)`);
  }
}

export function startGroupRepliesJob() {
  new CronJob(
    '* * * * *',
    () => {
      runPendingRepliesCycle().catch((e) => console.error('[Scheduler] group-replies:', e.message));
    },
    null,
    true,
    TZ()
  );
  console.log('[Scheduler] Job de respuestas con aprobación activo ✅');
}
