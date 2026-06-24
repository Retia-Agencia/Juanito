// test/commands.test.js
// Cubre handleCommand: /whoami (cualquiera) y /status (solo admin).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { handleCommand, isReportCommand, wantsMetrics } = await import('../src/bot/commands.js');

const deps = {
  listOptins: () => [{ phone: '1' }, { phone: '2' }, { phone: '3' }],
  isConnected: () => true,
};

test('/whoami devuelve ID y rol', async () => {
  const out = await handleCommand({ text: '/whoami', sender: '129@lid', role: 'admin' });
  assert.match(out, /129@lid/);
  assert.match(out, /admin/);
});

test('/whoami tolera mayúsculas y espacios, y tiene alias /id', async () => {
  assert.match(await handleCommand({ text: '  /WhoAmI ', sender: 'x@lid', role: 'boss' }), /x@lid/);
  assert.match(await handleCommand({ text: '/id', sender: 'y@lid', role: 'boss' }), /y@lid/);
});

// ─── /help (role-aware, disponible para cualquiera) ───────────────────────────

test('/help (admin) lista los comandos del equipo', async () => {
  const out = await handleCommand({ text: '/help', sender: 'a@lid', role: 'admin' });
  assert.match(out, /\/confirmaciones/);
  assert.match(out, /\/grupos/);
  assert.match(out, /\/calendly/);
  assert.match(out, /equipo/i);
});

test('/help (jefe) NO lista comandos del equipo; le dice que hable normal', async () => {
  const out = await handleCommand({ text: '/help', sender: 'b@lid', role: 'boss' });
  assert.match(out, /háblame normal/i);
  assert.match(out, /recuérdame|recordatorio/i);
  assert.doesNotMatch(out, /\/calendly|\/grupos|\/confirmaciones/); // sin comandos de admin
  assert.match(out, /\/whoami/); // pero sí los suyos
});

test('/help (desconocido) saludo mínimo, sin comandos de admin', async () => {
  const out = await handleCommand({ text: '/help', sender: 'z@lid', role: 'unknown' });
  assert.match(out, /asistente/i);
  assert.doesNotMatch(out, /\/calendly|\/grupos/);
});

test('/help tiene alias /ayuda y /comandos, tolera mayúsculas/espacios', async () => {
  assert.match(await handleCommand({ text: '  /Ayuda ', sender: 'a@lid', role: 'admin' }), /\/grupos/);
  assert.match(await handleCommand({ text: '/COMANDOS', sender: 'a@lid', role: 'admin' }), /\/grupos/);
});

// ─── /reportes unificado (leads | metricas) ───────────────────────────────────

test('isReportCommand reconoce /reportes, /reporte, /metricas y sus variantes con arg', () => {
  for (const c of ['/reporte', '/reportes', '/metricas', '/métricas', '/reportes leads', '/reportes metricas', '/metricas ']) {
    assert.ok(isReportCommand(c), c);
  }
  for (const c of ['/report', '/grupos', 'reportes', '/reporteros']) {
    assert.ok(!isReportCommand(c), c);
  }
});

test('wantsMetrics distingue métricas de leads', () => {
  assert.ok(wantsMetrics('/metricas'));
  assert.ok(wantsMetrics('/métricas'));
  assert.ok(wantsMetrics('/reportes metricas'));
  assert.ok(wantsMetrics('/reportes métricas'));
  assert.ok(!wantsMetrics('/reportes'));
  assert.ok(!wantsMetrics('/reportes leads'));
  assert.ok(!wantsMetrics('/reporte'));
});

test('/reportes metricas (admin) usa buildMetricsReport', async () => {
  const out = await handleCommand(
    { text: '/reportes metricas', sender: 'a@lid', role: 'admin' },
    { buildMetricsReport: async () => ({ message: 'MÉTRICAS-OK' }), buildSheetsReport: async () => ({ message: 'LEADS-OK' }) }
  );
  assert.equal(out, 'MÉTRICAS-OK');
});

test('/reportes y /reportes leads (admin) usan buildSheetsReport (leads)', async () => {
  const deps = { buildMetricsReport: async () => ({ message: 'MÉTRICAS-OK' }), buildSheetsReport: async () => ({ message: 'LEADS-OK' }) };
  assert.equal(await handleCommand({ text: '/reportes', sender: 'a@lid', role: 'admin' }, deps), 'LEADS-OK');
  assert.equal(await handleCommand({ text: '/reportes leads', sender: 'a@lid', role: 'admin' }, deps), 'LEADS-OK');
  assert.equal(await handleCommand({ text: '/reporte', sender: 'a@lid', role: 'admin' }, deps), 'LEADS-OK'); // back-compat
});

test('/reportes (jefe) → deflexión cálida (admin-only en DM)', async () => {
  const out = await handleCommand({ text: '/reportes', sender: 'b@lid', role: 'boss' });
  assert.match(out, /equipo técnico/);
});

test('/metricas (admin) devuelve el preview usando buildMetricsReport inyectado', async () => {
  const out = await handleCommand(
    { text: '/metricas', sender: 'a@lid', role: 'admin' },
    { buildMetricsReport: async () => ({ message: '📈 Métricas de desempeño\n• Cierres: 3' }) }
  );
  assert.match(out, /Métricas de desempeño/);
  assert.match(out, /Cierres: 3/);
});

test('/metricas (jefe) → deflexión cálida (es de admin)', async () => {
  const out = await handleCommand({ text: '/metricas', sender: 'b@lid', role: 'boss' });
  assert.match(out, /equipo técnico/);
});

test('/metricas sin buildMetricsReport configurado avisa con claridad', async () => {
  const out = await handleCommand({ text: '/metricas', sender: 'a@lid', role: 'admin' }, {});
  assert.match(out, /no está configurado/i);
});

test('/status (admin) reporta estado con las deps inyectadas', async () => {
  const out = await handleCommand({ text: '/status', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /WhatsApp: conectado/);
  assert.match(out, /Opt-ins registrados: 3/);
});

test('/status refleja DRY_RUN OFF cuando la env lo apaga', async () => {
  const saved = process.env.CALENDLY_DRY_RUN;
  process.env.CALENDLY_DRY_RUN = 'false';
  try {
    const out = await handleCommand({ text: '/status', sender: 'a@lid', role: 'admin' }, deps);
    assert.match(out, /DRY_RUN: OFF/);
  } finally {
    if (saved === undefined) delete process.env.CALENDLY_DRY_RUN;
    else process.env.CALENDLY_DRY_RUN = saved;
  }
});

test('/status para el jefe → deflexión cálida (no diagnósticos técnicos)', async () => {
  // El jefe está sandboxed: en vez de null/silencio, recibe un mensaje amable.
  const out = await handleCommand({ text: '/status', sender: 'b@lid', role: 'boss' }, deps);
  assert.match(out, /equipo técnico/);
});

test('texto que no es comando devuelve null', async () => {
  assert.equal(await handleCommand({ text: 'hola juanito', sender: 'b@lid', role: 'boss' }), null);
  assert.equal(await handleCommand({ text: '', sender: 'b@lid', role: 'admin' }), null);
});

// ─── /calendly (botón de pánico, admin-only) ──────────────────────────────────

function calendlyDeps() {
  const state = { global: false, closers: {} };
  return {
    _state: state,
    isCalendlyPaused: () => state.global,
    setCalendlyPaused: (v) => { state.global = !!v; },
    setCloserPaused: (phone, v) => { state.closers[phone] = !!v; return phone === '+573046131437' ? 1 : 0; },
    listOptins: () => [
      { phone: '+573046131437', name: 'Pablo Lozano', paused: state.closers['+573046131437'] ? 1 : 0 },
    ],
    resolveCloserByPushName: (n) =>
      /pablo lozano/i.test(n) ? { email: 'pablo.lozano@30x.com', name: 'Pablo Lozano', phone: '+573046131437' } : null,
  };
}

test('/calendly para no-admin → deflexión (no expone estado)', async () => {
  assert.match(await handleCommand({ text: '/calendly', sender: 'b@lid', role: 'boss' }, calendlyDeps()), /equipo técnico/);
  assert.match(await handleCommand({ text: '/calendly off', sender: 'u@lid', role: 'unknown' }, calendlyDeps()), /equipo técnico/);
});

test('/calendly (admin) sin args → muestra estado global y closers pausados', async () => {
  const out = await handleCommand({ text: '/calendly', sender: 'a@lid', role: 'admin' }, calendlyDeps());
  assert.match(out, /Estado global: activo/);
  assert.match(out, /Closers pausados: ninguno/);
});

test('/calendly off | on (global) pausa y reactiva, y se refleja en el estado', async () => {
  const deps = calendlyDeps();
  assert.match(await handleCommand({ text: '/calendly off', sender: 'a@lid', role: 'admin' }, deps), /PAUSADOS ⏸️ \(global\)/);
  assert.equal(deps._state.global, true);
  assert.match(await handleCommand({ text: '/calendly', sender: 'a@lid', role: 'admin' }, deps), /Estado global: PAUSADO/);
  assert.match(await handleCommand({ text: '/calendly on', sender: 'a@lid', role: 'admin' }, deps), /reactivados ▶️ \(global\)/);
  assert.equal(deps._state.global, false);
});

test('/calendly off <closer> pausa solo a ese closer (nombre completo)', async () => {
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly off Pablo Lozano', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Pablo Lozano: PAUSADOS ⏸️/);
  assert.equal(deps._state.closers['+573046131437'], true);
});

test('/calendly off con closer desconocido → mensaje de ayuda, no pausa nada', async () => {
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly off Fulano', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /No reconozco al closer/);
  assert.equal(deps._state.global, false);
});

test('/calendly con acción inválida → uso', async () => {
  assert.match(
    await handleCommand({ text: '/calendly foo', sender: 'a@lid', role: 'admin' }, calendlyDeps()),
    /Uso: \/calendly/
  );
});

test('/status tolera que listOptins falle (db no lista)', async () => {
  const out = await handleCommand(
    { text: '/status', sender: 'a@lid', role: 'admin' },
    {
      listOptins: () => {
        throw new Error('db no lista');
      },
      isConnected: () => false,
    }
  );
  assert.match(out, /Opt-ins registrados: 0/);
  assert.match(out, /WhatsApp: desconectado/);
});

// ─── /grupos (visibilidad + control remoto de grupos, admin-only) ─────────────

function gruposDeps() {
  const state = {
    groups: [
      { id: 'b@g.us', name: 'Beta interno' },
      { id: 'a@g.us', name: 'Alfa clientes' },
      { id: 'c@g.us', name: 'Charlie random' },
    ],
    authorized: [{ group_id: 'a@g.us', group_name: 'Alfa clientes', authorized_by: '573102212005@lid' }],
    left: [],
  };
  return {
    _state: state,
    listGroups: async () => state.groups,
    listAuthorizedGroups: () => state.authorized,
    authorizeGroup: ({ groupId, groupName, authorizedBy }) =>
      state.authorized.push({ group_id: groupId, group_name: groupName, authorized_by: authorizedBy }),
    deauthorizeGroup: (id) => {
      const n = state.authorized.length;
      state.authorized = state.authorized.filter((a) => a.group_id !== id);
      return n - state.authorized.length;
    },
    leaveGroup: async (id) => state.left.push(id),
  };
}

test('/grupos para no-admin → deflexión (no expone los grupos)', async () => {
  assert.match(await handleCommand({ text: '/grupos', sender: 'b@lid', role: 'boss' }, gruposDeps()), /equipo técnico/);
  assert.match(await handleCommand({ text: '/grupos', sender: 'u@lid', role: 'unknown' }, gruposDeps()), /equipo técnico/);
});

test('/grupos (admin) lista ordenada con estado de autorización', async () => {
  const out = await handleCommand({ text: '/grupos', sender: 'a@lid', role: 'admin' }, gruposDeps());
  assert.match(out, /Grupos de Juanito \(3\)/);
  // Orden alfabético: Alfa(1) ✅, Beta(2) ⛔, Charlie(3) ⛔
  assert.match(out, /1\. ✅ Alfa clientes/);
  assert.match(out, /por 573102212005/); // shortId, sin @lid
  assert.match(out, /2\. ⛔ Beta interno/);
  assert.match(out, /3\. ⛔ Charlie random/);
});

test('/grupos off <n> revoca y sale del grupo correcto', async () => {
  const deps = gruposDeps();
  const out = await handleCommand({ text: '/grupos off 1', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /"Alfa clientes" deshabilitado ⛔/);
  assert.deepEqual(deps._state.left, ['a@g.us']);
  assert.equal(deps._state.authorized.length, 0);
});

test('/grupos on <nombre> autoriza por substring', async () => {
  const deps = gruposDeps();
  const out = await handleCommand({ text: '/grupos on beta', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /"Beta interno" habilitado ✅/);
  assert.ok(deps._state.authorized.some((a) => a.group_id === 'b@g.us'));
});

test('/grupos off con target inexistente → no sale de ningún grupo', async () => {
  const deps = gruposDeps();
  const out = await handleCommand({ text: '/grupos off 99', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /No encontré/);
  assert.equal(deps._state.left.length, 0);
});

test('/grupos tolera que WhatsApp no esté conectado', async () => {
  const out = await handleCommand(
    { text: '/grupos', sender: 'a@lid', role: 'admin' },
    { listGroups: async () => { throw new Error('sin socket'); } }
  );
  assert.match(out, /No pude listar los grupos/);
});

// ─── /reporte (preview on-demand del reporte de leads, admin-only) ────────────

test('/reporte (admin) devuelve el mensaje del reporte', async () => {
  const deps = { buildSheetsReport: async () => ({ message: '📊 Reporte de leads — total 7' }) };
  const out = await handleCommand({ text: '/reporte', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Reporte de leads — total 7/);
});

test('/reporte para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/reporte', sender: 'b@lid', role: 'boss' }, {}), /equipo técnico/);
});

test('/reporte informa si la generación falla', async () => {
  const deps = { buildSheetsReport: async () => { throw new Error('403 sin acceso'); } };
  const out = await handleCommand({ text: '/reporte', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /No pude generar el reporte ahora: 403 sin acceso/);
});

// ─── /persona (personalidad por grupo, admin-only) ────────────────────────────

function personaDeps() {
  const state = { personas: new Map() };
  return {
    _state: state,
    listGroups: async () => [
      { id: 'p@g.us', name: 'Patah San Juan de Ávila ✝️' },
      { id: 'v@g.us', name: 'Ventas EstadoX' },
    ],
    setGroupPersona: ({ groupId, persona }) => state.personas.set(groupId, persona),
    getGroupPersona: (id) => state.personas.get(id) ?? null,
    deleteGroupPersona: (id) => (state.personas.delete(id) ? 1 : 0),
    listGroupPersonas: () =>
      [...state.personas.entries()].map(([group_id, persona]) => ({ group_id, group_name: group_id, persona })),
  };
}

test('/persona para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/persona', sender: 'b@lid', role: 'boss' }, personaDeps()), /equipo técnico/);
});

test('/persona <nombre> | <texto> guarda EXACTO y se puede ver', async () => {
  const deps = personaDeps();
  const persona = 'Grupo religioso católico. Tono alusivo a la fe; di "muchachos".';
  const out = await handleCommand(
    { text: `/persona patah | ${persona}`, sender: 'a@lid', role: 'admin' },
    deps
  );
  assert.match(out, /guardada ✅/);
  assert.equal(deps._state.personas.get('p@g.us'), persona, 'el texto queda tal cual (con tildes y comillas)');

  const ver = await handleCommand({ text: '/persona patah', sender: 'a@lid', role: 'admin' }, deps);
  assert.ok(ver.includes(persona));
});

test('/persona <nombre> off elimina; sin configurar lo dice', async () => {
  const deps = personaDeps();
  deps._state.personas.set('p@g.us', 'algo');
  assert.match(await handleCommand({ text: '/persona patah off', sender: 'a@lid', role: 'admin' }, deps), /eliminada/);
  assert.equal(deps._state.personas.has('p@g.us'), false);
  assert.match(await handleCommand({ text: '/persona patah off', sender: 'a@lid', role: 'admin' }, deps), /no tenía/);
});

test('/persona sin args lista las configuradas', async () => {
  const deps = personaDeps();
  deps._state.personas.set('v@g.us', 'Tono comercial directo');
  const out = await handleCommand({ text: '/persona', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Tono comercial directo/);
  assert.match(out, /Uso: \/persona/);
});

test('/persona con grupo inexistente → ayuda', async () => {
  const out = await handleCommand({ text: '/persona nadaqver | hola', sender: 'a@lid', role: 'admin' }, personaDeps());
  assert.match(out, /No encontré/);
});

// ─── /programados (mensajes recurrentes, admin-only) ──────────────────────────

function programadosDeps() {
  const state = {
    rows: [
      { id: 3, group_id: 'p@g.us', group_name: 'Patah San Juan de Ávila ✝️', days: '0,4', time_hm: '20:00', text: 'Muchachos, ¡los esperamos hoy en la reunión!', active: 1 },
    ],
  };
  return {
    _state: state,
    listScheduledMessages: () => state.rows.filter((r) => r.active),
    cancelScheduledMessage: (id) => {
      const row = state.rows.find((r) => r.id === id && r.active);
      if (!row) return 0;
      row.active = 0;
      return 1;
    },
  };
}

test('/programados para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/programados', sender: 'b@lid', role: 'boss' }, programadosDeps()), /equipo técnico/);
});

test('/programados (admin) lista con días legibles y hora', async () => {
  const out = await handleCommand({ text: '/programados', sender: 'a@lid', role: 'admin' }, programadosDeps());
  assert.match(out, /#3 → Patah San Juan de Ávila ✝️ — domingo y jueves a las 20:00/);
  assert.match(out, /los esperamos hoy/);
});

test('/programados off <id> cancela; id inexistente lo dice', async () => {
  const deps = programadosDeps();
  assert.match(await handleCommand({ text: '/programados off 3', sender: 'a@lid', role: 'admin' }, deps), /#3 cancelado ✅/);
  assert.equal(deps._state.rows[0].active, 0);
  assert.match(await handleCommand({ text: '/programados off 3', sender: 'a@lid', role: 'admin' }, deps), /No hay ningún/);
  assert.match(await handleCommand({ text: '/programados off abc', sender: 'a@lid', role: 'admin' }, deps), /Uso:/);
});

// ─── /aprobaciones (estado y override del flujo de aprobación, admin-only) ─────

function aprobacionesDeps() {
  const state = {
    drafts: [
      { id: 5, scheduled_id: 7, publish_date: '2099-01-01', draft: 'Mensaje de San José para hoy…', status: 'pending', group_name: 'Patah', time_hm: '09:00' },
      { id: 6, scheduled_id: 8, publish_date: '2099-01-01', draft: 'Recordatorio reunión 6:30pm', status: 'published', group_name: 'Patah', time_hm: '08:00' },
    ],
  };
  return {
    _state: state,
    listDraftsForDate: () => state.drafts,
    getDraft: (id) => state.drafts.find((d) => d.id === id) || null,
    approveDraft: (id) => {
      const d = state.drafts.find((x) => x.id === id && x.status === 'pending');
      if (!d) return 0;
      d.status = 'approved';
      return 1;
    },
    discardDraft: (id) => {
      const d = state.drafts.find((x) => x.id === id && (x.status === 'pending' || x.status === 'approved'));
      if (!d) return 0;
      d.status = 'discarded';
      return 1;
    },
  };
}

test('/aprobaciones para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/aprobaciones', sender: 'b@lid', role: 'boss' }, aprobacionesDeps()), /equipo técnico/);
});

test('/aprobaciones (admin) lista los borradores de hoy con estado', async () => {
  const out = await handleCommand({ text: '/aprobaciones', sender: 'a@lid', role: 'admin' }, aprobacionesDeps());
  assert.match(out, /#5 → Patah a las 09:00 — ⏳ pendiente/);
  assert.match(out, /#6 → Patah a las 08:00 — 📤 publicado/);
});

test('/aprobaciones ver <id> muestra el texto completo', async () => {
  const out = await handleCommand({ text: '/aprobaciones ver 5', sender: 'a@lid', role: 'admin' }, aprobacionesDeps());
  assert.match(out, /Mensaje de San José para hoy…/);
});

test('/aprobaciones aprobar <id> hace override; ya publicado lo dice', async () => {
  const deps = aprobacionesDeps();
  assert.match(await handleCommand({ text: '/aprobaciones aprobar 5', sender: 'a@lid', role: 'admin' }, deps), /aprobado ✅ \(override admin\)/);
  assert.equal(deps._state.drafts[0].status, 'approved');
  assert.match(await handleCommand({ text: '/aprobaciones aprobar 6', sender: 'a@lid', role: 'admin' }, deps), /no está pendiente/);
  assert.match(await handleCommand({ text: '/aprobaciones aprobar abc', sender: 'a@lid', role: 'admin' }, deps), /Uso:/);
});

test('/aprobaciones rechazar <id> descarta el borrador; publicado no se descarta', async () => {
  const deps = aprobacionesDeps();
  assert.match(await handleCommand({ text: '/aprobaciones rechazar 5', sender: 'a@lid', role: 'admin' }, deps), /descartado 🗑️/);
  assert.equal(deps._state.drafts[0].status, 'discarded');
  // #6 ya está publicado → no se puede descartar.
  assert.match(await handleCommand({ text: '/aprobaciones rechazar 6', sender: 'a@lid', role: 'admin' }, deps), /no se puede descartar/);
  assert.match(await handleCommand({ text: '/aprobaciones rechazar abc', sender: 'a@lid', role: 'admin' }, deps), /Uso:/);
});

test('/aprobaciones rechazar para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/aprobaciones rechazar 5', sender: 'b@lid', role: 'boss' }, aprobacionesDeps()), /equipo técnico/);
});

// ─── /aprobar_grupo (flag de aprobación de respuestas por grupo, admin-only) ───

function aprobarGrupoDeps() {
  const state = { approval: {} };
  return {
    _state: state,
    listGroups: async () => [
      { id: 'patah@g.us', name: 'Patah San Juan' },
      { id: 'tech@g.us', name: 'Tech Volunteers' },
    ],
    isGroupAuthorized: (id) => id === 'patah@g.us' || id === 'tech@g.us',
    setGroupApproval: (id, on) => {
      state.approval[id] = on ? 1 : 0;
      return 1;
    },
    listApprovalGroups: () =>
      Object.entries(state.approval)
        .filter(([, v]) => v)
        .map(([group_id]) => ({ group_id, group_name: group_id })),
  };
}

test('/aprobar_grupo para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/aprobar_grupo patah on', sender: 'b@lid', role: 'boss' }, aprobarGrupoDeps()), /equipo técnico/);
});

test('/aprobar_grupo <nombre> on activa el flag; off lo apaga', async () => {
  const deps = aprobarGrupoDeps();
  assert.match(await handleCommand({ text: '/aprobar_grupo patah on', sender: 'a@lid', role: 'admin' }, deps), /ACTIVADA/);
  assert.equal(deps._state.approval['patah@g.us'], 1);
  assert.match(await handleCommand({ text: '/aprobar_grupo patah off', sender: 'a@lid', role: 'admin' }, deps), /DESACTIVADA/);
  assert.equal(deps._state.approval['patah@g.us'], 0);
});

test('/aprobar_grupo sin on|off → muestra uso; grupo inexistente → no encontrado', async () => {
  const deps = aprobarGrupoDeps();
  assert.match(await handleCommand({ text: '/aprobar_grupo patah', sender: 'a@lid', role: 'admin' }, deps), /Uso:/);
  assert.match(await handleCommand({ text: '/aprobar_grupo inexistente on', sender: 'a@lid', role: 'admin' }, deps), /No encontré/);
});

test('/aprobar_grupo sin args lista los grupos con aprobación ON', async () => {
  const deps = aprobarGrupoDeps();
  await handleCommand({ text: '/aprobar_grupo patah on', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(await handleCommand({ text: '/aprobar_grupo', sender: 'a@lid', role: 'admin' }, deps), /patah@g\.us/);
});

// ─── /confirmaciones (toggle unificado grupo + DM global, admin-only) ─────────

function confirmacionesDeps() {
  const state = { dm: false, approval: {} };
  return {
    _state: state,
    isDmApprovalOn: () => state.dm,
    setDmApproval: (on) => { state.dm = !!on; return 1; },
    listGroups: async () => [
      { id: 'auto@g.us', name: 'Automatizaciones' },
      { id: 'vol@g.us', name: 'Volunteers' },
    ],
    isGroupAuthorized: (id) => id === 'auto@g.us' || id === 'vol@g.us',
    setGroupApproval: (id, on) => { state.approval[id] = on ? 1 : 0; return 1; },
    listApprovalGroups: () =>
      Object.entries(state.approval)
        .filter(([, v]) => v)
        .map(([group_id]) => ({ group_id, group_name: group_id })),
  };
}

test('/confirmaciones para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/confirmaciones', sender: 'b@lid', role: 'boss' }, confirmacionesDeps()), /equipo técnico/);
});

test('/confirmaciones sin args → estado (DM OFF + grupos)', async () => {
  const out = await handleCommand({ text: '/confirmaciones', sender: 'a@lid', role: 'admin' }, confirmacionesDeps());
  assert.match(out, /DM \(desconocidos\): OFF/);
  assert.match(out, /ninguno/);
});

test('/confirmaciones dm on|off cambia el toggle global y se refleja', async () => {
  const deps = confirmacionesDeps();
  assert.match(await handleCommand({ text: '/confirmaciones dm on', sender: 'a@lid', role: 'admin' }, deps), /ACTIVADA/);
  assert.equal(deps._state.dm, true);
  assert.match(await handleCommand({ text: '/confirmaciones', sender: 'a@lid', role: 'admin' }, deps), /DM \(desconocidos\): ON/);
  assert.match(await handleCommand({ text: '/confirmaciones dm off', sender: 'a@lid', role: 'admin' }, deps), /DESACTIVADA/);
  assert.equal(deps._state.dm, false);
});

test('/confirmaciones dm sin on|off → uso', async () => {
  assert.match(await handleCommand({ text: '/confirmaciones dm', sender: 'a@lid', role: 'admin' }, confirmacionesDeps()), /Uso: \/confirmaciones dm/);
});

test('/confirmaciones grupo <nombre> on|off activa/desactiva por grupo', async () => {
  const deps = confirmacionesDeps();
  assert.match(await handleCommand({ text: '/confirmaciones grupo Automatizaciones on', sender: 'a@lid', role: 'admin' }, deps), /ACTIVADA en "Automatizaciones"/);
  assert.equal(deps._state.approval['auto@g.us'], 1);
  assert.match(await handleCommand({ text: '/confirmaciones grupo Automatizaciones off', sender: 'a@lid', role: 'admin' }, deps), /DESACTIVADA en "Automatizaciones"/);
  assert.equal(deps._state.approval['auto@g.us'], 0);
});

test('/confirmaciones grupo inexistente → no encontrado', async () => {
  assert.match(await handleCommand({ text: '/confirmaciones grupo nada on', sender: 'a@lid', role: 'admin' }, confirmacionesDeps()), /No encontré/);
});

test('alias /aprobar_grupo sigue funcionando (comparte lógica)', async () => {
  const deps = confirmacionesDeps();
  assert.match(await handleCommand({ text: '/aprobar_grupo Volunteers on', sender: 'a@lid', role: 'admin' }, deps), /ACTIVADA en "Volunteers"/);
  assert.equal(deps._state.approval['vol@g.us'], 1);
});

// ─── /respuestas (respuestas de grupo pendientes, admin-only) ─────────────────

function respuestasDeps() {
  const state = {
    replies: [
      { id: 9, group_id: 'g@g.us', group_name: 'Patah', trigger_sender: 'Pedro', trigger_text: 'a qué hora?', draft: 'A las 6:30pm', status: 'pending' },
      { id: 10, group_id: 'g@g.us', group_name: 'Patah', trigger_sender: 'Ana', trigger_text: 'gracias', draft: 'Con gusto', status: 'sent' },
    ],
  };
  return {
    _state: state,
    listPendingReplies: () => state.replies.filter((r) => r.status === 'pending'),
    getPendingReply: (id) => state.replies.find((r) => r.id === id) || null,
    approvePendingReply: (id) => {
      const r = state.replies.find((x) => x.id === id && x.status === 'pending');
      if (!r) return 0;
      r.status = 'approved';
      return 1;
    },
    discardPendingReply: (id) => {
      const r = state.replies.find((x) => x.id === id && (x.status === 'pending' || x.status === 'approved'));
      if (!r) return 0;
      r.status = 'discarded';
      return 1;
    },
  };
}

test('/respuestas para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/respuestas', sender: 'b@lid', role: 'boss' }, respuestasDeps()), /equipo técnico/);
});

test('/respuestas (admin) lista las pendientes', async () => {
  const out = await handleCommand({ text: '/respuestas', sender: 'a@lid', role: 'admin' }, respuestasDeps());
  assert.match(out, /#9 → Patah \(Pedro\)/);
  assert.doesNotMatch(out, /#10/); // la 'sent' no aparece
});

test('/respuestas aprobar/rechazar; ya-enviada no se descarta', async () => {
  const deps = respuestasDeps();
  assert.match(await handleCommand({ text: '/respuestas aprobar 9', sender: 'a@lid', role: 'admin' }, deps), /aprobada ✅/);
  assert.equal(deps._state.replies[0].status, 'approved');
  assert.match(await handleCommand({ text: '/respuestas rechazar 10', sender: 'a@lid', role: 'admin' }, deps), /no se puede descartar/);
  assert.match(await handleCommand({ text: '/respuestas aprobar abc', sender: 'a@lid', role: 'admin' }, deps), /Uso:/);
});

// ─── /tareas (órdenes del jefe capturadas, admin-only) ────────────────────────

function tareasDeps() {
  const state = {
    tasks: [
      { id: 1, request: 'súbeme esto a una hoja nueva', detail: 'col A: fechas', created_by: 'jefe@lid', status: 'pending' },
      { id: 2, request: 'ya hecha', detail: null, created_by: 'jefe@lid', status: 'done' },
    ],
    sent: [],
  };
  return {
    _state: state,
    listPendingTasks: () => state.tasks.filter((t) => t.status === 'pending'),
    getTask: (id) => state.tasks.find((t) => t.id === id) || null,
    setTaskStatus: (id, status) => {
      const t = state.tasks.find((x) => x.id === id && x.status === 'pending');
      if (!t) return 0;
      t.status = status;
      return 1;
    },
    sendMessage: async (to, text) => { state.sent.push([to, text]); },
  };
}

test('/tareas para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/tareas', sender: 'b@lid', role: 'boss' }, tareasDeps()), /equipo técnico/);
  assert.match(await handleCommand({ text: '/tareas', sender: 'u@lid', role: 'unknown' }, tareasDeps()), /equipo técnico/);
});

test('/tareas (admin) lista solo las pendientes', async () => {
  const out = await handleCommand({ text: '/tareas', sender: 'a@lid', role: 'admin' }, tareasDeps());
  assert.match(out, /#1 →/);
  assert.match(out, /hoja nueva/);
  assert.doesNotMatch(out, /#2/); // la 'done' no aparece
});

test('/tareas ver <id> muestra el detalle', async () => {
  const out = await handleCommand({ text: '/tareas ver 1', sender: 'a@lid', role: 'admin' }, tareasDeps());
  assert.match(out, /Tarea #1/);
  assert.match(out, /col A: fechas/);
  assert.match(out, /jefe@lid/);
});

test('/tareas hecha <id> cierra y avisa al solicitante', async () => {
  const deps = tareasDeps();
  const out = await handleCommand({ text: '/tareas hecha 1', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /hecha ✅/);
  assert.equal(deps._state.tasks[0].status, 'done');
  assert.equal(deps._state.sent.length, 1);
  assert.equal(deps._state.sent[0][0], 'jefe@lid'); // avisó al que la pidió
  assert.match(deps._state.sent[0][1], /Listo lo que pediste/);
});

test('/tareas hecha sobre una ya cerrada no reavisa', async () => {
  const deps = tareasDeps();
  const out = await handleCommand({ text: '/tareas hecha 2', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /ya no está pendiente/);
  assert.equal(deps._state.sent.length, 0);
});

test('/tareas descartar <id> cierra sin avisar', async () => {
  const deps = tareasDeps();
  const out = await handleCommand({ text: '/tareas descartar 1', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /descartada 🗑️/);
  assert.equal(deps._state.tasks[0].status, 'dismissed');
  assert.equal(deps._state.sent.length, 0);
});

test('/tareas ver con id inválido → uso', async () => {
  assert.match(await handleCommand({ text: '/tareas ver abc', sender: 'a@lid', role: 'admin' }, tareasDeps()), /Uso:/);
});
