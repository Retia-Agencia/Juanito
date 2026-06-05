// scripts/pair-local.js
// Pairing standalone desde una IP residencial (la máquina del jefe).
// NO toca la DB ni Claude — solo Baileys — para esquivar better-sqlite3 en Windows.
// Genera la sesión en ./data/wa-session, que luego se copia al VPS.
//
// Uso:  node scripts/pair-local.js
// Salida: 0 = vinculado OK | 2 = loggedOut

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';

const SESSION_PATH = process.env.WA_SESSION_PATH || './data/wa-session';
const QR_PATH = './data/wa-qr.png';
const PAIRED_FLAG = './data/PAIRED';

// Sesión limpia: si hay restos de un intento previo, empezar de cero.
try { rmSync(PAIRED_FLAG, { force: true }); } catch {}
mkdirSync(SESSION_PATH, { recursive: true });

const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
const { version } = await fetchLatestBaileysVersion();
console.log(`[pair] Baileys WA version: ${version.join('.')}`);

function start() {
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys),
    },
    browser: Browsers.ubuntu('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        await QRCode.toFile(QR_PATH, qr, { width: 512, margin: 2 });
      } catch (e) {
        console.error('[pair] No se pudo escribir el PNG:', e.message);
      }
      console.log('\n[pair] QR nuevo — escaneá con WhatsApp del teléfono de Juanito:\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('QR_WRITTEN');
    }

    if (connection === 'open') {
      console.log('\n[pair] ✅ VINCULADO OK — sesión guardada en ' + SESSION_PATH);
      writeFileSync(PAIRED_FLAG, 'ok');
      // Esperar a que se persistan los últimos creds antes de salir.
      setTimeout(() => process.exit(0), 3000);
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[pair] Conexión cerrada — razón: ${reason}`);
      if (reason === DisconnectReason.loggedOut) {
        console.error('[pair] loggedOut — borrá ./data/wa-session y reintentá.');
        process.exit(2);
      }
      console.log('[pair] Reconectando para nuevo QR...');
      setTimeout(start, 3000);
    }
  });
}

start();
