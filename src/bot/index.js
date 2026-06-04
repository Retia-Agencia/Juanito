// src/bot/index.js
// Orquestador central — conecta Meta, OpenWA, Claude y la DB.
// Los tools (recordatorios, memoria, resúmenes, búsqueda) se ejecutan DENTRO de
// chat(); acá solo queda dedup, autorización y el envío de la respuesta.

import { chat, summarizeGroupMessages } from '../claude/index.js';
import { sendMessage } from '../meta/index.js';
import { saveSummary, markIfNew } from '../db/index.js';
import { phonesMatch } from '../common/utils.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const BOT_NAME = () => process.env.BOT_NAME || 'Juanito';

// ─── Procesar mensaje del jefe (viene del webhook de Meta) ────────────────────

export async function handleBossMessage(msg) {
  const { from, text, messageId } = msg;

  // Deduplicar: Meta puede reenviar el mismo webhook
  if (!markIfNew(messageId)) {
    console.log(`[Bot] Mensaje duplicado ignorado: ${messageId}`);
    return;
  }

  // Solo procesamos mensajes del jefe (comparación robusta de número)
  if (!phonesMatch(from, BOSS_PHONE())) {
    console.log(`[Bot] Mensaje de número no autorizado: ${from}`);
    return;
  }

  if (!text) {
    console.log('[Bot] Mensaje sin texto (media), ignorando');
    return;
  }

  console.log(`[Bot] Mensaje del jefe: ${text.slice(0, 60)}...`);

  try {
    // chat() ya ejecuta internamente create_reminder / save_memory /
    // summarize_group / search_knowledge; solo necesitamos su respuesta.
    const { text: reply } = await chat(text, from);
    await sendMessage(from, reply);
  } catch (err) {
    console.error('[Bot] Error procesando mensaje:', err.message);
    await sendMessage(from, 'Perdón, algo falló de mi lado. Intentá de nuevo 🙏').catch(() => {});
  }
}

// ─── Procesar mensaje de grupo (viene del webhook de OpenWA) ──────────────────

export async function handleGroupMessage(msg) {
  const { chatId, groupName, text, isGroup, messageId } = msg;

  if (!isGroup || !text) return;

  // Deduplicar también los mensajes de grupo
  if (!markIfNew(messageId || `${chatId}:${text}`)) {
    return;
  }

  console.log(`[Bot] Mensaje de grupo "${groupName}": ${text.slice(0, 60)}`);

  try {
    // Si mencionan al bot/jefe explícitamente, notificar de inmediato
    const isMentioned = text.toLowerCase().includes(BOT_NAME().toLowerCase());

    if (isMentioned) {
      const summary = await summarizeGroupMessages(groupName, text);
      const now = new Date().toISOString();

      saveSummary({
        chatId,
        chatName: groupName || chatId,
        summary,
        periodStart: now,
        periodEnd: now,
      });

      await sendMessage(
        BOSS_PHONE(),
        `📌 Te mencionaron en *${groupName}*:\n${text}\n\n_Resumen: ${summary}_`
      );
    }
  } catch (err) {
    console.error('[Bot] Error procesando mensaje de grupo:', err.message);
  }
}
