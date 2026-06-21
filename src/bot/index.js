// src/bot/index.js
// Orquestador central — dedup, autorización y despacho a Claude.

import { chat } from '../claude/index.js';
import { sendMessage } from '../whatsapp/index.js';
import {
  markIfNew,
  checkAndIncrementGroupUsage,
  checkAndIncrementGroupReplyQuota,
  isGroupAuthorized,
  getGroupApproval,
  isDmApprovalOn,
  createPendingReply,
  listPendingReplies,
  approvePendingReply,
  listPendingDrafts,
  approveDraft,
} from '../db/index.js';
import { phonesMatch, isWithinQuietHours } from '../common/utils.js';
import { roleOf, isStrictPrivileged } from '../common/roles.js';
import { approvalsTarget, approvalsGroupId } from '../common/approval-routing.js';
import { parseApproval } from '../common/approval-intent.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const BOT_NAME = () => process.env.BOT_NAME || 'Juanito';
const GROUP_DAILY_LIMIT = () => Number(process.env.GROUP_DAILY_LIMIT || 5);

// Aviso amable al remitente cuando Juanito está en horario de descanso (quiet hours) y las
// aprobaciones están ON: su mensaje queda en cola y el jefe lo verá al volver. Configurable.
const QUIET_HOURS_NOTICE = () =>
  process.env.QUIET_HOURS_NOTICE ||
  'por ahora estoy fuera de horario 🌙. Le paso tu mensaje al equipo y te respondo apenas ' +
    'volvamos al horario laboral. ¡Gracias por la paciencia!';

function localDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Bogota' });
}

// Avisa al remitente, UNA sola vez por día (dedup vía markIfNew), que es horario fuera de
// servicio. quoted (opcional) cita su mensaje original en grupos.
async function sendQuietHoursNotice(target, sender, pushName, quoted) {
  if (!markIfNew(`quiet:${sender}:${localDateStr()}`)) return;
  const saludo = pushName ? `¡Hola, ${pushName}! ` : '¡Hola! ';
  await sendMessage(target, saludo + QUIET_HOURS_NOTICE(), quoted ? { quoted } : {}).catch(() => {});
}
// Tope de respuestas AUTÓNOMAS del bot por grupo por hora (anti-ráfaga). Las respuestas
// aprobadas por el jefe NO cuentan contra este tope.
const GROUP_REPLY_HOURLY_CAP = () => Number(process.env.GROUP_REPLY_HOURLY_CAP || 15);

// Remitentes sin límite de consultas en grupos.
// El jefe y los admins se reconocen por rol (roleOf maneja teléfono Y LID — en grupos
// el jefe llega como @lid, no como teléfono, así que phonesMatch solo no basta).
// Además se permite una lista extra por env: UNLIMITED_PHONES=573001234567,573009876543
function isUnlimitedSender(sender) {
  const role = roleOf(sender);
  if (role === 'boss' || role === 'admin') return true;
  const extras = (process.env.UNLIMITED_PHONES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return extras.some((phone) => phonesMatch(sender, phone));
}

// ─── DM del jefe ──────────────────────────────────────────────────────────────

export async function handleBossMessage(msg) {
  const { from, text, messageId, role = 'boss' } = msg;

  if (!markIfNew(messageId)) return;

  if (!phonesMatch(from, BOSS_PHONE()) && !from?.endsWith('@lid')) {
    console.log(`[Bot] DM de número no autorizado: ${from}`);
    return;
  }

  if (!text) return;

  console.log(`[Bot] ${role === 'admin' ? 'Admin' : 'Jefe'}: ${text.slice(0, 60)}`);

  try {
    const { text: reply } = await chat(text, from, { role });
    await sendMessage(from, reply);
  } catch (err) {
    console.error('[Bot] Error en DM del jefe:', err.message);
    await sendMessage(from, 'Perdón, algo falló de mi lado. Intentá de nuevo 🙏').catch(() => {});
  }
}

// ─── DM de cualquiera (desconocido) ───────────────────────────────────────────
// Juanito responde a quien le escriba por privado como un asistente general AISLADO
// (sin datos privados ni tools — ver buildSystemPrompt publicDm). Es SIEMPRE una
// respuesta a un mensaje entrante: nunca escribe primero (regla anti-ban). Volumen
// acotado por un rate-limit por remitente (mismo tope diario que en grupos).

export async function handlePublicDm({ from, text, messageId, pushName, rawMsg }) {
  if (!from || !text) return;
  if (!markIfNew(messageId)) return;

  // Rate-limit por remitente. Clave prefijada 'dm:' para no compartir contador con los
  // grupos. Al exceder, un único aviso (la 1ª denegación del día) y luego silencio.
  const limit = GROUP_DAILY_LIMIT();
  const { allowed, count } = checkAndIncrementGroupUsage(`dm:${from}`, limit);
  if (!allowed) {
    console.log(`[Bot] Rate limit DM para ${from} — ignorando (intento ${count})`);
    if (count === limit + 1) {
      const quien = pushName ? `${pushName}, ya` : 'Ya';
      await sendMessage(
        from,
        `${quien} alcanzaste tu límite de mensajes por hoy (${limit}). Se reinicia mañana 🙂`
      ).catch(() => {});
    }
    return;
  }

  console.log(`[Bot] DM público de ${pushName || from}: ${text.slice(0, 60)}`);

  try {
    const { text: reply } = await chat(text, from, { publicDm: true, role: 'unknown' });

    // Toggle global de aprobación de DMs (admin: /confirmaciones dm on). Si está ON, NO se
    // responde directo: la respuesta se retiene como pendiente (kind='dm') y se le manda al
    // jefe por DM para que apruebe/corrija/descarte. Un cron entrega las aprobadas y caduca
    // las que llevan demasiado tiempo sin decisión (mismo carril que las respuestas de grupo).
    if (isDmApprovalOn()) {
      // En horario de descanso: retener (held=1) sin molestar al jefe y avisar al remitente.
      const quiet = isWithinQuietHours();
      const id = createPendingReply({
        kind: 'dm',
        groupId: from,
        groupName: `DM de ${pushName || from}`,
        triggerSender: pushName || from,
        triggerText: text,
        // Identidad del mensaje gatillo → permite CITARLO cuando la respuesta salga tras la
        // aprobación del jefe (minutos después).
        triggerMsgId: rawMsg?.key?.id,
        triggerParticipant: rawMsg?.key?.participant,
        draft: reply,
        held: quiet ? 1 : 0,
      });

      if (quiet) {
        await sendQuietHoursNotice(from, from, pushName, rawMsg);
        console.log(`[Bot] DM de ${pushName || from} RETENIDO por horario de descanso (pendiente #${id})`);
        return;
      }

      const boss = await approvalsTarget();
      if (boss) {
        await sendMessage(
          boss,
          `📨 *Respuesta pendiente #${id}* para el *DM de ${pushName || from}*\n\n` +
            `${pushName || 'Alguien'} escribió: "${text.slice(0, 200)}"\n\n` +
            `Propongo responder:\n${reply}\n\n` +
            `Responde *"apruebo"* para que salga, dime los cambios, o *"no"* para descartarla.`
        ).catch(() => {});
      }
      console.log(`[Bot] DM de ${pushName || from} RETENIDO para aprobación (pendiente #${id})`);
      return;
    }

    await sendMessage(from, reply);
  } catch (err) {
    console.error('[Bot] Error en DM público:', err.message);
    await sendMessage(from, 'Perdón, algo falló de mi lado. Intentá de nuevo 🙏').catch(() => {});
  }
}

// ─── Consola de aprobaciones (grupo dedicado "Aprobaciones Juanito") ───────────
// Si APPROVALS_GROUP está configurado, las solicitudes de aprobación se publican EN ese
// grupo (no en el DM del jefe). Acá el jefe/admin las gestionan SIN mención: cualquier
// mensaje suyo en ese grupo se interpreta como decisión sobre lo pendiente (aprobar/
// corregir/descartar). Lo aprobado sale a su grupo/DM original (cron de entrega), no acá.

// Una aprobación CLARA ("apruebo", "aprobado", "envíalo así", "dale", "ok", "#3")
// se resuelve de forma DETERMINISTA (parseApproval), sin pasar por el LLM. Esto evita el
// loop en que el modelo interpretaba la aprobación como una corrección y re-generaba sin fin.
export async function handleApprovalConsole({ chatId, text, sender, messageId, rawMsg }) {
  if (!text) return false;
  const approvalsId = await approvalsGroupId();
  if (!approvalsId || chatId !== approvalsId) return false;
  // Solo jefe/admin (verificado ESTRICTO) deciden aquí; el resto del grupo se ignora.
  if (!isStrictPrivileged(sender)) return false;
  if (!markIfNew(messageId || `${chatId}:${text}`)) return true;

  console.log(`[Bot] Consola de aprobaciones: ${text.slice(0, 60)}`);
  try {
    // 1) Fast-path DETERMINISTA para aprobaciones claras (anti-loop): aprueba sin LLM.
    const { isApprove, id } = parseApproval(text);
    if (isApprove) {
      const candidates = [
        ...(listPendingReplies() || []).map((r) => ({ type: 'reply', id: r.id, name: r.group_name })),
        ...(listPendingDrafts(localDateStr()) || []).map((d) => ({ type: 'draft', id: d.id, name: d.group_name })),
      ];
      if (!candidates.length) {
        await sendMessage(chatId, 'No hay nada pendiente de aprobar ahora 👍', { quoted: rawMsg });
        return true;
      }
      // id explícito → ese; sin id y un solo pendiente → ese; si es ambiguo, lo decide el LLM.
      const matches = id != null ? candidates.filter((c) => c.id === id) : candidates;
      if (matches.length === 1) {
        const t = matches[0];
        const changes = t.type === 'reply' ? approvePendingReply(t.id) : approveDraft(t.id);
        const label = t.type === 'reply' ? 'respuesta' : 'borrador';
        const msg = changes
          ? `Aprobado ✅ — la ${label} #${t.id} para *${t.name}* sale a su destino en breve.`
          : `La ${label} #${t.id} ya no está pendiente.`;
        await sendMessage(chatId, msg, { quoted: rawMsg });
        console.log(`[Bot] Aprobación determinista: ${label} #${t.id} (changes=${changes})`);
        return true;
      }
      // 0 coincidencias por id, o varias y ambiguo → cae al LLM para que pregunte cuál.
    }

    // 2) Resto (correcciones, descartes, ambigüedad, preguntas) → LLM con contexto de pendientes.
    // Hilo dedicado (`approvals:<grupo>`) para aislar el historial; se trata como DM (no isGroup).
    const { text: reply } = await chat(text, `approvals:${chatId}`, {
      role: roleOf(sender),
      approvalsConsole: true,
    });
    await sendMessage(chatId, reply, { quoted: rawMsg });
  } catch (err) {
    console.error('[Bot] Error en consola de aprobaciones:', err.message);
  }
  return true;
}

// ─── Mención en grupo ─────────────────────────────────────────────────────────
// Solo responde a @mention real (función nativa de WhatsApp).
// Aplica rate limit a remitentes no registrados como ilimitados.

export async function handleGroupMessage(msg) {
  const { chatId, groupName, text, sender, isGroup, messageId, isBotMentioned, pushName, rawMsg } = msg;

  if (!isGroup || !text) return;
  if (!markIfNew(messageId || `${chatId}:${text}`)) return;

  if (!isBotMentioned) return;

  // Anti-secuestro: solo responde en grupos autorizados. La autorización al vuelo
  // (jefe/admin presente) y el auto-leave los maneja group-guard antes de llegar aquí.
  if (!isGroupAuthorized(chatId)) {
    console.log(`[Bot] Grupo no autorizado "${groupName}" — ignorando mención de ${sender}`);
    return;
  }

  // Órdenes del jefe DESDE el grupo: si quien menciona es el jefe/admin (verificado ESTRICTO
  // — NO el fallback "cualquier @lid = jefe", que en grupos convertiría a todos en jefe),
  // Juanito ejecuta la orden con un set acotado de tools (recordatorios, instrucciones del
  // grupo, mensajes recurrentes) y confirma EN EL MISMO grupo donde se dio la orden (citando
  // el mensaje gatillo), para que quien la dio la vea donde la escribió.
  if (isStrictPrivileged(sender)) {
    console.log(`[Bot] Orden del jefe desde "${groupName}": ${text.slice(0, 60)}`);
    try {
      // Hilo DEDICADO (`bossorders:<grupo>`): aísla las órdenes del jefe del historial
      // compartido del chatbot del grupo. El id real del grupo va en groupId (para que las
      // tools apunten a "este grupo"). createdBy = QUIEN dio la orden (el sender real): así un
      // recordatorio sin destinatario explícito queda para esa persona y se le entrega a ELLA,
      // no a un destino fijo. En grupo el sender es su LID, que es identidad DM-able.
      const { text: reply } = await chat(text, `bossorders:${chatId}`, {
        isGroup: true,
        role: roleOf(sender),
        bossInGroup: true,
        groupId: chatId,
        groupName,
        createdBy: sender,
      });
      await sendMessage(chatId, reply, { quoted: rawMsg });
    } catch (err) {
      console.error('[Bot] Error en orden del jefe desde grupo:', err.message);
    }
    return;
  }

  // Rate limit: máx GROUP_DAILY_LIMIT consultas/día para remitentes no autorizados.
  // La PRIMERA vez que alguien excede el límite se le avisa (una sola vez al día);
  // las denegaciones siguientes son silencio, como antes (§18.D P2).
  if (!isUnlimitedSender(sender)) {
    const limit = GROUP_DAILY_LIMIT();
    const { allowed, count } = checkAndIncrementGroupUsage(sender, limit);
    if (!allowed) {
      console.log(`[Bot] Rate limit para ${sender} en "${groupName}" — ignorando (intento ${count})`);
      if (count === limit + 1) {
        const quien = pushName ? `${pushName}, ya` : 'Ya';
        await sendMessage(
          chatId,
          `${quien} alcanzaste tu límite de consultas por hoy (${limit}). Se reinicia mañana 🙂`,
          { quoted: rawMsg }
        ).catch(() => {});
      }
      return;
    }
  }

  console.log(`[Bot] Mencionado en "${groupName}": ${text.slice(0, 60)}`);

  const requiresApproval = getGroupApproval(chatId);

  // Tope anti-ráfaga por grupo/hora — SOLO para respuestas autónomas (las que se
  // publican sin pasar por el jefe). Las que requieren aprobación NO cuentan acá (el
  // jefe las sanciona) pero igual quedan espaciadas por la cola por-grupo.
  if (!requiresApproval) {
    const cap = GROUP_REPLY_HOURLY_CAP();
    const { allowed, count } = checkAndIncrementGroupReplyQuota(chatId, cap);
    if (!allowed) {
      console.log(`[Bot] Tope horario de respuestas alcanzado en "${groupName}" (${count}/${cap}) — silencio`);
      return;
    }
  }

  try {
    // El prompt de grupo es aislado e ignora el rol para la persona, pero pasamos el
    // rol real (no el default 'boss') para no tratar a cualquiera como el dueño.
    const role = roleOf(sender);
    const { text: reply } = await chat(text, chatId, { isGroup: true, role });

    // Si el grupo exige aprobación, NO se publica: se guarda como pendiente y se le
    // manda al jefe por DM para que apruebe/corrija/descarte (caduca por cron).
    if (requiresApproval) {
      // En horario de descanso NO se molesta al jefe: la pendiente se RETIENE (held=1, no
      // notifica ni caduca) y al remitente se le avisa amablemente. Un cron le manda el
      // digest al jefe al volver el horario laboral.
      const quiet = isWithinQuietHours();
      const id = createPendingReply({
        groupId: chatId,
        groupName,
        triggerSender: pushName || sender,
        triggerText: text,
        // Identidad del mensaje gatillo → permite CITARLO cuando la respuesta salga
        // (minutos después, tras la aprobación del jefe).
        triggerMsgId: rawMsg?.key?.id,
        triggerParticipant: rawMsg?.key?.participant,
        draft: reply,
        held: quiet ? 1 : 0,
      });

      if (quiet) {
        await sendQuietHoursNotice(chatId, sender, pushName, rawMsg);
        console.log(`[Bot] Respuesta en "${groupName}" RETENIDA por horario de descanso (pendiente #${id})`);
        return;
      }

      const boss = await approvalsTarget();
      if (boss) {
        await sendMessage(
          boss,
          `📨 *Respuesta pendiente #${id}* para el grupo *${groupName || chatId}*\n\n` +
            `${pushName || 'Alguien'} escribió: "${text.slice(0, 200)}"\n\n` +
            `Propongo responder:\n${reply}\n\n` +
            `Responde *"apruebo"* para que salga, dime los cambios, o *"no"* para descartarla.`
        ).catch(() => {});
      }
      console.log(`[Bot] Respuesta en "${groupName}" RETENIDA para aprobación (pendiente #${id})`);
      return;
    }

    await sendMessage(chatId, reply, { quoted: rawMsg });
  } catch (err) {
    console.error('[Bot] Error respondiendo en grupo:', err.message);
  }
}
