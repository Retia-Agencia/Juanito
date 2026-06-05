// src/index.js
// Entry point — conecta Baileys, wira handlers y arranca el scheduler.

import 'dotenv/config';
import { connect } from './whatsapp/index.js';
import { handleBossMessage, handleGroupMessage } from './bot/index.js';
import { startAllJobs } from './scheduler/index.js';
import { phonesMatch } from './common/utils.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;

async function onMessage({ chatId, isGroup, text, sender, groupName, messageId }) {
  if (!text) return;

  if (!isGroup) {
    // DM: solo procesar si es del jefe
    if (phonesMatch(sender, BOSS_PHONE())) {
      await handleBossMessage({ from: sender, text, messageId }).catch((e) =>
        console.error('[Main] handleBossMessage:', e.message)
      );
    }
    return;
  }

  // Grupo: el mensaje ya fue guardado pasivamente por whatsapp/index.js
  await handleGroupMessage({ chatId, groupName, text, sender, isGroup, messageId }).catch((e) =>
    console.error('[Main] handleGroupMessage:', e.message)
  );
}

async function bootstrap() {
  startAllJobs();
  await connect({ onMessage });
  console.log('\n🚀 Juanito corriendo — escuchando WhatsApp\n');
}

process.on('unhandledRejection', (reason) => console.error('[Fatal] Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('[Fatal] Uncaught exception:', err));

bootstrap().catch((err) => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
