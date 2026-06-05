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
import { saveMessage } from '../db/index.js';
import db from '../db/index.js';

const SESSION_PATH = process.env.WA_SESSION_PATH || './data/wa-session';
const AGENT_PHONE = () => process.env.AGENT_PHONE; // ej: +573001234567

let sock = null;

// ─── Normalización de JID ─────────────────────────────────────────────────────

function toJid(raw) {
  if (!raw) throw new Error('toJid: destinatario vacío');
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

// ─── Conexión principal ───────────────────────────────────────────────────────
// Retorna una Promise que resuelve cuando la sesión está abierta.
// Si el número nunca estuvo vinculado, imprime el código de pairing y espera.

export async function connect({ onMessage }) {
  mkdirSync(SESSION_PATH, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys),
    },
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    // Silenciar logs internos de Baileys (los nuestros son suficientes)
    logger: { level: 'silent', child: () => ({ level: 'silent', child: () => {}, trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }), trace: () => {}, debug: () => {}, info: () => {}, warn: (msg) => console.warn('[Baileys]', msg), error: (msg) => console.error('[Baileys]', msg) },
  });

  // Pairing por código (no QR) si es la primera vez
  if (!sock.authState.creds.registered) {
    const phone = AGENT_PHONE();
    if (!phone) {
      throw new Error(
        'AGENT_PHONE no configurado — necesario para el primer vinculado.\n' +
        'Agregá AGENT_PHONE=+57XXXXXXXXXX en .env y reiniciá.'
      );
    }
    const digits = phone.replace(/\D/g, '');
    const code = await sock.requestPairingCode(digits);
    console.log('\n' + '─'.repeat(50));
    console.log('📱 Código de vinculación:', code);
    console.log('   En el teléfono: WhatsApp → Dispositivos vinculados');
    console.log('   → Vincular con número de teléfono → ingresá el código');
    console.log('─'.repeat(50) + '\n');
  }

  sock.ev.on('creds.update', saveCreds);

  // Estado de conexión
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('[WhatsApp] Conectado ✅');
      return;
    }
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[WhatsApp] Conexión cerrada — razón: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        console.error('[WhatsApp] Sesión cerrada (loggedOut). Borrar ./data/wa-session y re-vincular.');
        process.exit(2);
      }
      // Para cualquier otro cierre: salir → entrypoint.sh con backoff maneja el restart
      process.exit(1);
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

      // Nombre a mostrar del sender (disponible en pushName cuando el contacto lo tiene)
      const senderName = msg.pushName || sender;

      // Nombre del grupo
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
      // Formato: "[SenderName]: texto" — getRecentMessages lo parsea de vuelta
      if (isGroup) {
        try {
          saveMessage({
            role: 'user',
            content: `[${senderName}]: ${text}`,
            source: 'group',
            chatId,
          });
        } catch (e) {
          console.error('[WhatsApp] Error guardando mensaje de grupo:', e.message);
        }
      }

      await onMessage({ chatId, isGroup, text, sender, groupName, messageId }).catch((e) =>
        console.error('[WhatsApp] Error en onMessage:', e.message)
      );
    }
  });

  // Esperar hasta que la sesión esté abierta
  return new Promise((resolve) => {
    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'open') resolve();
    });
    // Si ya estaba abierta antes de registrar el handler (caso de reconexión rápida)
    if (sock.ws?.readyState === 1) resolve();
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
// Los mensajes se guardan al llegar (lectura pasiva). No hace llamadas a WA.

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
    // Parsear formato "[SenderName]: texto"
    const match = row.content.match(/^\[(.+?)\]: ([\s\S]+)$/);
    if (match) {
      return {
        body: match[2],
        sender: { id: null, pushname: match[1] },
        timestamp: row.timestamp,
      };
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
