// src/bot/commands.js
// Comandos deterministas (sin Claude, sin gastar tokens) para el equipo.
// Se interceptan en onMessage ANTES del ruteo por rol.
//
// No importamos db/whatsapp al tope a propósito: así este módulo es testeable
// sin las deps nativas (better-sqlite3). Las deps de /status se inyectan.
// (recurring-logic es PURO — seguro de importar.)

import { csvToDayLabels, zonedNowParts } from '../scheduler/recurring-logic.js';

// Reconoce el comando unificado de reportes y sus alias (/reportes, /reporte, /metricas).
// `cmd` es el texto en minúsculas y sin espacios al borde. Exportado para que el router
// de grupos use exactamente el mismo criterio (sin duplicar la lógica de parseo).
export function isReportCommand(cmd) {
  return (
    cmd === '/reporte' ||
    cmd === '/reportes' ||
    cmd === '/metricas' ||
    cmd === '/métricas' ||
    cmd.startsWith('/reporte ') ||
    cmd.startsWith('/reportes ') ||
    cmd.startsWith('/metricas ') ||
    cmd.startsWith('/métricas ')
  );
}

// ¿El comando de reporte pide MÉTRICAS? (/metricas, o /reportes metricas)
export function wantsMetrics(cmd) {
  if (cmd.startsWith('/metric') || cmd.startsWith('/métric')) return true;
  const arg = (cmd.split(/\s+/)[1] || '').trim();
  return arg.startsWith('metric') || arg.startsWith('métric');
}

// Intenta manejar `text` como comando.
// Devuelve un string de respuesta si lo manejó, o null si no aplica (para que
// el flujo siga su curso normal hacia Claude / opt-in).
export async function handleCommand({ text, sender, role }, deps = {}) {
  const cmd = (text || '').trim().toLowerCase();

  // /whoami — disponible para cualquiera: devuelve tu ID y rol. Sirve para que
  // un admin nuevo capture su LID sin tener que leer los logs del VPS.
  if (cmd === '/whoami' || cmd === '/id') {
    return `Tu ID: ${sender}\nRol: ${role}`;
  }

  // /help — disponible para cualquiera, pero el contenido es POR ROL: el admin ve
  // la lista de comandos; el jefe ve que no necesita comandos (habla normal); un
  // desconocido ve un saludo mínimo. Determinista, sin tokens.
  if (cmd === '/help' || cmd === '/ayuda' || cmd === '/comandos') {
    return buildHelp(role);
  }

  // /status — solo admins.
  if (cmd === '/status') {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return buildStatus(deps);
  }

  // /calendly [on|off] [closer] — botón de pánico de los pushes. SOLO admins.
  // El jefe (boss) recibe la misma deflexión cálida que /status; un unknown ni llega.
  if (cmd === '/calendly' || cmd.startsWith('/calendly ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleCalendly(text, deps);
  }

  // /grupos [on|off] [n|nombre] — visibilidad y control remoto de los grupos de
  // Juanito (cruza listGroups() con la tabla authorized_groups). SOLO admins.
  if (cmd === '/grupos' || cmd.startsWith('/grupos ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleGrupos({ text, sender }, deps);
  }

  // /reportes [leads|metricas] — preview on-demand del reporte (§18.B/N). Sin parámetro
  // o "leads" → reporte de leads; "metricas" → métricas de desempeño. `/metricas` y
  // `/reporte` quedan como alias. SOLO admins en DM (el preview no publica nada).
  if (isReportCommand(cmd)) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return wantsMetrics(cmd) ? handleMetricas(deps) : handleReporte(deps);
  }

  // /persona — personalidad específica por grupo (se inyecta en el prompt de ese
  // grupo). SOLO admins: la persona moldea cómo responde el bot, mismo criterio
  // que save_memory.
  if (cmd === '/persona' || cmd.startsWith('/persona ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handlePersona({ text, sender }, deps);
  }

  // /programados — ver/cancelar los mensajes recurrentes a grupos. SOLO admins.
  // (Crearlos es por lenguaje natural en el DM: tool schedule_group_message.)
  if (cmd === '/programados' || cmd.startsWith('/programados ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleProgramados(text, deps);
  }

  // /aprobaciones — visibilidad y control del flujo de aprobación de los mensajes
  // generados (aprueba el jefe por DM; los admins ven el estado y tienen override).
  if (cmd === '/aprobaciones' || cmd.startsWith('/aprobaciones ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleAprobaciones(text, deps);
  }

  // /confirmaciones — control unificado de las confirmaciones (visto bueno del jefe) antes
  // de que Juanito envíe: por grupo (mención) y global para DMs de desconocidos. SOLO admins.
  if (cmd === '/confirmaciones' || cmd.startsWith('/confirmaciones ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleConfirmaciones({ text }, deps);
  }

  // /aprobar_grupo <grupo> on|off — ALIAS retro-compatible de `/confirmaciones grupo …`.
  // SOLO admins (cambia el comportamiento del bot).
  if (cmd === '/aprobar_grupo' || cmd.startsWith('/aprobar_grupo ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleAprobarGrupo({ text }, deps);
  }

  // /respuestas — respuestas de grupo pendientes de aprobación (el jefe decide por DM;
  // los admins ven el estado y tienen override/rechazo). SOLO admins.
  if (cmd === '/respuestas' || cmd.startsWith('/respuestas ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleRespuestas(text, deps);
  }

  // /tareas — órdenes del jefe capturadas (tool capture_task) que el equipo debe ejecutar.
  // Al marcarlas hechas se le avisa al solicitante. SOLO admins.
  if (cmd === '/tareas' || cmd.startsWith('/tareas ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleTareas({ text, sender }, deps);
  }

  // /negocio — gestión del contexto del negocio (Fase 2). list activos · pendientes (propuestos
  // de chats) · ok/no <id> (confirma/descarta propuesto) · olvida <id> (archiva activo). SOLO admins.
  if (cmd === '/negocio' || cmd.startsWith('/negocio ')) {
    if (role !== 'admin') return 'Ese comando es solo para el equipo técnico 🙂';
    return handleNegocio({ text, sender }, deps);
  }

  return null;
}

// /aprobaciones                → borradores de HOY con su estado
// /aprobaciones ver <id>       → texto completo de un borrador
// /aprobaciones aprobar <id>   → override de admin (publica a la hora / de inmediato si ya pasó)
// /aprobaciones rechazar <id>  → descarta el borrador (pendiente o aprobado): no se publica hoy
function handleAprobaciones(text, deps = {}) {
  const { listDraftsForDate, getDraft, approveDraft, discardDraft } = deps;
  const parts = (text || '').trim().split(/\s+/);
  const action = (parts[1] || 'list').toLowerCase();
  const STATUS = { pending: '⏳ pendiente', approved: '✅ aprobado (sale a la hora)', published: '📤 publicado', discarded: '🗑️ descartado' };

  if (action === 'ver' || action === 'aprobar' || action === 'rechazar' || action === 'descartar') {
    const id = Number(parts[2]);
    if (!Number.isInteger(id)) return `Uso: /aprobaciones ${action} <id>`;
    const draft = getDraft ? getDraft(id) : null;
    if (!draft) return `No encontré ningún borrador con id ${id}.`;

    if (action === 'ver') {
      return `Borrador #${id} — ${STATUS[draft.status] || draft.status} (publica: ${draft.publish_date})\n\n${draft.draft}`;
    }
    if (action === 'rechazar' || action === 'descartar') {
      const changes = discardDraft ? discardDraft(id) : 0;
      return changes
        ? `Borrador #${id} descartado 🗑️ — no se publicará hoy. Volverá a generarse el próximo día programado.`
        : `El borrador #${id} no se puede descartar (estado: ${draft.status}).`;
    }
    const changes = approveDraft ? approveDraft(id) : 0;
    return changes
      ? `Borrador #${id} aprobado ✅ (override admin) — se publica a la hora programada o de inmediato si ya pasó.`
      : `El borrador #${id} no está pendiente (estado: ${draft.status}).`;
  }

  let rows = [];
  try {
    rows = listDraftsForDate ? listDraftsForDate(zonedNowParts().date) : [];
  } catch {
    /* DB puede no estar lista */
  }
  if (!rows.length) return '📝 No hay borradores generados hoy (se generan ~1h antes de su hora de publicación).';
  const lines = [`📝 Borradores de hoy (${rows.length})`, ''];
  for (const r of rows) {
    lines.push(`#${r.id} → ${r.group_name || ''} a las ${r.time_hm} — ${STATUS[r.status] || r.status}`);
    lines.push(`    "${truncate(r.draft, 90)}"`);
  }
  lines.push('', 'Acciones: /aprobaciones ver <id> · aprobar <id> · rechazar <id> (override; normalmente el jefe aprueba/rechaza por DM)');
  return lines.join('\n');
}

// /confirmaciones                       → estado: DM (ON/OFF) + grupos con confirmación ON
// /confirmaciones dm on|off             → activa/desactiva la confirmación GLOBAL de DMs
// /confirmaciones grupo <n|nombre> on   → exige tu visto bueno en ese grupo
// /confirmaciones grupo <n|nombre> off  → ese grupo vuelve a responder directo
async function handleConfirmaciones({ text }, deps = {}) {
  const { listApprovalGroups, isDmApprovalOn, setDmApproval } = deps;
  const arg = (text || '').trim().slice('/confirmaciones'.length).trim();
  const ttl = Number(process.env.REPLY_APPROVAL_TTL_MIN || 30);

  // Sin args → estado.
  if (!arg) {
    let dmOn = false;
    try {
      dmOn = isDmApprovalOn ? isDmApprovalOn() : false;
    } catch {
      /* DB puede no estar lista */
    }
    let rows = [];
    try {
      rows = listApprovalGroups ? listApprovalGroups() : [];
    } catch {
      /* DB puede no estar lista */
    }
    const lines = [
      '🛂 Confirmaciones (visto bueno del jefe antes de enviar)',
      `• DM (desconocidos): ${dmOn ? 'ON ✅ — cada DM te llega para aprobar' : 'OFF — Juanito responde directo'}`,
      '• Grupos con confirmación ON:',
    ];
    if (rows.length) for (const r of rows) lines.push(`   – ${r.group_name || r.group_id}`);
    else lines.push('   (ninguno — Juanito responde directo en todos los grupos)');
    lines.push(
      '',
      'Uso: /confirmaciones dm on|off · /confirmaciones grupo <n|nombre> on|off',
      'Las propuestas te llegan por DM y caducan a los ' + ttl + ' min sin decisión.'
    );
    return lines.join('\n');
  }

  const parts = arg.split(/\s+/);
  const sub = parts[0].toLowerCase();

  // /confirmaciones dm on|off
  if (sub === 'dm') {
    const onoff = (parts[1] || '').toLowerCase();
    if (onoff !== 'on' && onoff !== 'off') return 'Uso: /confirmaciones dm on · /confirmaciones dm off';
    if (setDmApproval) setDmApproval(onoff === 'on');
    return onoff === 'on'
      ? `🛂 Confirmación de DMs ACTIVADA. Cada DM de un desconocido te llega por DM para aprobar/corregir/descartar (caduca a los ${ttl} min). Juanito no responde sin tu visto bueno.`
      : '🛂 Confirmación de DMs DESACTIVADA. Juanito vuelve a responder los DMs directo.';
  }

  // /confirmaciones grupo <n|nombre> on|off
  if (sub === 'grupo') {
    const rest = parts.slice(1);
    const onoff = (rest[rest.length - 1] || '').toLowerCase();
    if (onoff !== 'on' && onoff !== 'off') return 'Uso: /confirmaciones grupo <n|nombre> on|off';
    const targetArg = rest.slice(0, -1).join(' ');
    if (!targetArg) return 'Uso: /confirmaciones grupo <n|nombre> on|off';
    return applyGroupApproval(targetArg, onoff, deps);
  }

  return 'Uso: /confirmaciones · /confirmaciones dm on|off · /confirmaciones grupo <n|nombre> on|off';
}

// /aprobar_grupo                → ALIAS: grupos con confirmación de respuestas activada
// /aprobar_grupo <n|nombre> on  → activa: Juanito no responde ahí sin el visto bueno del jefe
// /aprobar_grupo <n|nombre> off → desactiva: vuelve a responder directo
async function handleAprobarGrupo({ text }, deps = {}) {
  const { listApprovalGroups } = deps;
  const arg = (text || '').trim().slice('/aprobar_grupo'.length).trim();

  if (!arg) {
    let rows = [];
    try {
      rows = listApprovalGroups ? listApprovalGroups() : [];
    } catch {
      /* DB puede no estar lista */
    }
    const lines = ['🛂 Grupos con aprobación de respuestas (ON)'];
    if (rows.length) for (const r of rows) lines.push(`• ${r.group_name || r.group_id}`);
    else lines.push('(ninguno — Juanito responde directo en todos los grupos)');
    lines.push('', 'Uso: /aprobar_grupo <n|nombre> on|off (alias de /confirmaciones grupo …)');
    return lines.join('\n');
  }

  const parts = arg.split(/\s+/);
  const onoff = parts[parts.length - 1].toLowerCase();
  if (onoff !== 'on' && onoff !== 'off') return 'Uso: /aprobar_grupo <n|nombre> on · /aprobar_grupo <n|nombre> off';
  const targetArg = parts.slice(0, -1).join(' ');
  if (!targetArg) return 'Uso: /aprobar_grupo <n|nombre> on|off';
  return applyGroupApproval(targetArg, onoff, deps);
}

// Lógica compartida por /confirmaciones grupo y el alias /aprobar_grupo: resuelve el grupo
// por número o nombre, valida que esté autorizado y activa/desactiva su require_approval.
async function applyGroupApproval(targetArg, onoff, deps = {}) {
  const { listGroups, setGroupApproval, isGroupAuthorized } = deps;
  const ttl = Number(process.env.REPLY_APPROVAL_TTL_MIN || 30);

  let groups;
  try {
    groups = listGroups ? await listGroups() : [];
  } catch {
    return 'No pude listar los grupos ahora (¿WhatsApp conectado?).';
  }
  groups = [...groups].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));
  const target = resolveGroupTarget(targetArg, groups);
  if (!target) return `No encontré "${targetArg}". Usa /grupos para ver la lista y el número.`;

  if (isGroupAuthorized && !isGroupAuthorized(target.id)) {
    return `"${target.name || target.id}" no está autorizado todavía. Agrégalo al grupo (queda auto-autorizado) o actívalo con /grupos.`;
  }
  const changes = setGroupApproval ? setGroupApproval(target.id, onoff === 'on') : 0;
  if (!changes) return `No pude cambiar la confirmación de "${target.name || target.id}".`;
  return onoff === 'on'
    ? `🛂 Confirmación ACTIVADA en "${target.name || target.id}". Juanito ya no responde ahí sin tu visto bueno: las propuestas te llegan por DM y caducan a los ${ttl} min.`
    : `🛂 Confirmación DESACTIVADA en "${target.name || target.id}". Juanito vuelve a responder directo.`;
}

// /respuestas              → respuestas de grupo pendientes con su estado
// /respuestas ver <id>     → texto completo + contexto
// /respuestas aprobar <id> → override admin (sale al grupo en el próximo minuto)
// /respuestas rechazar <id>→ descarta la respuesta
function handleRespuestas(text, deps = {}) {
  const { listPendingReplies, getPendingReply, approvePendingReply, discardPendingReply } = deps;
  const parts = (text || '').trim().split(/\s+/);
  const action = (parts[1] || 'list').toLowerCase();

  if (action === 'ver' || action === 'aprobar' || action === 'rechazar' || action === 'descartar') {
    const id = Number(parts[2]);
    if (!Number.isInteger(id)) return `Uso: /respuestas ${action} <id>`;
    const r = getPendingReply ? getPendingReply(id) : null;
    if (!r) return `No encontré ninguna respuesta pendiente con id ${id}.`;

    if (action === 'ver') {
      return `Respuesta #${id} — ${r.status} en "${r.group_name || r.group_id}"\n${r.trigger_sender || '?'} dijo: "${truncate(r.trigger_text || '', 120)}"\n\n${r.draft}`;
    }
    if (action === 'aprobar') {
      const changes = approvePendingReply ? approvePendingReply(id) : 0;
      return changes
        ? `Respuesta #${id} aprobada ✅ — sale al grupo en el próximo minuto.`
        : `La respuesta #${id} no está pendiente (estado: ${r.status}).`;
    }
    const changes = discardPendingReply ? discardPendingReply(id) : 0;
    return changes
      ? `Respuesta #${id} descartada 🗑️ — Juanito no responderá a eso.`
      : `La respuesta #${id} no se puede descartar (estado: ${r.status}).`;
  }

  let rows = [];
  try {
    rows = listPendingReplies ? listPendingReplies() : [];
  } catch {
    /* DB puede no estar lista */
  }
  if (!rows.length) return '📭 No hay respuestas de grupo pendientes de aprobación.';
  const lines = [`📨 Respuestas pendientes (${rows.length})`, ''];
  for (const r of rows) {
    lines.push(`#${r.id} → ${r.group_name || r.group_id} (${r.trigger_sender || '?'})`);
    lines.push(`    "${truncate(r.draft, 90)}"`);
  }
  lines.push('', 'Acciones: /respuestas ver <id> · aprobar <id> · rechazar <id> (normalmente el jefe decide por DM)');
  return lines.join('\n');
}

// /tareas                  → órdenes del jefe pendientes (capturadas con capture_task)
// /tareas ver <id>         → detalle completo (request + contexto + quién la pidió)
// /tareas hecha <id>       → la cierra y avisa al solicitante ("✅ Listo lo que pediste…")
// /tareas descartar <id>   → la descarta (no se avisa a nadie)
async function handleTareas({ text, sender }, deps = {}) {
  const { listPendingTasks, getTask, setTaskStatus, sendMessage } = deps;
  const parts = (text || '').trim().split(/\s+/);
  const action = (parts[1] || 'list').toLowerCase();

  if (action === 'ver' || action === 'hecha' || action === 'descartar') {
    const id = Number(parts[2]);
    if (!Number.isInteger(id)) return `Uso: /tareas ${action} <id>`;
    const t = getTask ? getTask(id) : null;
    if (!t) return `No encontré ninguna tarea con id ${id}.`;

    if (action === 'ver') {
      return (
        `Tarea #${id} — ${t.status}\n` +
        `Pidió: ${t.created_by || '?'}\n\n${t.request}` +
        (t.detail ? `\n\nContexto: ${t.detail}` : '')
      );
    }

    if (action === 'hecha') {
      const changes = setTaskStatus ? setTaskStatus(id, 'done', sender) : 0;
      if (!changes) return `La tarea #${id} ya no está pendiente (estado: ${t.status}).`;
      // Avisar al solicitante que su orden quedó hecha (best-effort, no rompe el comando).
      if (sendMessage && t.created_by) {
        await sendMessage(t.created_by, `✅ Listo lo que pediste: ${t.request}`).catch(() => {});
      }
      return `Tarea #${id} marcada como hecha ✅ — le avisé al jefe.`;
    }

    const changes = setTaskStatus ? setTaskStatus(id, 'dismissed', sender) : 0;
    return changes
      ? `Tarea #${id} descartada 🗑️`
      : `La tarea #${id} ya no está pendiente (estado: ${t.status}).`;
  }

  let rows = [];
  try {
    rows = listPendingTasks ? listPendingTasks() : [];
  } catch {
    /* DB puede no estar lista */
  }
  if (!rows.length) return '📭 No hay tareas pendientes del jefe.';
  const lines = [`📌 Tareas pendientes (${rows.length})`, ''];
  for (const t of rows) {
    lines.push(`#${t.id} → ${truncate(t.request, 90)}`);
  }
  lines.push('', 'Acciones: /tareas ver <id> · hecha <id> · descartar <id>');
  return lines.join('\n');
}

// /negocio                 → contexto del negocio ACTIVO (lo que Juanito sabe), por categoría
// /negocio pendientes      → hechos PROPUESTOS (extraídos de chats, Fase 2B) esperando confirmación
// /negocio ok <id>         → confirma un propuesto → pasa a activo (Juanito lo usa)
// /negocio no <id>         → descarta un propuesto (no se activa)
// /negocio olvida <id>     → archiva un hecho activo (Juanito deja de usarlo)
function handleNegocio({ text }, deps = {}) {
  const { listBusinessContext, listProposedBusinessFacts, getBusinessFact, setBusinessFactStatus } = deps;
  const parts = (text || '').trim().split(/\s+/);
  const action = (parts[1] || 'list').toLowerCase();

  if (action === 'ok' || action === 'no' || action === 'olvida') {
    const id = Number(parts[2]);
    if (!Number.isInteger(id)) return `Uso: /negocio ${action} <id>`;
    const f = getBusinessFact ? getBusinessFact(id) : null;
    if (!f) return `No encontré ningún hecho con id ${id}.`;

    // ok: proposed→active · no: proposed→archived · olvida: active→archived
    const target = action === 'ok' ? 'active' : 'archived';
    const changes = setBusinessFactStatus ? setBusinessFactStatus(id, target) : 0;
    if (!changes) return `El hecho #${id} ya estaba en ese estado (${f.status}).`;
    if (action === 'ok') return `Hecho #${id} confirmado ✅ — Juanito ya lo usa.`;
    if (action === 'no') return `Hecho #${id} descartado 🗑️`;
    return `Hecho #${id} archivado — Juanito deja de usarlo.`;
  }

  if (action === 'pendientes') {
    let rows = [];
    try { rows = listProposedBusinessFacts ? listProposedBusinessFacts() : []; } catch { /* DB */ }
    if (!rows.length) return '📭 No hay hechos del negocio propuestos por confirmar.';
    const lines = [`🧠 Propuestos del negocio (${rows.length})`, ''];
    for (const f of rows) lines.push(`#${f.id} [${f.topic}] ${truncate(f.fact, 90)}`);
    lines.push('', 'Acciones: /negocio ok <id> (confirmar) · no <id> (descartar)');
    return lines.join('\n');
  }

  let rows = [];
  try { rows = listBusinessContext ? listBusinessContext() : []; } catch { /* DB */ }
  if (!rows.length) return '📭 Aún no sé nada del negocio. El jefe me lo puede ir contando, o reviso /negocio pendientes.';
  const lines = [`🧠 Lo que sé del negocio (${rows.length})`, ''];
  let lastTopic = null;
  for (const f of rows) {
    if (f.topic !== lastTopic) { lines.push(`*${f.topic}*`); lastTopic = f.topic; }
    lines.push(`  #${f.id} ${truncate(f.fact, 85)}`);
  }
  lines.push('', 'Acciones: /negocio pendientes · ok/no <id> · olvida <id>');
  return lines.join('\n');
}

// /persona                        → lista las personas configuradas
// /persona <n|nombre>             → muestra la persona de ese grupo
// /persona <n|nombre> | <texto>   → setea la persona (el texto queda EXACTO)
// /persona <n|nombre> off         → la elimina (vuelve al prompt genérico)
async function handlePersona({ text, sender }, deps = {}) {
  const { listGroups, setGroupPersona, getGroupPersona, deleteGroupPersona, listGroupPersonas } = deps;
  const arg = (text || '').trim().slice('/persona'.length).trim();

  if (!arg) {
    let rows = [];
    try {
      rows = listGroupPersonas ? listGroupPersonas() : [];
    } catch {
      /* DB puede no estar lista */
    }
    const lines = ['🎭 Personalidades por grupo'];
    if (rows.length) {
      for (const r of rows) lines.push(`• ${r.group_name || r.group_id}: "${truncate(r.persona, 80)}"`);
    } else {
      lines.push('(ninguna configurada)');
    }
    lines.push('', 'Uso: /persona <n|nombre> | <texto> · /persona <n|nombre> off · /persona <n|nombre>');
    return lines.join('\n');
  }

  let groups;
  try {
    groups = listGroups ? await listGroups() : [];
  } catch {
    return 'No pude listar los grupos ahora (¿WhatsApp conectado?).';
  }
  groups = [...groups].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));

  // set: "<target> | <texto>"
  const pipeIdx = arg.indexOf('|');
  if (pipeIdx !== -1) {
    const targetArg = arg.slice(0, pipeIdx).trim();
    const persona = arg.slice(pipeIdx + 1).trim();
    if (!targetArg || !persona) return 'Uso: /persona <n|nombre> | <texto de la personalidad>';
    const target = resolveGroupTarget(targetArg, groups);
    if (!target) return `No encontré "${targetArg}". Usa /grupos para ver la lista y el número.`;
    if (setGroupPersona) {
      setGroupPersona({ groupId: target.id, groupName: target.name, persona, updatedBy: sender });
    }
    return `🎭 Personalidad de "${target.name || target.id}" guardada ✅\n"${persona}"`;
  }

  // off: "<target> off"
  const parts = arg.split(/\s+/);
  if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === 'off') {
    const targetArg = parts.slice(0, -1).join(' ');
    const target = resolveGroupTarget(targetArg, groups);
    if (!target) return `No encontré "${targetArg}". Usa /grupos para ver la lista y el número.`;
    const changes = deleteGroupPersona ? deleteGroupPersona(target.id) : 0;
    return changes
      ? `🎭 Personalidad de "${target.name || target.id}" eliminada — vuelve al tono genérico.`
      : `"${target.name || target.id}" no tenía personalidad configurada.`;
  }

  // ver: "<target>"
  const target = resolveGroupTarget(arg, groups);
  if (!target) return `No encontré "${arg}". Usa /grupos para ver la lista y el número.`;
  const persona = getGroupPersona ? getGroupPersona(target.id) : null;
  return persona
    ? `🎭 Personalidad de "${target.name || target.id}":\n"${persona}"`
    : `"${target.name || target.id}" no tiene personalidad configurada (usa /persona <n|nombre> | <texto>).`;
}

// /programados            → lista los mensajes recurrentes activos
// /programados off <id>   → cancela uno
function handleProgramados(text, deps = {}) {
  const { listScheduledMessages, cancelScheduledMessage } = deps;
  const parts = (text || '').trim().split(/\s+/); // [ '/programados', action?, id? ]
  const action = (parts[1] || 'list').toLowerCase();

  if (action === 'off') {
    const id = Number(parts[2]);
    if (!Number.isInteger(id)) return 'Uso: /programados off <id>';
    const changes = cancelScheduledMessage ? cancelScheduledMessage(id) : 0;
    return changes
      ? `Mensaje programado #${id} cancelado ✅`
      : `No hay ningún mensaje programado activo con id ${id}.`;
  }

  let rows = [];
  try {
    rows = listScheduledMessages ? listScheduledMessages() : [];
  } catch {
    /* DB puede no estar lista */
  }
  if (!rows.length) return '📆 No hay mensajes programados activos.';
  const lines = [`📆 Mensajes programados (${rows.length})`, ''];
  for (const r of rows) {
    lines.push(`#${r.id} → ${r.group_name || r.group_id} — ${csvToDayLabels(r.days)} a las ${r.time_hm}`);
    lines.push(`    "${truncate(r.text, 100)}"`);
  }
  lines.push('', 'Cancelar: /programados off <id>');
  return lines.join('\n');
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// Contenido de /help SEGÚN el rol. El jefe (boss) no opera por comandos: se le
// recuerda que habla normal. El admin ve la lista completa. Un desconocido, lo mínimo.
// (Sincronizar con docs/MANUAL-DE-USO.md si cambian los comandos.)
function buildHelp(role) {
  if (role === 'admin') {
    return [
      '🛠️ Comandos de Juanito (equipo)',
      '',
      'Confirmaciones:',
      '• /confirmaciones — estado (DM + grupos)',
      '• /confirmaciones dm on|off — confirmar todos los DMs de desconocidos',
      '• /confirmaciones grupo <n|nombre> on|off — confirmar un grupo',
      '• /respuestas [ver|aprobar|rechazar <id>] — pendientes (grupo + DM)',
      '',
      'Grupos:',
      '• /grupos [on|off <n|nombre>] — listar/autorizar grupos',
      '• /grupo [on|off] — (dentro del grupo)',
      '• /persona <n|nombre> | <texto> — tono por grupo',
      '',
      'Programados:',
      '• /programados [off <id>] — mensajes recurrentes',
      '• /aprobaciones [ver|aprobar|rechazar <id>] — borradores generados',
      '',
      'Operación:',
      '• /tareas [ver|hecha|descartar <id>] — órdenes del jefe por hacer',
      '• /negocio [pendientes|ok|no|olvida <id>] — contexto del negocio',
      '• /calendly [on|off] [closer] — pushes precall',
      '• /reportes [leads|metricas] — preview (en grupo lo publica; jefe/admin)',
      '• /status — estado del sistema',
      '• /whoami · /id — tu ID y rol',
    ].join('\n');
  }

  if (role === 'boss') {
    return [
      '👋 Hola, soy Juanito.',
      '',
      'No necesitas comandos: háblame normal y yo me encargo.',
      '• "apruebo" / "más corto" / "no" — para lo que te paso a confirmar',
      '• "recuérdame pagar el viernes 9am" — te creo un recordatorio',
      '• "¿qué tengo pendiente?" / "cancela el de las 3" — gestiono tus recordatorios',
      '• "en el grupo X los jueves 8pm manda…" — programo mensajes a un grupo',
      '• o pregúntame lo que necesites',
      '',
      'Comandos: /whoami · /id (te dicen tu ID y rol).',
    ].join('\n');
  }

  // unknown / closer
  return [
    '👋 Soy Juanito, un asistente. Escríbeme tu consulta y te ayudo.',
    '(/whoami te dice tu ID y rol.)',
  ].join('\n');
}

async function handleReporte({ buildSheetsReport } = {}) {
  if (!buildSheetsReport) {
    return 'El reporte de leads no está configurado (falta el service account o el grupo).';
  }
  try {
    const { message } = await buildSheetsReport();
    return message;
  } catch (e) {
    return `No pude generar el reporte ahora: ${e.message}`;
  }
}

async function handleMetricas({ buildMetricsReport } = {}) {
  if (!buildMetricsReport) {
    return 'El reporte de métricas no está configurado (falta el service account, el spreadsheet o los destinatarios).';
  }
  try {
    const { message } = await buildMetricsReport();
    return message;
  } catch (e) {
    return `No pude generar las métricas ahora: ${e.message}`;
  }
}

// /grupos                  → lista numerada de TODOS los grupos + su estado de autorización
// /grupos off <n|nombre>   → revoca autorización y Juanito SE SALE de ese grupo
// /grupos on  <n|nombre>   → habilita a Juanito para responder en ese grupo
async function handleGrupos({ text, sender }, deps = {}) {
  const { listGroups, listAuthorizedGroups, authorizeGroup, deauthorizeGroup, leaveGroup } = deps;
  const parts = (text || '').trim().split(/\s+/); // [ '/grupos', action?, ...arg ]
  const action = (parts[1] || 'status').toLowerCase();
  const arg = parts.slice(2).join(' ').trim();

  let groups;
  try {
    groups = listGroups ? await listGroups() : [];
  } catch {
    return 'No pude listar los grupos ahora (¿WhatsApp conectado?).';
  }
  groups = [...groups].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));

  const authMap = new Map();
  try {
    for (const a of listAuthorizedGroups ? listAuthorizedGroups() : []) authMap.set(a.group_id, a);
  } catch {
    /* la DB puede no estar lista; seguimos sin estado de autorización */
  }

  if (action === 'status' || action === 'list') return buildGruposList(groups, authMap);

  if (action !== 'on' && action !== 'off') {
    return 'Uso: /grupos · /grupos off <n|nombre> · /grupos on <n|nombre>';
  }
  if (!arg) return `Uso: /grupos ${action} <número o nombre del grupo>`;

  const target = resolveGroupTarget(arg, groups);
  if (!target) return `No encontré "${arg}". Usa /grupos para ver la lista y el número.`;
  const name = target.name || '(sin nombre)';

  if (action === 'on') {
    if (authorizeGroup) authorizeGroup({ groupId: target.id, groupName: target.name, authorizedBy: sender });
    return `"${name}" habilitado ✅ — Juanito ya responde ahí.`;
  }
  // off → revoca + sale
  if (deauthorizeGroup) deauthorizeGroup(target.id);
  if (leaveGroup) await leaveGroup(target.id).catch(() => {});
  return `"${name}" deshabilitado ⛔ — Juanito se salió del grupo.`;
}

// Resuelve el target de /grupos on|off: número (1-based de la lista ordenada) o
// substring del nombre / group_id. Devuelve el grupo o null si es ambiguo/no existe.
function resolveGroupTarget(arg, groups) {
  if (/^\d+$/.test(arg)) {
    const idx = Number(arg) - 1;
    return groups[idx] || null;
  }
  const q = arg.toLowerCase();
  const byName = groups.filter((g) => (g.name || '').toLowerCase().includes(q));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null; // ambiguo: que use el número
  return groups.find((g) => (g.id || '').toLowerCase().includes(q)) || null;
}

function buildGruposList(groups, authMap) {
  if (!groups.length) return '👥 Juanito no está en ningún grupo ahora mismo.';
  const lines = [`👥 Grupos de Juanito (${groups.length})`, ''];
  groups.forEach((g, i) => {
    const a = authMap.get(g.id);
    const mark = a ? '✅' : '⛔';
    const status = a
      ? `autorizado${a.authorized_by ? ` · por ${shortId(a.authorized_by)}` : ''}`
      : 'no autorizado'; // Juanito NO responde aquí
    lines.push(`${i + 1}. ${mark} ${g.name || '(sin nombre)'}`);
    lines.push(`    ${status}`);
  });
  lines.push('', 'Acciones: /grupos off <n> (salir) · /grupos on <n> (habilitar)');
  return lines.join('\n');
}

// Acorta un JID/LID para mostrarlo: 573102212005@lid → 573102212005
function shortId(id) {
  return String(id).split('@')[0];
}

// /calendly                  → estado global + closers pausados
// /calendly on|off           → reactiva / pausa TODOS los pushes (global)
// /calendly on|off <closer>  → reactiva / pausa solo a ese closer (nombre completo)
function handleCalendly(text, deps = {}) {
  const { isCalendlyPaused, setCalendlyPaused, setCloserPaused, resolveCloserByPushName } = deps;
  const parts = (text || '').trim().split(/\s+/); // [ '/calendly', action?, ...nombre ]
  const action = (parts[1] || 'status').toLowerCase();
  const closerName = parts.slice(2).join(' ').trim();

  if (action === 'status') return buildCalendlyStatus(deps);
  if (action !== 'on' && action !== 'off') {
    return 'Uso: /calendly [on|off] [nombre completo del closer]';
  }
  const pause = action === 'off';

  // Por-closer.
  if (closerName) {
    const closer = resolveCloserByPushName ? resolveCloserByPushName(closerName) : null;
    if (!closer) {
      return `No reconozco al closer "${closerName}". Usa el nombre completo (ej: Pablo Lozano).`;
    }
    const changes = setCloserPaused ? setCloserPaused(closer.phone, pause) : 0;
    if (!changes) {
      return `${closer.name} aún no tiene opt-in registrado, no hay nada que ${pause ? 'pausar' : 'reactivar'}.`;
    }
    return `Pushes de ${closer.name}: ${pause ? 'PAUSADOS ⏸️' : 'reactivados ▶️'}`;
  }

  // Global.
  if (setCalendlyPaused) setCalendlyPaused(pause);
  return pause
    ? 'Pushes de Calendly: PAUSADOS ⏸️ (global) — no se enviará nada hasta `/calendly on`.'
    : 'Pushes de Calendly: reactivados ▶️ (global).';
}

function buildCalendlyStatus({ isCalendlyPaused, listOptins } = {}) {
  let paused = false;
  try {
    paused = isCalendlyPaused ? isCalendlyPaused() : false;
  } catch {
    /* DB puede no estar lista */
  }
  const lines = ['📅 Calendly — pushes precall', `Estado global: ${paused ? 'PAUSADO ⏸️' : 'activo ▶️'}`];
  try {
    const optins = listOptins ? listOptins() : [];
    const pausados = optins.filter((o) => o.paused);
    lines.push(
      pausados.length
        ? `Closers pausados: ${pausados.map((o) => o.name || o.phone).join(', ')}`
        : 'Closers pausados: ninguno'
    );
  } catch {
    /* opcional */
  }
  return lines.join('\n');
}

function buildStatus({ listOptins, isConnected, getHealth } = {}) {
  const flag = (v, def) => (v ?? def) !== 'false';
  const dryRun = flag(process.env.CALENDLY_DRY_RUN, 'true');
  const requireOptin = flag(process.env.CALENDLY_REQUIRE_OPTIN, 'true');
  const hasToken = !!process.env.CALENDLY_TOKEN;

  let optins = 0;
  try {
    optins = listOptins ? listOptins().length : 0;
  } catch {
    /* la DB puede no estar lista; lo dejamos en 0 */
  }
  const wa = isConnected && isConnected() ? 'conectado ✅' : 'desconectado ❌';

  const lines = [
    '📊 Estado de Juanito',
    `WhatsApp: ${wa}`,
    `Uptime: ${formatUptime(process.uptime())}`,
    `Calendly token: ${hasToken ? 'presente' : 'FALTA ⚠️'}`,
    `DRY_RUN: ${dryRun ? 'ON (no envía)' : 'OFF (envía real ⚠️)'}`,
    `Require opt-in: ${requireOptin ? 'ON' : 'OFF'}`,
    `Opt-ins registrados: ${optins}`,
  ];

  // Salud de los jobs de Calendly (decisión 5): último poll, errores, sin mapear.
  try {
    const h = getHealth ? getHealth() : null;
    if (h) {
      lines.push(
        `Último poll: ${h.lastPollAt ? `${formatAgo(h.lastPollAt)} (${h.lastPollCount} citas)` : 'aún no corre'}`
      );
      if (h.lastError) lines.push(`Último error: ${h.lastError} (${formatAgo(h.lastErrorAt)})`);
      if (h.unmapped && h.unmapped.length) {
        lines.push(`⚠️ Closers sin mapear: ${h.unmapped.map((u) => u.email).join(', ')}`);
      }
    }
  } catch {
    /* health opcional; no romper /status si falla */
  }

  return lines.join('\n');
}

function formatAgo(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)}m`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)}h`;
  return `hace ${Math.floor(s / 86400)}d`;
}

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
