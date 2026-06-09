// src/index.js
// Entry point — conecta Baileys, wira handlers y arranca el scheduler.

import 'dotenv/config';
import { connect, sendMessage, isConnected } from './whatsapp/index.js';
import { handleBossMessage, handleGroupMessage } from './bot/index.js';
import { handleCommand } from './bot/commands.js';
import { handleCloserOptin } from './calendly/optin.js';
import { startAllJobs } from './scheduler/index.js';
import { roleOf, isPrivileged } from './common/roles.js';
import { listOptins, markIfNew, isCalendlyPaused, setCalendlyPaused, setCloserPaused } from './db/index.js';
import { resolveCloserByPushName } from './calendly/closers.js';
import { getHealth } from './calendly/health.js';

async function onMessage({ chatId, isGroup, text, sender, groupName, messageId, isBotMentioned, pushName }) {
  if (!text) return;

  if (!isGroup) {
    // Rol del remitente (admin = equipo, boss = jefe sandboxed, unknown = otro).
    const role = roleOf(sender);

    // Comandos deterministas (sin Claude): /whoami, /status. Se atienden antes del
    // ruteo para que /whoami funcione incluso para un admin nuevo aún no configurado.
    const cmdReply = handleCommand(
      { text, sender, role },
      {
        listOptins,
        isConnected,
        getHealth,
        isCalendlyPaused,
        setCalendlyPaused,
        setCloserPaused,
        resolveCloserByPushName,
      }
    );
    if (cmdReply !== null) {
      if (markIfNew(messageId)) {
        await sendMessage(sender, cmdReply).catch((e) =>
          console.error('[Main] comando:', e.message)
        );
      }
      return;
    }

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
