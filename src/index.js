// src/index.js
// Entry point — conecta Baileys, wira handlers y arranca el scheduler.

import 'dotenv/config';
import { connect, sendMessage, isConnected, leaveGroup, listGroups } from './whatsapp/index.js';
import { handleBossMessage, handleGroupMessage, handlePublicDm, handleApprovalConsole } from './bot/index.js';
import { handleCommand, isReportCommand, wantsMetrics } from './bot/commands.js';
import { handleCloserOptin } from './calendly/optin.js';
import { startAllJobs } from './scheduler/index.js';
import { roleOf, isPrivileged } from './common/roles.js';
import { maskJid } from './common/utils.js';
import {
  listOptins,
  markIfNew,
  isCalendlyPaused,
  setCalendlyPaused,
  setCloserPaused,
  isDmApprovalOn,
  setDmApproval,
  authorizeGroup,
  deauthorizeGroup,
  isGroupAuthorized,
  listAuthorizedGroups,
  setGroupPersona,
  getGroupPersona,
  deleteGroupPersona,
  listGroupPersonas,
  listScheduledMessages,
  cancelScheduledMessage,
  listDraftsForDate,
  getDraft,
  approveDraft,
  discardDraft,
  setGroupApproval,
  listApprovalGroups,
  listPendingReplies,
  getPendingReply,
  approvePendingReply,
  discardPendingReply,
  listPendingTasks,
  getTask,
  setTaskStatus,
  listBusinessContext,
  listProposedBusinessFacts,
  getBusinessFact,
  setBusinessFactStatus,
} from './db/index.js';
import { resolveCloserByPushName } from './calendly/closers.js';
import { getHealth } from './calendly/health.js';
import { enforceGroup, reevaluateGroup, onSelfRemoved, sweepGroups } from './bot/group-guard.js';
import { buildSheetsReport } from './scheduler/sheets-report.js';
import { buildMetricsReport } from './scheduler/sheets-metrics.js';

// ─── Add a un grupo: autorizar (boss/admin) o salir (default-deny) ────────────
// Si lo agrega directamente un boss/admin, autoriza sin más. En cualquier otro
// caso delega en enforceGroup (revisa participantes + respeta GROUP_AUTOLEAVE).
async function onGroupJoin({ groupId, groupName, author, participants }) {
  console.log(`[Main] group-participants add → "${groupName}" (${groupId}) por ${author}`);
  const adderRole = roleOf(author);
  if (isPrivileged(adderRole)) {
    authorizeGroup({ groupId, groupName, authorizedBy: author });
    console.log(`[Main] Grupo autorizado: "${groupName}" (agregado por ${adderRole})`);
    return;
  }
  await enforceGroup(groupId, groupName);
}

// ─── Sale un participante del grupo (autorización simétrica) ───────────────────
// Si me sacaron a mí → limpiar la DB. Si se fue otro → re-evaluar: si ya no queda
// ningún jefe/admin, se revoca la autorización y (en modo on) Juanito se sale.
async function onGroupChange({ groupId, meRemoved }) {
  if (meRemoved) {
    onSelfRemoved(groupId);
    return;
  }
  await reevaluateGroup(groupId, groupId).catch((e) =>
    console.error('[Main] reevaluateGroup:', e.message)
  );
}

// ─── /grupo on|off — control manual de autorización (admin/boss, dentro del grupo) ─
// Devuelve true si manejó el mensaje como comando (para cortar el flujo normal).
async function handleGroupCommand({ chatId, groupName, text, sender, messageId }) {
  const trimmed = (text || '').trim().toLowerCase();
  if (trimmed !== '/grupo' && !trimmed.startsWith('/grupo ')) return false;
  if (!markIfNew(messageId)) return true;

  const role = roleOf(sender);
  if (!isPrivileged(role)) {
    await sendMessage(chatId, 'Ese comando es solo para el equipo 🙂').catch(() => {});
    return true;
  }

  const action = trimmed.split(/\s+/)[1] || 'status';
  if (action === 'on') {
    authorizeGroup({ groupId: chatId, groupName, authorizedBy: sender });
    await sendMessage(chatId, 'Listo, quedé habilitado para responder en este grupo ✅').catch(() => {});
  } else if (action === 'off') {
    deauthorizeGroup(chatId);
    await sendMessage(chatId, 'Entendido, me retiro de este grupo 👋').catch(() => {});
    await leaveGroup(chatId).catch((e) => console.error('[Main] leaveGroup:', e.message));
  } else {
    const on = isGroupAuthorized(chatId);
    await sendMessage(chatId, `Estado en este grupo: ${on ? 'habilitado ✅' : 'no autorizado ⛔'}`).catch(() => {});
  }
  return true;
}

// ─── /reportes [leads|metricas] dentro de un grupo (jefe/admin, grupo autorizado) ──
// PUBLICA el reporte EN el grupo donde se pide (on-demand). No requiere mención.
// Gateado: solo jefe/admin y solo en grupos autorizados (default-deny). Devuelve true
// si manejó el mensaje. ⚠️ "metricas" expone las métricas de desempeño a todo el grupo.
async function handleGroupReportCommand({ chatId, text, sender, messageId }) {
  const cmd = (text || '').trim().toLowerCase();
  if (!isReportCommand(cmd)) return false;
  if (!markIfNew(messageId)) return true;

  if (!isPrivileged(roleOf(sender))) {
    await sendMessage(chatId, 'Ese comando es solo para el equipo 🙂').catch(() => {});
    return true;
  }
  if (!isGroupAuthorized(chatId)) return true; // grupo no autorizado → ignorar en silencio

  try {
    const { message } = wantsMetrics(cmd) ? await buildMetricsReport() : await buildSheetsReport();
    await sendMessage(chatId, message).catch((e) => console.error('[Main] reporte en grupo:', e.message));
  } catch (e) {
    await sendMessage(chatId, `No pude generar el reporte ahora: ${e.message}`).catch(() => {});
  }
  return true;
}

async function onMessage({ chatId, isGroup, text, sender, groupName, messageId, isBotMentioned, pushName, rawMsg }) {
  if (!text) return;

  if (!isGroup) {
    // Rol del remitente (admin = equipo, boss = jefe sandboxed, unknown = otro).
    const role = roleOf(sender);

    // Comandos deterministas (sin Claude): /whoami, /status. Se atienden antes del
    // ruteo para que /whoami funcione incluso para un admin nuevo aún no configurado.
    const cmdReply = await handleCommand(
      { text, sender, role },
      {
        listOptins,
        isConnected,
        getHealth,
        isCalendlyPaused,
        setCalendlyPaused,
        setCloserPaused,
        resolveCloserByPushName,
        // /grupos — visibilidad y control remoto de los grupos de Juanito
        listGroups,
        listAuthorizedGroups,
        authorizeGroup,
        deauthorizeGroup,
        leaveGroup,
        // /reporte — preview on-demand del reporte de leads del Sheet
        buildSheetsReport,
        // /metricas — preview on-demand del reporte de métricas de desempeño
        buildMetricsReport,
        // /persona — personalidad por grupo
        setGroupPersona,
        getGroupPersona,
        deleteGroupPersona,
        listGroupPersonas,
        // /programados — mensajes recurrentes a grupos
        listScheduledMessages,
        cancelScheduledMessage,
        // /aprobaciones — estado/override del flujo de aprobación de generados
        listDraftsForDate,
        getDraft,
        approveDraft,
        discardDraft,
        // /confirmaciones + /aprobar_grupo + /respuestas — confirmaciones de envío
        isGroupAuthorized,
        setGroupApproval,
        listApprovalGroups,
        isDmApprovalOn,
        setDmApproval,
        listPendingReplies,
        getPendingReply,
        approvePendingReply,
        discardPendingReply,
        // /tareas — órdenes del jefe capturadas (capture_task); sendMessage avisa al solicitante
        listPendingTasks,
        getTask,
        setTaskStatus,
        sendMessage,
        // /negocio — gestión del contexto del negocio (Fase 2)
        listBusinessContext,
        listProposedBusinessFacts,
        getBusinessFact,
        setBusinessFactStatus,
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
        console.log(`[Main] DM de LID del ${role}: ${maskJid(sender)}`);
      }
      await handleBossMessage({ from: sender, text, messageId, role }).catch((e) =>
        console.error('[Main] handleBossMessage:', e.message)
      );
      return;
    }
    // Ignorar remitentes que NO son una persona (status/broadcast/newsletter): no se
    // les responde nunca (no son interlocutores reales).
    if (!sender?.endsWith('@s.whatsapp.net') && !sender?.endsWith('@lid')) {
      return;
    }

    // DM de un closer → registrar su opt-in (si es un closer conocido). Devuelve true
    // si lo manejó. Pasa pushName para resolver closers cuando el LID no se mapea a teléfono.
    const handled = await handleCloserOptin({ from: sender, pushName, messageId }).catch((e) => {
      console.error('[Main] handleCloserOptin:', e.message);
      return false;
    });
    if (handled) return;

    // Cualquier otro DM (desconocido) → asistente general aislado. SIEMPRE es una
    // respuesta a un mensaje entrante: Juanito nunca escribe primero (regla anti-ban).
    await handlePublicDm({ from: sender, text, messageId, pushName, rawMsg }).catch((e) =>
      console.error('[Main] handlePublicDm:', e.message)
    );
    return;
  }

  // Grupo: el mensaje ya fue guardado pasivamente por whatsapp/index.js.
  // Primero el comando admin /grupo (no requiere mención); si lo manejó, cortamos.
  if (await handleGroupCommand({ chatId, groupName, text, sender, messageId })) return;

  // /reportes [leads|metricas] en el grupo (jefe/admin, grupo autorizado) → publica acá.
  if (await handleGroupReportCommand({ chatId, text, sender, messageId })) return;

  // Anti-secuestro robusto: evalúa autorización en CADA mensaje de grupo (cubre los
  // adds que el evento `group-participants.update` no capturó, p.ej. si agregaron al
  // bot mientras reiniciaba). Si aplica auto-leave, salimos sin procesar.
  if ((await enforceGroup(chatId, groupName)) === 'left') return;

  // Consola de aprobaciones: si este es el grupo APPROVALS_GROUP y quien escribe es jefe/admin,
  // se interpreta como decisión sobre lo pendiente (sin mención). Si lo manejó, cortamos.
  if (await handleApprovalConsole({ chatId, text, sender, messageId, rawMsg })) return;

  // pushName viaja hasta el aviso de rate-limit (saluda por nombre al avisar).
  // rawMsg permite responder CITANDO el mensaje que mencionó al bot.
  await handleGroupMessage({ chatId, groupName, text, sender, isGroup, messageId, isBotMentioned, pushName, rawMsg }).catch((e) =>
    console.error('[Main] handleGroupMessage:', e.message)
  );
}

async function bootstrap() {
  await connect({ onMessage, onGroupJoin, onGroupChange });
  await sweepGroups(); // anti-secuestro: clasifica/limpia los grupos actuales al arrancar
  startAllJobs();
  console.log('\n🚀 Juanito corriendo — escuchando WhatsApp\n');
}

// Una promesa sin catch NO deja el proceso en estado indefinido → se loguea y se sigue
// (el bot tiene muchos .catch(() => {}) defensivos; matar el proceso por una rejection suelta
// sería demasiado agresivo).
process.on('unhandledRejection', (reason) => console.error('[Fatal] Unhandled rejection:', reason));
// Una excepción NO capturada sí deja el proceso en estado indefinido (recomendación de Node):
// logueamos y SALIMOS para que entrypoint.sh reinicie con su backoff exponencial, en vez de
// quedar como proceso zombie (vivo pero roto, sin reconectar). Ver historia del softban en CLAUDE.md.
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err);
  process.exit(1);
});

bootstrap().catch((err) => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
