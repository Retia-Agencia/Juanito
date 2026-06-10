// test/commands.test.js
// Cubre handleCommand: /whoami (cualquiera) y /status (solo admin).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { handleCommand } = await import('../src/bot/commands.js');

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
