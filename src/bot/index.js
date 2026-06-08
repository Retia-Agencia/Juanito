// src/bot/index.js
// Orquestador central — dedup, autorización y despacho a Claude.

import { chat } from '../claude/index.js';
import { sendMessage } from '../whatsapp/index.js';
import { markIfNew, checkAndIncrementGroupUsage } from '../db/index.js';
import { phonesMatch } from '../common/utils.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const BOT_NAME = () => process.env.BOT_NAME || 'Juanito';
const GROUP_DAILY_LIMIT = () => Number(process.env.GROUP_DAILY_LIMIT || 5);

// Teléfonos sin límite de consultas en grupos (además del jefe).
// Configurable vía env: UNLIMITED_PHONES=573001234567,573009876543
function isUnlimitedSender(sender) {
  const extras = (process.env.UNLIMITED_PHONES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return [BOSS_PHONE(), ...extras].some((phone) => phonesMatch(sender, phone));
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
  const { chatId, groupName, text, sender, isGroup, messageId, isBotMentioned } = msg;

  if (!isGroup || !text) return;
  if (!markIfNew(messageId || `${chatId}:${text}`)) return;

  if (!isBotMentioned) return;

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
    const { text: reply } = await chat(text, chatId, { isGroup: true });
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error('[Bot] Error respondiendo en grupo:', err.message);
  }
}
