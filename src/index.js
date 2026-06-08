// src/index.js
// Entry point — conecta Baileys, wira handlers y arranca el scheduler.

import 'dotenv/config';
import { connect } from './whatsapp/index.js';
import { handleBossMessage, handleGroupMessage } from './bot/index.js';
import { handleCloserOptin } from './calendly/optin.js';
import { startAllJobs } from './scheduler/index.js';
import { roleOf, isPrivileged } from './common/roles.js';

async function onMessage({ chatId, isGroup, text, sender, groupName, messageId, isBotMentioned, pushName }) {
  if (!text) return;

  if (!isGroup) {
    // Rol del remitente (admin = equipo, boss = jefe sandboxed, unknown = otro).
    const role = roleOf(sender);
    if (isPrivileged(role)) {
      if (sender?.endsWith('@lid')) {
        console.log(`[Main] DM de LID del ${role}: ${sender}`);
      }
      await handleBossMessage({ from: sender, text, messageId, role }).catch((e) =>
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
