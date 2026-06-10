// src/bot/index.js
// Orquestador central — dedup, autorización y despacho a Claude.

import { chat } from '../claude/index.js';
import { sendMessage, getGroupParticipants } from '../whatsapp/index.js';
import {
  markIfNew,
  checkAndIncrementGroupUsage,
  isGroupAuthorized,
  authorizeGroup,
} from '../db/index.js';
import { phonesMatch } from '../common/utils.js';
import { roleOf, groupHasPrivilegedMember } from '../common/roles.js';

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

// ─── Autorización de grupos (default-deny anti-secuestro) ─────────────────────
// Juanito solo responde en grupos autorizados. Un grupo está autorizado si está
// en authorized_groups (lo agregó boss/admin, o se habilitó con /grupo on) o si
// un boss/admin es participante actual (fallback restart-safe para grupos legítimos
// preexistentes — los autoriza al vuelo y queda persistido).
async function isGroupAllowed(chatId, groupName) {
  if (isGroupAuthorized(chatId)) return true;
  try {
    const participants = await getGroupParticipants(chatId);
    if (groupHasPrivilegedMember(participants)) {
      authorizeGroup({ groupId: chatId, groupName, authorizedBy: 'participant' });
      console.log(`[Bot] Grupo autorizado al vuelo (jefe/admin presente): "${groupName}"`);
      return true;
    }
  } catch (e) {
    console.error('[Bot] No se pudo verificar participantes de grupo:', e.message);
  }
  return false;
}

// ─── Mención en grupo ─────────────────────────────────────────────────────────
// Solo responde a @mention real (función nativa de WhatsApp).
// Aplica rate limit a remitentes no registrados como ilimitados.

export async function handleGroupMessage(msg) {
  const { chatId, groupName, text, sender, isGroup, messageId, isBotMentioned } = msg;

  if (!isGroup || !text) return;
  if (!markIfNew(messageId || `${chatId}:${text}`)) return;

  if (!isBotMentioned) return;

  // Anti-secuestro: si el grupo no está autorizado, ignorar aunque mencionen al bot.
  if (!(await isGroupAllowed(chatId, groupName))) {
    console.log(`[Bot] Grupo no autorizado "${groupName}" — ignorando mención de ${sender}`);
    return;
  }

  // Rate limit: máx GROUP_DAILY_LIMIT consultas/día para remitentes no autorizados
  if (!isUnlimitedSender(sender)) {
    const allowed = checkAndIncrementGroupUsage(sender, GROUP_DAILY_LIMIT());
    if (!allowed) {
      console.log(`[Bot] Rate limit para ${sender} en "${groupName}" — ignorando`);
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
