// src/bot/commands.js
// Comandos deterministas (sin Claude, sin gastar tokens) para el equipo.
// Se interceptan en onMessage ANTES del ruteo por rol.
//
// No importamos db/whatsapp al tope a propósito: así este módulo es testeable
// sin las deps nativas (better-sqlite3). Las deps de /status se inyectan.

// Intenta manejar `text` como comando.
// Devuelve un string de respuesta si lo manejó, o null si no aplica (para que
// el flujo siga su curso normal hacia Claude / opt-in).
export function handleCommand({ text, sender, role }, deps = {}) {
  const cmd = (text || '').trim().toLowerCase();

  // /whoami — disponible para cualquiera: devuelve tu ID y rol. Sirve para que
  // un admin nuevo capture su LID sin tener que leer los logs del VPS.
  if (cmd === '/whoami' || cmd === '/id') {
    return `Tu ID: ${sender}\nRol: ${role}`;
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

  return null;
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
