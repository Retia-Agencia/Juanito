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
import { createSendQueue } from './send-queue.js';
import { createTtlCache } from './subject-cache.js';

const SESSION_PATH = process.env.WA_SESSION_PATH || './data/wa-session';
const QR_PATH = process.env.WA_QR_PATH || './data/wa-qr.png';

// Cola global de envío — ANTI-BAN (§18.D P1-a). Serializa TODOS los envíos del
// socket con gap + jitter para que una ráfaga de menciones (grupo de 300) no se
// traduzca en una ráfaga de sends desde IP de datacenter.
const sendQueue = createSendQueue({
  minGapMs: Number(process.env.WA_SEND_MIN_GAP_MS || 1000),
  jitterMs: Number(process.env.WA_SEND_JITTER_MS || 500),
  maxQueue: Number(process.env.WA_SEND_QUEUE_MAX || 200),
});

// Cache del subject de cada grupo (§18.D P1-b) — evita un groupMetadata por mensaje.
const subjectCache = createTtlCache({ ttlMs: 10 * 60 * 1000, negativeTtlMs: 60 * 1000 });

async function getGroupSubject(chatId) {
  const cached = subjectCache.get(chatId);
  if (cached !== undefined) return cached;
  try {
    const meta = await sock.groupMetadata(chatId);
    const subject = meta.subject || chatId;
    subjectCache.set(chatId, subject);
    return subject;
  } catch {
    // Fallback con TTL corto: no martillar groupMetadata si el fetch falla seguido.
    subjectCache.set(chatId, chatId, { negative: true });
    return chatId;
  }
}

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

export async function connect({ onMessage, onGroupJoin, onGroupChange }) {
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

      // Cambios de participantes — base de la autorización simétrica de grupos:
      //   - AGREGAN al bot       → autorizar (si lo agregó/hay boss/admin) o salir.
      //   - sale un participante → re-evaluar (si se fue el jefe/admin → revocar+salir).
      //   - SACAN al bot         → limpiar la autorización en DB.
      // Cambios de metadata del grupo (subject, etc.) → refrescar el cache directo.
      sock.ev.on('groups.update', (updates) => {
        for (const u of updates || []) {
          if (u?.id && u.subject) subjectCache.set(u.id, u.subject);
        }
      });

      sock.ev.on('group-participants.update', async (update) => {
        try {
          const { id: groupId, participants = [], action, author } = update;
          subjectCache.delete(groupId);
          // Los participantes pueden venir como strings (JID/LID) o como objetos
          // ({ id, jid, lid }). Normalizamos a string antes de comparar.
          const pid = (p) => (typeof p === 'string' ? p : p?.id || p?.jid || p?.lid || '');
          const meInvolved = participants.some((raw) => {
            const p = pid(raw);
            return (botJid && phonesMatch(p, botJid)) || (botLidNum && p.startsWith(botLidNum));
          });

          if (action === 'add' && meInvolved) {
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
            if (onGroupJoin) await onGroupJoin({ groupId, groupName, author, participants: allParticipants });
            return;
          }

          if ((action === 'remove' || action === 'leave') && onGroupChange) {
            // Si me sacaron a mí → solo limpiar; si se fue otro → re-evaluar.
            await onGroupChange({ groupId, meRemoved: meInvolved });
          }
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

          const groupName = isGroup ? await getGroupSubject(chatId) : chatId;

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
  // Todos los envíos pasan por la cola global (gap + jitter) — anti-ban §18.D P1-a.
  await sendQueue.enqueue(() => sock.sendMessage(jid, { text }));
  console.log(`[WhatsApp] → ${to} (cola: ${sendQueue.size()} pendientes)`);
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

// `sinceHours` (opcional) filtra por ventana de tiempo real — el "resumen de 4h"
// debe cubrir 4 horas, no los últimos N mensajes (§18.D P2). `limit` queda como
// tope duro. La comparación es en UTC: created_at es CURRENT_TIMESTAMP de SQLite
// (UTC) y datetime('now') también — no usar strings de hora local (Alpine sin tzdata).
export async function getRecentMessages(chatId, limit = 30, sinceHours = null) {
  const hours = Number(sinceHours);
  const windowClause =
    sinceHours != null && Number.isFinite(hours) && hours > 0
      ? `AND created_at >= datetime('now', '-' || ? || ' hours')`
      : '';
  const params = windowClause ? [chatId, hours, limit] : [chatId, limit];
  const rows = db
    .prepare(
      `SELECT content, created_at AS timestamp
       FROM messages
       WHERE chat_id = ? AND source = 'group' ${windowClause}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...params)
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
