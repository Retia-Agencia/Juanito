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
import { isWithinQuietHours } from '../common/utils.js';

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
    listHeldPendingReplies: db.listHeldPendingReplies,
    releaseHeldPendingReply: db.releaseHeldPendingReply,
    isGroupAuthorized: db.isGroupAuthorized,
    sendMessage: whatsapp.sendMessage,
  };
}

// Cita nativa del mensaje gatillo (para responderle al remitente original citándolo). Si la
// fila es pre-migración (sin trigger_msg_id) → sin cita (degradación segura).
function quoteFor(r) {
  return r.trigger_msg_id
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
}

const HOLDING_NOTICE = () =>
  process.env.REPLY_EXPIRY_NOTICE ||
  '¡Hola! Vi tu mensaje 🙏 lo estoy validando con el equipo y te respondo apenas pueda.';

export async function runPendingRepliesCycle(deps) {
  const d = deps || (await resolveDeps());

  // 0) Salir del horario de descanso: informar al jefe (UN solo digest) de las respuestas
  //    que llegaron mientras "dormía" y liberarlas (held=0 + created_at=ahora → recién acá
  //    arranca el reloj de 30 min). Solo cuando YA estamos en horario laboral.
  if (!isWithinQuietHours()) {
    const held = (d.listHeldPendingReplies?.() || []);
    if (held.length) {
      const boss = bossDmTarget();
      if (boss) {
        const lines = held
          .map(
            (r) =>
              `• #${r.id} — ${r.kind === 'dm' ? r.group_name : `grupo "${r.group_name || r.group_id}"`}` +
              ` (${r.trigger_sender || 'alguien'}: "${(r.trigger_text || '').slice(0, 80)}")`
          )
          .join('\n');
        await d
          .sendMessage(
            boss,
            `🌙 Mientras descansabas llegaron ${held.length} respuesta(s) pendiente(s):\n\n${lines}\n\n` +
              `Para cada una: *"apruebo #id"* la envía, *"no #id"* la descarta, o dime los cambios.`
          )
          .catch(() => {});
      }
      for (const r of held) {
        d.releaseHeldPendingReply?.(r.id);
        console.log(`[Scheduler] Respuesta retenida #${r.id} liberada (fin del horario de descanso)`);
      }
    }
  }

  // 1) Enviar las aprobadas.
  for (const r of d.listApprovedPendingReplies() || []) {
    try {
      // Default-deny: si el grupo se revocó después de aprobar, no se envía y se saca de la cola.
      // Los pendientes de DM (kind='dm') NO viven en authorized_groups: se entregan al JID del
      // contacto directamente, así que se saltan esta verificación.
      if (r.kind !== 'dm' && !d.isGroupAuthorized(r.group_id)) {
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

  // 2) Rescate al vencer: pendientes con más de TTL_MIN sin decisión. En vez de descartarlas
  //    en silencio (la respuesta se perdía), hacemos que NO se pierda:
  //    a) al remitente se le manda un aviso amable de que se está validando (no queda colgado);
  //    b) al jefe se le re-avisa con el borrador y cómo rescatarla ("apruebo #id" la revive,
  //       porque approvePendingReply acepta status 'expired');
  //    c) se marca 'expired' para que NO se re-dispare el aviso cada minuto.
  for (const r of d.listExpiredPendingReplies(TTL_MIN()) || []) {
    d.markPendingReplyExpired(r.id);

    // a) Aviso al remitente original (grupo: citando su mensaje; DM: directo a su JID).
    try {
      const quoted = r.kind === 'dm' ? undefined : quoteFor(r);
      await d.sendMessage(r.group_id, HOLDING_NOTICE(), quoted ? { quoted } : {});
    } catch (err) {
      console.error(`[Scheduler] Respuesta #${r.id}: no pude avisar al remitente — ${err.message}`);
    }

    // b) Re-aviso al jefe, con el borrador y cómo rescatarla.
    const boss = bossDmTarget();
    if (boss) {
      const dest = r.kind === 'dm' ? r.group_name : `"${r.group_name || r.group_id}"`;
      await d
        .sendMessage(
          boss,
          `⌛ La respuesta pendiente #${r.id} para ${dest} lleva más de ${TTL_MIN()} min sin tu ` +
            `respuesta. Le avisé a ${r.trigger_sender || 'la persona'} que la estás validando.\n\n` +
            `Propuesta:\n${r.draft}\n\n` +
            `Si aún quieres que salga: *"apruebo #${r.id}"*. Para descartarla: *"no #${r.id}"*.`
        )
        .catch(() => {});
    }
    console.log(`[Scheduler] Respuesta #${r.id} venció (${TTL_MIN()} min) → rescate (aviso a remitente + jefe)`);
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
