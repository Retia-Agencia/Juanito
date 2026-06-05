// src/bot/index.js
// Orquestador central — dedup, autorización y despacho a Claude.
// Los tools (recordatorios, memoria, resúmenes, búsqueda) se ejecutan DENTRO de
// chat(); acá solo queda el routing.

import { chat } from '../claude/index.js';
import { sendMessage } from '../whatsapp/index.js';
import { markIfNew } from '../db/index.js';
import { phonesMatch } from '../common/utils.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const BOT_NAME = () => process.env.BOT_NAME || 'Juanito';

// ─── DM del jefe ──────────────────────────────────────────────────────────────

export async function handleBossMessage(msg) {
  const { from, text, messageId } = msg;

  if (!markIfNew(messageId)) return;

  if (!phonesMatch(from, BOSS_PHONE())) {
    console.log(`[Bot] DM de número no autorizado: ${from}`);
    return;
  }

  if (!text) return;

  console.log(`[Bot] Jefe: ${text.slice(0, 60)}`);

  try {
    const { text: reply } = await chat(text, from);
    await sendMessage(from, reply);
  } catch (err) {
    console.error('[Bot] Error en DM del jefe:', err.message);
    await sendMessage(from, 'Perdón, algo falló de mi lado. Intentá de nuevo 🙏').catch(() => {});
  }
}

// ─── Mención en grupo ─────────────────────────────────────────────────────────
// El mensaje ya fue guardado pasivamente en DB por whatsapp/index.js.
// Solo actúa cuando lo mencionan; responde directamente en el grupo.

export async function handleGroupMessage(msg) {
  const { chatId, groupName, text, isGroup, messageId } = msg;

  if (!isGroup || !text) return;

  if (!markIfNew(messageId || `${chatId}:${text}`)) return;

  const isMentioned = text.toLowerCase().includes(BOT_NAME().toLowerCase());
  if (!isMentioned) return;

  console.log(`[Bot] Mencionado en "${groupName}": ${text.slice(0, 60)}`);

  try {
    const { text: reply } = await chat(text, chatId);
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error('[Bot] Error respondiendo en grupo:', err.message);
  }
}
