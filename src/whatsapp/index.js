// src/whatsapp/index.js
// Cliente Baileys: conexión WhatsApp, envío, lectura de grupos.
// Expone la misma interfaz que antes proveían openwa/index.js + meta/index.js.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { mkdirSync } from 'fs';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { updateQR, markConnected, startQRServer } from './qr-server.js';
import { saveMessage } from '../db/index.js';
import db from '../db/index.js';

const SESSION_PATH = process.env.WA_SESSION_PATH || './data/wa-session';
const QR_PATH = process.env.WA_QR_PATH || './data/wa-qr.png';

let sock = null;

// ─── Normalización de JID ─────────────────────────────────────────────────────

function toJid(raw) {
  if (!raw) throw new Error('toJid: destinatario vacío');
  if (raw.includes('@')) return raw;
  return `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
}

// ─── Render del QR ────────────────────────────────────────────────────────────
// El QR ASCII en terminal SSH se renderiza chico y a veces se corrompe → escaneos
// fallidos repetidos → WhatsApp responde "no se pueden conectar dispositivos en
// este momento". Generamos una imagen PNG limpia (recuperable con `docker cp`) y
// un data URL que se pega directo en el navegador del ordenador.

async function renderQR(qr) {
  // 1) PNG en disco — recuperar con: docker cp juanito-agent:/app/data/wa-qr.png .
  try {
    await QRCode.toFile(QR_PATH, qr, { width: 512, margin: 2 });
    console.log(`\n📷 QR guardado como imagen: ${QR_PATH}`);
    console.log('   Bajalo del VPS con:  docker cp juanito-agent:/app/data/wa-qr.png .');
  } catch (e) {
    console.error('[WhatsApp] No se pudo escribir el PNG del QR:', e.message);
  }

  // 2) Data URL — copiá la línea completa y pegala en la barra del navegador.
  try {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 2 });
    console.log('\n🔗 O pegá esta línea COMPLETA en la barra de tu navegador:\n');
    console.log(dataUrl);
  } catch (e) {
    console.error('[WhatsApp] No se pudo generar el data URL del QR:', e.message);
  }

  // 3) Fallback ASCII (sin `small` para que sea más escaneable).
  console.log('\n📱 (Fallback) QR en terminal — WhatsApp → Dispositivos vinculados → Vincular un dispositivo:\n');
  qrcode.generate(qr, { small: false });
  console.log('\n');
}

// ─── Conexión principal ───────────────────────────────────────────────────────
// Reconecta internamente durante el pairing (sin salir del proceso).
// Una vez conectado, ante cualquier caída sale con exit(1) para que
// entrypoint.sh aplique el backoff exponencial.

export async function connect({ onMessage }) {
  mkdirSync(SESSION_PATH, { recursive: true });
  startQRServer(Number(process.env.QR_PORT) || 0);

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve) => {
    let hasConnected = false;

    function createSocket() {
      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys),
        },
        browser: Browsers.ubuntu('Chrome'),
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          // Alimenta el qr-server (inerte si QR_PORT no está seteado) y además
          // genera el PNG/dataURL + fallback ASCII en logs.
          updateQR(qr);
          renderQR(qr).catch((e) => console.error('[WhatsApp] Error generando QR:', e.message));
        }
        if (connection === 'open') {
          markConnected();
          console.log('[WhatsApp] Conectado ✅');
          hasConnected = true;
          resolve();
          return;
        }

        if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
          console.log(`[WhatsApp] Conexión cerrada — razón: ${reason}`);

          if (reason === DisconnectReason.loggedOut) {
            console.error('[WhatsApp] Sesión cerrada (loggedOut). Borrar ./data/wa-session y re-vincular.');
            process.exit(2);
          }

          if (hasConnected) {
            // Ya estábamos conectados — entrypoint.sh maneja el restart con backoff
            process.exit(1);
          } else {
            // Aún en fase de pairing — reconectar internamente en 3 segundos
            console.log('[WhatsApp] Reconectando para nuevo QR...');
            setTimeout(createSocket, 3000);
          }
        }
      });

      // Mensajes entrantes
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          if (!msg.message) continue;

          const chatId = msg.key.remoteJid;
          const isGroup = chatId?.endsWith('@g.us');
          const messageId = msg.key.id;

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            null;

          if (!text) continue;

          const sender = isGroup ? (msg.key.participant || chatId) : chatId;
          const senderName = msg.pushName || sender;

          let groupName = chatId;
          if (isGroup) {
            try {
              const meta = await sock.groupMetadata(chatId);
              groupName = meta.subject || chatId;
            } catch {
              groupName = chatId;
            }
          }

          // Guardar mensaje de grupo en DB (lectura pasiva)
          if (isGroup) {
            try {
              saveMessage({
                role: 'user',
                content: `[${senderName}]: ${text}`,
                source: 'group',
                chatId,
              });
            } catch (e) {
              console.error('[WhatsApp] Error guardando mensaje:', e.message);
            }
          }

          await onMessage({ chatId, isGroup, text, sender, groupName, messageId }).catch((e) =>
            console.error('[WhatsApp] Error en onMessage:', e.message)
          );
        }
      });
    }

    createSocket();
  });
}

// ─── Envío de mensajes ────────────────────────────────────────────────────────

export async function sendMessage(to, text) {
  if (!sock) throw new Error('sendMessage: WhatsApp no conectado aún');
  const jid = toJid(to);
  await sock.sendMessage(jid, { text });
  console.log(`[WhatsApp] → ${to}`);
}

// ─── Listar grupos ────────────────────────────────────────────────────────────

export async function listGroups() {
  if (!sock) return [];
  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ id: g.id, name: g.subject }));
  } catch (e) {
    console.error('[WhatsApp] Error listando grupos:', e.message);
    return [];
  }
}

// ─── Mensajes recientes de un grupo (desde SQLite) ────────────────────────────

export async function getRecentMessages(chatId, limit = 30) {
  const rows = db
    .prepare(
      `SELECT content, created_at AS timestamp
       FROM messages
       WHERE chat_id = ? AND source = 'group'
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(chatId, limit)
    .reverse();

  return rows.map((row) => {
    const match = row.content.match(/^\[(.+?)\]: ([\s\S]+)$/);
    if (match) {
      return { body: match[2], sender: { id: null, pushname: match[1] }, timestamp: row.timestamp };
    }
    return { body: row.content, sender: { id: null, pushname: null }, timestamp: row.timestamp };
  });
}

// ─── Resolver grupo por nombre ────────────────────────────────────────────────

export async function resolveGroupByName(name, groups) {
  if (!name) return null;
  const list = groups || (await listGroups());
  const q = name.trim().toLowerCase();
  return (
    list.find((g) => (g.name || '').toLowerCase() === q) ||
    list.find((g) => (g.name || '').toLowerCase().includes(q)) ||
    null
  );
}
