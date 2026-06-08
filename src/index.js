// src/index.js
// Entry point — conecta Baileys, wira handlers y arranca el scheduler.

import 'dotenv/config';
import { connect } from './whatsapp/index.js';
import { handleBossMessage, handleGroupMessage } from './bot/index.js';
import { handleCloserOptin } from './calendly/optin.js';
import { startAllJobs } from './scheduler/index.js';
import { phonesMatch } from './common/utils.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
// LID del jefe: obtenerlo de los logs al arrancar ("[Main] DM de LID no resuelto: <lid>@lid").
// Si no está configurado, cualquier @lid no resuelto se trata como jefe (comportamiento anterior).
const BOSS_LID = () => process.env.BOSS_LID;
// LIDs adicionales con acceso de jefe (CSV). Pensado para pruebas: que el equipo (yo, mi amigo)
// pueda escribirle a Juanito desde su celular como "jefe" sin tener que rotar BOSS_LID.
const ADMIN_LIDS = () =>
  (process.env.ADMIN_LID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function onMessage({ chatId, isGroup, text, sender, groupName, messageId, isBotMentioned, pushName }) {
  if (!text) return;

  if (!isGroup) {
    // Identificar al jefe por su teléfono O su LID específico (o un ADMIN_LID de pruebas).
    // Con BOSS_LID configurado, los demás @lid van al flujo de opt-in (no al jefe).
    const bossLid = BOSS_LID();
    const adminLids = ADMIN_LIDS();
    const isBoss = phonesMatch(sender, BOSS_PHONE()) ||
      (sender?.endsWith('@lid') && (!bossLid || sender === bossLid || adminLids.includes(sender)));
    if (isBoss) {
      if (sender?.endsWith('@lid')) {
        const who = sender === bossLid ? 'jefe' : adminLids.includes(sender) ? 'admin' : 'jefe';
        console.log(`[Main] DM de LID del ${who}: ${sender}`);
      }
      await handleBossMessage({ from: sender, text, messageId }).catch((e) =>
        console.error('[Main] handleBossMessage:', e.message)
      );
      return;
    }
    // DM de un closer → registrar su opt-in (si es un closer conocido).
    // Pasa pushName para resolver closers cuando el LID no se mapea a teléfono.
    await handleCloserOptin({ from: sender, pushName, messageId }).catch((e) =>
      console.error('[Main] handleCloserOptin:', e.message)
    );
    return;
  }

  // Grupo: el mensaje ya fue guardado pasivamente por whatsapp/index.js
  await handleGroupMessage({ chatId, groupName, text, sender, isGroup, messageId, isBotMentioned }).catch((e) =>
    console.error('[Main] handleGroupMessage:', e.message)
  );
}

async function bootstrap() {
  await connect({ onMessage });
  startAllJobs();
  console.log('\n🚀 Juanito corriendo — escuchando WhatsApp\n');
}

process.on('unhandledRejection', (reason) => console.error('[Fatal] Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('[Fatal] Uncaught exception:', err));

bootstrap().catch((err) => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
