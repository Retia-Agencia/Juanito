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
import { phonesMatch } from '../common/utils.js';

const SESSION_PATH = process.env.WA_SESSION_PATH || './data/wa-session';
const QR_PATH = process.env.WA_QR_PATH || './data/wa-qr.png';

let sock = null;
let botJid = null;    // "573332761238@s.whatsapp.net"
let botLidNum = null; // "31302527013028" — LID numérico del bot, WA lo usa en mentionedJid

// ─── Resolución de LID → JID de teléfono ──────────────────────────────────────
// WhatsApp multi-device usa LIDs (@lid) para el routing Signal interno.
// Los mensajes llegan con remoteJid=@lid en vez de @s.whatsapp.net.
// contacts.upsert proporciona el mapeo LID ↔ phone JID.

const lidMap = new Map();

function resolveJid(jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  return lidMap.get(jid) || jid;
}

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

export async function connect({ onMessage, onGroupJoin }) {
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
        // Necesario para que Baileys pueda resolver reintentos de descifrado
        // cuando el session Signal del remitente cambia (LID key rotation).
        getMessage: async () => ({ conversation: '' }),
      });

      sock.ev.on('creds.update', saveCreds);

      // Construir mapa LID ↔ phone JID a medida que llegan actualizaciones de contactos
      sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
          if (c.lid && c.id) {
            lidMap.set(c.lid, c.id);
            lidMap.set(c.id, c.lid);
          }
        }
      });
      sock.ev.on('contacts.update', (updates) => {
        for (const u of updates) {
          if (u.lid && u.id) lidMap.set(u.lid, u.id);
        }
      });

      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          updateQR(qr);
          renderQR(qr).catch((e) => console.error('[WhatsApp] Error generando QR:', e.message));
        }
        if (connection === 'open') {
          markConnected();
          // Guardar JID y LID propios para detectar @mentions en grupos.
          // WhatsApp usa el LID (no el teléfono) en mentionedJid para cuentas multi-device.
          botJid = sock.user?.id
            ? sock.user.id.split(':')[0] + '@s.whatsapp.net'
            : null;
          botLidNum = sock.user?.lid
            ? sock.user.lid.split(':')[0]
            : null;
          console.log(`[WhatsApp] Conectado ✅ (JID: ${botJid}, LID: ${botLidNum})`);
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
            process.exit(1);
          } else {
            console.log('[WhatsApp] Reconectando para nuevo QR...');
            setTimeout(createSocket, 3000);
          }
        }
      });

      // Cambios de participantes — detecta cuándo AGREGAN a Juanito a un grupo.
      // Lo usamos para autorizar (si lo agregó boss/admin) o salir (default-deny).
      sock.ev.on('group-participants.update', async (update) => {
        try {
          const { id: groupId, participants = [], action, author } = update;
          if (action !== 'add' || !onGroupJoin) return;

          const meAdded = participants.some(
            (p) =>
              (botJid && phonesMatch(p, botJid)) ||
              (botLidNum && p?.startsWith(botLidNum))
          );
          if (!meAdded) return;

          let groupName = groupId;
          let allParticipants = [];
          try {
            const meta = await sock.groupMetadata(groupId);
            groupName = meta.subject || groupId;
            allParticipants = (meta.participants || [])
              .map((x) => x.id || x.jid || x.lid)
              .filter(Boolean);
          } catch (e) {
            console.error('[WhatsApp] No se pudo leer metadata del grupo nuevo:', e.message);
          }

          // OJO: pasamos `author` SIN resolver — roleOf reconoce a los admins por su
          // @lid (resolverlo a teléfono rompería el match de ADMIN_LID).
          await onGroupJoin({ groupId, groupName, author, participants: allParticipants });
        } catch (e) {
          console.error('[WhatsApp] Error en group-participants.update:', e.message);
        }
      });

      // Mensajes entrantes — ev.on es el API estable; ev.process tiene problemas
      // de buffering en Baileys v7 RC que hacen que messages.upsert nunca dispare.
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`[Debug] messages.upsert type=${type} count=${messages.length}`);
        if (type !== 'notify') return;

        for (const msg of messages) {
          const rawJid = msg.key.remoteJid;
          const isGroup = rawJid?.endsWith('@g.us');

          // Resolver LID → phone JID. Si no está en lidMap, buscar en sock.contacts.
          if (!isGroup && rawJid?.endsWith('@lid') && !lidMap.has(rawJid)) {
            const entry = Object.entries(sock?.contacts || {}).find(([, c]) => c.lid === rawJid);
            if (entry) {
              lidMap.set(rawJid, entry[0]);
              lidMap.set(entry[0], rawJid);
            }
          }
          const chatId = isGroup ? rawJid : (resolveJid(rawJid) || rawJid);
          const messageId = msg.key.id;
          const msgTypes = Object.keys(msg.message || {}).join(',');
          console.log(`[Debug] fromMe=${msg.key.fromMe} rawJid=${rawJid} chatId=${chatId} types=${msgTypes}`);

          if (msg.key.fromMe) continue;
          if (!msg.message) continue;

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            null;

          console.log(`[Debug] text="${text?.slice(0, 40)}" isGroup=${isGroup}`);
          if (!text) continue;

          const rawParticipant = msg.key.participant;
          const sender = isGroup
            ? (resolveJid(rawParticipant) || rawParticipant || chatId)
            : chatId;
          const senderName = msg.pushName || sender;

          // Detectar @mention real de WhatsApp.
          // WA usa el LID del bot (no el teléfono) en mentionedJid en cuentas multi-device.
          const mentionedJids =
            msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const isBotMentioned = mentionedJids.some(
            (jid) =>
              (botJid && phonesMatch(jid, botJid)) ||
              (botLidNum && jid?.startsWith(botLidNum))
          );

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

          await onMessage({ chatId, isGroup, text, sender, groupName, messageId, isBotMentioned, pushName: msg.pushName || null }).catch((e) =>
            console.error('[WhatsApp] Error en onMessage:', e.message)
          );
        }
      });
    }

    createSocket();
  });
}

// ─── Envío de mensajes ────────────────────────────────────────────────────────

// ¿Hay socket de WA activo? (para diagnósticos tipo /status)
export function isConnected() {
  return !!sock;
}

export async function sendMessage(to, text) {
  if (!sock) throw new Error('sendMessage: WhatsApp no conectado aún');
  const jid = toJid(to);
  await sock.sendMessage(jid, { text });
  console.log(`[WhatsApp] → ${to}`);
}

// ─── Salir de un grupo (add no autorizado) ────────────────────────────────────

export async function leaveGroup(groupId) {
  if (!sock) throw new Error('leaveGroup: WhatsApp no conectado aún');
  await sock.groupLeave(groupId);
  console.log(`[WhatsApp] Salí del grupo ${groupId}`);
}

// ─── Participantes de un grupo (para la heurística de autorización) ────────────

export async function getGroupParticipants(groupId) {
  if (!sock) return [];
  try {
    const meta = await sock.groupMetadata(groupId);
    return (meta.participants || []).map((p) => p.id || p.jid || p.lid).filter(Boolean);
  } catch (e) {
    console.error('[WhatsApp] Error obteniendo participantes:', e.message);
    return [];
  }
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
