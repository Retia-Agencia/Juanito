// src/bot/index.js
// Orquestador central — dedup, autorización y despacho a Claude.

import { chat } from '../claude/index.js';
import { sendMessage } from '../whatsapp/index.js';
import { markIfNew, checkAndIncrementGroupUsage, isGroupAuthorized } from '../db/index.js';
import { phonesMatch } from '../common/utils.js';
import { roleOf } from '../common/roles.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const BOT_NAME = () => process.env.BOT_NAME || 'Juanito';
const GROUP_DAILY_LIMIT = () => Number(process.env.GROUP_DAILY_LIMIT || 5);

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

// ─── Mención en grupo ─────────────────────────────────────────────────────────
// Solo responde a @mention real (función nativa de WhatsApp).
// Aplica rate limit a remitentes no registrados como ilimitados.

export async function handleGroupMessage(msg) {
  const { chatId, groupName, text, sender, isGroup, messageId, isBotMentioned, pushName } = msg;

  if (!isGroup || !text) return;
  if (!markIfNew(messageId || `${chatId}:${text}`)) return;

  if (!isBotMentioned) return;

  // Anti-secuestro: solo responde en grupos autorizados. La autorización al vuelo
  // (jefe/admin presente) y el auto-leave los maneja group-guard antes de llegar aquí.
  if (!isGroupAuthorized(chatId)) {
    console.log(`[Bot] Grupo no autorizado "${groupName}" — ignorando mención de ${sender}`);
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
          `${quien} alcanzaste tu límite de consultas por hoy (${limit}). Se reinicia mañana 🙂`
        ).catch(() => {});
      }
      return;
    }
  }

  console.log(`[Bot] Mencionado en "${groupName}": ${text.slice(0, 60)}`);

  try {
    // El prompt de grupo es aislado e ignora el rol para la persona, pero pasamos el
    // rol real (no el default 'boss') para no tratar a cualquiera como el dueño.
    const role = roleOf(sender);
    const { text: reply } = await chat(text, chatId, { isGroup: true, role });
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error('[Bot] Error respondiendo en grupo:', err.message);
  }
}
