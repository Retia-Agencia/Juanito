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

// Pablo Lozano: UNA identidad (30x). Sebastian Rodriguez: DOS (30x + retia) con TELÉFONOS
// distintos — motiva la desambiguación por cuenta; `+570000000000` (retia de Sebas) simula una
// identidad SIN opt-in para probar el desglose parcial. Sebastian Salazar: DOS identidades con el
// MISMO teléfono (30x + retia desde una línea) — el caso que exige que el pause sea por EMAIL, no
// por teléfono, para apagar un programa sin el otro.
const IDENTITIES = {
  'pablo lozano': [
    { email: 'pablo.lozano@30x.com', name: 'Pablo Lozano', phone: '+573046131437', account: '30x', accountLabel: '30X / EstadoX' },
  ],
  'sebastian rodriguez': [
    { email: 'sebastian@30x.com', name: 'Sebastian Rodriguez', phone: '+573102212005', account: '30x', accountLabel: '30X / EstadoX' },
    { email: 'sebasrr321@gmail.com', name: 'Sebastian Rodriguez', phone: '+570000000000', account: 'retia', accountLabel: 'Retia' },
  ],
  'sebastian salazar': [
    { email: 'sebastian.salazar@30x.com', name: 'Sebastian Salazar', phone: '+573054312905', account: '30x', accountLabel: '30X / EstadoX' },
    { email: 'equipo@ttrading.co', name: 'Sebastian Salazar', phone: '+573054312905', account: 'retia', accountLabel: 'Retia' },
  ],
};
// Con opt-in registrado (por teléfono). +570000000000 (retia de Sebas Rodriguez) NO lo tiene.
const HAS_OPTIN = new Set(['+573046131437', '+573102212005', '+573054312905']);

function calendlyDeps() {
  const state = { global: false, closers: {} }; // closers keyed por EMAIL (pause por identidad)
  const byEmail = {};
  for (const ids of Object.values(IDENTITIES)) for (const i of ids) byEmail[i.email] = i;
  return {
    _state: state,
    isCalendlyPaused: () => state.global,
    setCalendlyPaused: (v) => { state.global = !!v; },
    isOptedIn: (phone) => HAS_OPTIN.has(phone),
    setCloserPaused: (email, v) => { state.closers[email] = !!v; return 1; },
    listCloserPauses: () => Object.keys(state.closers).filter((e) => state.closers[e]),
    resolveCloser: (email) => byEmail[email] || null,
    resolveIdentitiesByName: (n) => {
      const words = String(n).toLowerCase().trim().split(/\s+/);
      return Object.entries(IDENTITIES)
        .filter(([name]) => name.split(' ').every((w) => words.includes(w)))
        .flatMap(([, ids]) => ids);
    },
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

test('/calendly off <closer> de identidad única pausa esa identidad (nombra la cuenta)', async () => {
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly off Pablo Lozano', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Pushes de Pablo Lozano · 30X \/ EstadoX \(30x\): PAUSADOS ⏸️/);
  assert.equal(deps._state.closers['pablo.lozano@30x.com'], true);
});

test('/calendly off <closer> con 1+ identidades → lista y pide desambiguar (no pausa nada)', async () => {
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly off Sebastian Rodriguez', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /tiene 2 identidades/);
  assert.match(out, /30x — 30X \/ EstadoX/);
  assert.match(out, /retia — Retia/);
  assert.match(out, /\/calendly off Sebastian Rodriguez <cuenta>/);
  assert.match(out, /\/calendly off Sebastian Rodriguez todo/);
  // No tocó ninguna fila: sigue siendo ambiguo hasta que precise.
  assert.deepEqual(deps._state.closers, {});
});

test('/calendly off <closer> <cuenta> pausa SOLO esa identidad', async () => {
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly off Sebastian Rodriguez 30x', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Pushes de Sebastian Rodriguez · 30X \/ EstadoX \(30x\): PAUSADOS ⏸️/);
  assert.equal(deps._state.closers['sebastian@30x.com'], true);
  assert.equal(deps._state.closers['sebasrr321@gmail.com'], undefined); // la de retia intacta
});

test('/calendly off <closer> <cuenta> donde no cierra → lo dice, no pausa nada', async () => {
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly off Pablo Lozano retia', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /no tiene identidad en la cuenta "retia"/);
  assert.deepEqual(deps._state.closers, {});
});

test('/calendly off <closer> todo pausa TODAS las identidades (desglose parcial por opt-in)', async () => {
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly off Sebastian Rodriguez todo', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Sebastian Rodriguez — 1\/2 identidades pausadas ⏸️/);
  assert.match(out, /30x \(30X \/ EstadoX\) ✓/);
  assert.match(out, /retia \(Retia\) — sin opt-in, nada que pausar/);
  assert.equal(deps._state.closers['sebastian@30x.com'], true);
});

test('/calendly on <closer> <cuenta> reactiva esa identidad', async () => {
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly on Sebastian Rodriguez 30x', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /reactivados ▶️/);
  assert.equal(deps._state.closers['sebastian@30x.com'], false);
});

test('/calendly off <closer> <cuenta> con teléfono compartido pausa SOLO ese programa (Salazar)', async () => {
  // Salazar: 30x + retia desde el MISMO teléfono. Apagar retia NO debe apagar 30x — el pause es
  // por identidad (email), no por teléfono. Es el caso que motivó mover el pause a `settings`.
  const deps = calendlyDeps();
  const out = await handleCommand({ text: '/calendly off Sebastian Salazar retia', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Pushes de Sebastian Salazar · Retia \(retia\): PAUSADOS ⏸️/);
  assert.equal(deps._state.closers['equipo@ttrading.co'], true, 'retia pausado');
  assert.equal(deps._state.closers['sebastian.salazar@30x.com'], undefined, '30x intacto');
});

test('/calendly status muestra la identidad pausada con su cuenta (Salazar retia)', async () => {
  const deps = calendlyDeps();
  await handleCommand({ text: '/calendly off Sebastian Salazar retia', sender: 'a@lid', role: 'admin' }, deps);
  const out = await handleCommand({ text: '/calendly', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Closers pausados: Sebastian Salazar \(retia\)/);
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
      { id: 3, group_id: 'p@g.us', group_name: 'Patah San Juan de Ávila ✝️', days: '0,4', time_hm: '20:00', text: 'Muchachos, ¡los esperamos hoy en la reunión!', active: 1, kind: 'fixed' },
      { id: 4, group_id: 'p@g.us', group_name: 'Patah San Juan de Ávila ✝️', days: '1,2,3,4,5', time_hm: '09:00', text: '', active: 1, kind: 'generated', brief: 'San José' },
    ],
    settings: {},
  };
  return {
    _state: state,
    listScheduledMessages: ({ activeOnly = true } = {}) =>
      activeOnly ? state.rows.filter((r) => r.active) : state.rows,
    cancelScheduledMessage: (id) => {
      const row = state.rows.find((r) => r.id === id && r.active);
      if (!row) return 0;
      row.active = 0;
      return 1;
    },
    reactivateScheduledMessage: (id) => {
      const row = state.rows.find((r) => r.id === id && !r.active);
      if (!row) return 0;
      row.active = 1;
      return 1;
    },
    findScheduledDuplicate: ({ groupId, days, timeHm }) =>
      state.rows.find((r) => r.active && r.group_id === groupId && r.days === days && r.time_hm === timeHm) || null,
    getSetting: (k, def) => state.settings[k] ?? def,
    setSetting: (k, v) => {
      state.settings[k] = v;
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

test('/programados auto <id> on prende el auto-envío del generado y se ve en la lista', async () => {
  const deps = programadosDeps();
  const out = await handleCommand({ text: '/programados auto 4 on', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /Auto-envío ACTIVADO para #4/);
  assert.equal(deps._state.settings['auto_publish:4'], '1');
  assert.match(await handleCommand({ text: '/programados', sender: 'a@lid', role: 'admin' }, deps), /auto-envío ON/);

  await handleCommand({ text: '/programados auto 4 off', sender: 'a@lid', role: 'admin' }, deps);
  assert.equal(deps._state.settings['auto_publish:4'], '0');
  assert.match(await handleCommand({ text: '/programados', sender: 'a@lid', role: 'admin' }, deps), /pide aprobación/);
});

// §18.BS·3 — en un 'generated' el `text` está vacío: lo que distingue una fila de otra es el
// brief. Mostrar "" fue lo que hizo indistinguibles a #5 y #8 durante 11 semanas.
test('/programados muestra el BRIEF de un generado, no su texto vacío', async () => {
  const out = await handleCommand({ text: '/programados', sender: 'a@lid', role: 'admin' }, programadosDeps());
  assert.match(out, /📋 San José/, 'el brief se ve');
  assert.doesNotMatch(out, /^\s+""$/m, 'no imprime comillas vacías');
  assert.match(out, /los esperamos hoy/, 'el fijo sigue mostrando su texto');
});

test('/programados sin brief lo dice en vez de imprimir vacío', async () => {
  const deps = programadosDeps();
  deps._state.rows.find((r) => r.id === 4).brief = null;
  assert.match(await handleCommand({ text: '/programados', sender: 'a@lid', role: 'admin' }, deps), /\(sin brief\)/);
});

// §18.BS·4 — `off` era de una sola vía: recuperar una fila apagada exigía entrar a la DB del VPS.
test('/programados on <id> reactiva una fila apagada y la lista la muestra como apagada antes', async () => {
  const deps = programadosDeps();
  await handleCommand({ text: '/programados off 4', sender: 'a@lid', role: 'admin' }, deps);

  const lista = await handleCommand({ text: '/programados', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(lista, /💤 Apagados \(1\)/, 'el id apagado es descubrible sin bajar a la DB');
  assert.match(lista, /#4 →.*San José/s);

  const out = await handleCommand({ text: '/programados on 4', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /#4 reactivado ✅/);
  assert.equal(deps._state.rows.find((r) => r.id === 4).active, 1);
});

test('/programados on rechaza id inexistente, fila ya activa y uso mal escrito', async () => {
  const deps = programadosDeps();
  assert.match(await handleCommand({ text: '/programados on 99', sender: 'a@lid', role: 'admin' }, deps), /No hay ningún/);
  assert.match(await handleCommand({ text: '/programados on 4', sender: 'a@lid', role: 'admin' }, deps), /No hay ningún/, 'ya está activa');
  assert.match(await handleCommand({ text: '/programados on abc', sender: 'a@lid', role: 'admin' }, deps), /Uso:/);
});

// La pared que falta: el guardia anti-duplicado de `create` (§18.BT) solo mira las ACTIVAS, así
// que reactivar una fila apagada podía reconstruir el duplicado de 11 semanas.
test('/programados on NO reactiva si choca con una activa del mismo grupo, días y hora', async () => {
  const deps = programadosDeps();
  await handleCommand({ text: '/programados off 4', sender: 'a@lid', role: 'admin' }, deps);
  // Nace una fila nueva ocupando exactamente ese hueco.
  deps._state.rows.push({ id: 9, group_id: 'p@g.us', group_name: 'Patah San Juan de Ávila ✝️', days: '1,2,3,4,5', time_hm: '09:00', text: '', active: 1, kind: 'generated', brief: 'otro' });

  const out = await handleCommand({ text: '/programados on 4', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /el #9 ya está activo/);
  assert.equal(deps._state.rows.find((r) => r.id === 4).active, 0, 'sigue apagada');
});

test('/programados auto rechaza id inexistente, fila fija y uso mal escrito', async () => {
  const deps = programadosDeps();
  assert.match(await handleCommand({ text: '/programados auto 99 on', sender: 'a@lid', role: 'admin' }, deps), /No hay ningún/);
  assert.match(await handleCommand({ text: '/programados auto 3 on', sender: 'a@lid', role: 'admin' }, deps), /texto fijo/);
  assert.match(await handleCommand({ text: '/programados auto 4', sender: 'a@lid', role: 'admin' }, deps), /Uso:/);
  assert.match(await handleCommand({ text: '/programados auto 4 quizas', sender: 'a@lid', role: 'admin' }, deps), /Uso:/);
  assert.deepEqual(deps._state.settings, {}, 'nada se guardó');
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

// ─── /negocio (contexto del negocio, Fase 2, admin-only) ──────────────────────

function negocioDeps() {
  const state = {
    facts: [
      { id: 1, topic: 'closers', fact: 'Sebas cierra anuales', status: 'active' },
      { id: 2, topic: 'proceso', fact: 'cierre a 1 llamada', status: 'active' },
      { id: 3, topic: 'productos', fact: 'plan PRO extraído de un chat', status: 'proposed' },
    ],
  };
  return {
    _state: state,
    listBusinessContext: () => state.facts.filter((f) => f.status === 'active'),
    listProposedBusinessFacts: () => state.facts.filter((f) => f.status === 'proposed'),
    getBusinessFact: (id) => state.facts.find((f) => f.id === id) || null,
    setBusinessFactStatus: (id, status) => {
      const f = state.facts.find((x) => x.id === id);
      if (!f || f.status === status) return 0;
      f.status = status;
      return 1;
    },
  };
}

test('/negocio para no-admin → deflexión', async () => {
  assert.match(await handleCommand({ text: '/negocio', sender: 'b@lid', role: 'boss' }, negocioDeps()), /equipo técnico/);
});

test('/negocio (admin) lista los hechos activos por categoría', async () => {
  const out = await handleCommand({ text: '/negocio', sender: 'a@lid', role: 'admin' }, negocioDeps());
  assert.match(out, /Sebas cierra anuales/);
  assert.match(out, /cierre a 1 llamada/);
  assert.doesNotMatch(out, /extraído de un chat/); // los proposed no salen en el list activo
});

test('/negocio pendientes lista los propuestos', async () => {
  const out = await handleCommand({ text: '/negocio pendientes', sender: 'a@lid', role: 'admin' }, negocioDeps());
  assert.match(out, /plan PRO extraído de un chat/);
  assert.doesNotMatch(out, /Sebas cierra anuales/); // los activos no salen en pendientes
});

test('/negocio ok <id> confirma un propuesto → activo', async () => {
  const deps = negocioDeps();
  const out = await handleCommand({ text: '/negocio ok 3', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /confirmado ✅/);
  assert.equal(deps._state.facts.find((f) => f.id === 3).status, 'active');
});

test('/negocio no <id> descarta un propuesto', async () => {
  const deps = negocioDeps();
  const out = await handleCommand({ text: '/negocio no 3', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /descartado 🗑️/);
  assert.equal(deps._state.facts.find((f) => f.id === 3).status, 'archived');
});

test('/negocio olvida <id> archiva un activo', async () => {
  const deps = negocioDeps();
  const out = await handleCommand({ text: '/negocio olvida 1', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /archivado/);
  assert.equal(deps._state.facts.find((f) => f.id === 1).status, 'archived');
});

test('/negocio ok sobre un id ya activo no cambia nada', async () => {
  const deps = negocioDeps();
  const out = await handleCommand({ text: '/negocio ok 1', sender: 'a@lid', role: 'admin' }, deps);
  assert.match(out, /ya estaba en ese estado/);
});

test('/negocio ok con id inválido → uso', async () => {
  assert.match(await handleCommand({ text: '/negocio ok abc', sender: 'a@lid', role: 'admin' }, negocioDeps()), /Uso:/);
});
