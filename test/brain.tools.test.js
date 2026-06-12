// test/brain.tools.test.js
// Tests de dispatch de herramientas (Track B), con db/contacts/openwa mockeados
// según el contrato del Track A. Runner nativo: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool } from '../src/claude/index.js';

const BOSS = '573001112233';
const ctx = { createdBy: BOSS };

// Construye un set de deps mock que registra las llamadas recibidas.
function makeDeps(overrides = {}) {
  const calls = {};
  const rec = (name) => (...args) => {
    (calls[name] ||= []).push(args);
    return overrides[`${name}Return`];
  };
  const deps = {
    calls,
    resolveContact: overrides.resolveContact || rec('resolveContact'),
    saveReminder: rec('saveReminder'),
    setMemory: rec('setMemory'),
    resolveGroupByName: overrides.resolveGroupByName || rec('resolveGroupByName'),
    getRecentMessages: overrides.getRecentMessages || rec('getRecentMessages'),
    summarizeGroupMessages: overrides.summarizeGroupMessages || rec('summarizeGroupMessages'),
    saveSummary: rec('saveSummary'),
    searchMessages: overrides.searchMessages || rec('searchMessages'),
    searchMemory: overrides.searchMemory || rec('searchMemory'),
    searchSummaries: overrides.searchSummaries || rec('searchSummaries'),
  };
  return deps;
}

// ─── create_reminder ──────────────────────────────────────────────────────────

test('create_reminder con recipient resuelto guarda con toPhone del contacto', async () => {
  const deps = makeDeps({
    resolveContact: async () => ({ name: 'Ana', phone: '573009998877' }),
  });

  const result = await dispatchTool(
    {
      name: 'create_reminder',
      input: { text: 'enviar la factura', due_at: '2026-06-04 10:00:00', recipient: 'Ana' },
    },
    deps,
    ctx
  );

  assert.equal(deps.calls.saveReminder.length, 1);
  const arg = deps.calls.saveReminder[0][0];
  assert.deepEqual(arg, {
    text: 'enviar la factura',
    dueAt: '2026-06-04 10:00:00',
    toPhone: '573009998877',
    createdBy: BOSS,
  });
  assert.match(result, /Ana/);
});

test('create_reminder con recipient NO resuelto no guarda y pide aclaración', async () => {
  const deps = makeDeps({ resolveContact: async () => null });

  const result = await dispatchTool(
    {
      name: 'create_reminder',
      input: { text: 'llamar', due_at: '2026-06-04 10:00:00', recipient: 'Zzz' },
    },
    deps,
    ctx
  );

  assert.equal(deps.calls.saveReminder, undefined); // no se guardó
  assert.match(result, /no encontré|aclar|exacto/i);
});

test('create_reminder sin recipient usa al jefe (createdBy) como destino', async () => {
  const deps = makeDeps();

  await dispatchTool(
    { name: 'create_reminder', input: { text: 'pagar arriendo', due_at: '2026-06-05 09:00:00' } },
    deps,
    ctx
  );

  const arg = deps.calls.saveReminder[0][0];
  assert.equal(arg.toPhone, BOSS);
  assert.equal(arg.createdBy, BOSS);
  assert.equal(deps.calls.resolveContact, undefined); // no se intentó resolver contacto
});

// ─── summarize_group ──────────────────────────────────────────────────────────

test('summarize_group resuelve grupo, resume y persiste con saveSummary', async () => {
  const deps = makeDeps({
    resolveGroupByName: async () => ({ id: '12345@g.us', name: 'Proveedores' }),
    getRecentMessages: async () => [
      { body: 'llega el pedido el martes', sender: { pushname: 'Luis' } },
      { body: 'ok confirmado', sender: { id: '57300@c.us' } },
    ],
    summarizeGroupMessages: async () => 'El pedido llega el martes; confirmado.',
  });

  const result = await dispatchTool(
    { name: 'summarize_group', input: { group_name: 'proveedores', period: 'hoy' } },
    deps,
    ctx
  );

  assert.equal(deps.calls.saveSummary.length, 1);
  const arg = deps.calls.saveSummary[0][0];
  assert.equal(arg.chatId, '12345@g.us');
  assert.equal(arg.chatName, 'Proveedores');
  assert.equal(arg.summary, 'El pedido llega el martes; confirmado.');
  assert.ok(arg.periodStart && arg.periodEnd, 'incluye período');
  assert.match(result, /Proveedores/);
});

test('summarize_group con grupo inexistente pide aclaración y no persiste', async () => {
  const deps = makeDeps({ resolveGroupByName: async () => null });

  const result = await dispatchTool(
    { name: 'summarize_group', input: { group_name: 'fantasma' } },
    deps,
    ctx
  );

  assert.equal(deps.calls.saveSummary, undefined);
  assert.match(result, /no encontré|exacto/i);
});

// ─── search_knowledge ─────────────────────────────────────────────────────────

test('search_knowledge consulta las tres fuentes y arma el resultado', async () => {
  const deps = makeDeps({
    searchMessages: () => [{ role: 'user', content: 'hablamos del contrato' }],
    searchMemory: () => [{ key: 'banco', value: 'Bancolombia' }],
    searchSummaries: () => [{ chat_name: 'Legal', summary: 'revisión del contrato' }],
  });

  const result = await dispatchTool(
    { name: 'search_knowledge', input: { query: 'contrato' } },
    deps,
    ctx
  );

  assert.match(result, /Bancolombia/);
  assert.match(result, /Legal/);
  assert.match(result, /contrato/);
});

test('search_knowledge sin resultados lo dice claramente', async () => {
  const deps = makeDeps({
    searchMessages: () => [],
    searchMemory: () => [],
    searchSummaries: () => [],
  });

  const result = await dispatchTool(
    { name: 'search_knowledge', input: { query: 'nada' } },
    deps,
    ctx
  );

  assert.match(result, /no encontré/i);
});

// ─── save_memory ──────────────────────────────────────────────────────────────

test('save_memory persiste key/value', async () => {
  const deps = makeDeps();

  await dispatchTool(
    { name: 'save_memory', input: { key: 'numero_cuenta', value: '1234567' } },
    deps,
    ctx
  );

  assert.deepEqual(deps.calls.setMemory[0], ['numero_cuenta', '1234567']);
});

test('save_memory con rol jefe (no admin) NO persiste (baby-proofing)', async () => {
  const deps = makeDeps();

  const result = await dispatchTool(
    { name: 'save_memory', input: { key: 'x', value: 'y' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );

  assert.equal(deps.calls.setMemory, undefined); // nunca tocó la memoria
  assert.match(result, /equipo/i); // deflecta con naturalidad
});

test('save_memory con rol admin sí persiste', async () => {
  const deps = makeDeps();

  await dispatchTool(
    { name: 'save_memory', input: { key: 'k', value: 'v' } },
    deps,
    { createdBy: BOSS, role: 'admin' }
  );

  assert.deepEqual(deps.calls.setMemory[0], ['k', 'v']);
});

test('remember_note (jefe) guarda en namespace sandboxed boss_note:<label>', async () => {
  const deps = makeDeps();

  const result = await dispatchTool(
    { name: 'remember_note', input: { note: 'café sin azúcar', label: 'Café Favorito' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );

  const [key, value] = deps.calls.setMemory[0];
  assert.equal(key, 'boss_note:cafe_favorito'); // slug del label
  assert.equal(value, 'café sin azúcar');
  assert.match(result, /anotado/i);
});

test('remember_note sin label usa una key con prefijo boss_note:', async () => {
  const deps = makeDeps();

  await dispatchTool(
    { name: 'remember_note', input: { note: 'odia los lunes' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );

  const [key, value] = deps.calls.setMemory[0];
  assert.ok(key.startsWith('boss_note:'));
  assert.equal(value, 'odia los lunes');
});

// ─── schedule_group_message (mensajes recurrentes a grupos) ───────────────────

function scheduleDeps({ authorized = true } = {}) {
  const state = { created: [], canceled: [] };
  return {
    _state: state,
    resolveGroupByName: async (name) =>
      /patah/i.test(name || '') ? { id: 'patah@g.us', name: 'Patah San Juan de Ávila ✝️' } : null,
    isGroupAuthorized: () => authorized,
    createScheduledMessage: (row) => {
      state.created.push(row);
      return 7;
    },
    listScheduledMessages: () => [
      { id: 7, group_id: 'patah@g.us', group_name: 'Patah San Juan de Ávila ✝️', days: '0,4', time_hm: '20:00', text: 'Muchachos, ¡reunión hoy!', last_sent_date: null },
    ],
    cancelScheduledMessage: (id) => {
      state.canceled.push(id);
      return id === 7 ? 1 : 0;
    },
  };
}

test('schedule_group_message create: valida, normaliza y guarda el texto EXACTO', async () => {
  const deps = scheduleDeps();
  const result = await dispatchTool(
    {
      name: 'schedule_group_message',
      input: {
        action: 'create',
        group_name: 'patah',
        days: ['jueves', 'domingo'],
        time: '20:00',
        text: 'Muchachos, ¡los esperamos hoy a las 8pm en la reunión! 🙏',
      },
    },
    deps,
    ctx
  );
  assert.equal(deps._state.created.length, 1);
  const row = deps._state.created[0];
  assert.equal(row.groupId, 'patah@g.us');
  assert.equal(row.days, '0,4');
  assert.equal(row.timeHm, '20:00');
  assert.equal(row.text, 'Muchachos, ¡los esperamos hoy a las 8pm en la reunión! 🙏');
  assert.equal(row.createdBy, BOSS);
  assert.match(result, /#7/);
  assert.match(result, /domingo y jueves a las 20:00/);
});

test('schedule_group_message create: grupo no encontrado → no guarda', async () => {
  const deps = scheduleDeps();
  const result = await dispatchTool(
    { name: 'schedule_group_message', input: { action: 'create', group_name: 'inexistente', days: ['jueves'], time: '20:00', text: 'x' } },
    deps,
    ctx
  );
  assert.match(result, /No encontré ningún grupo/);
  assert.equal(deps._state.created.length, 0);
});

test('schedule_group_message create: grupo NO autorizado → rechaza (default-deny)', async () => {
  const deps = scheduleDeps({ authorized: false });
  const result = await dispatchTool(
    { name: 'schedule_group_message', input: { action: 'create', group_name: 'patah', days: ['jueves'], time: '20:00', text: 'x' } },
    deps,
    ctx
  );
  assert.match(result, /no está autorizado/);
  assert.equal(deps._state.created.length, 0);
});

test('schedule_group_message create: días/hora/texto inválidos → pide corrección, no guarda', async () => {
  const deps = scheduleDeps();
  assert.match(
    await dispatchTool({ name: 'schedule_group_message', input: { action: 'create', group_name: 'patah', days: ['navidad'], time: '20:00', text: 'x' } }, deps, ctx),
    /No entendí los días/
  );
  assert.match(
    await dispatchTool({ name: 'schedule_group_message', input: { action: 'create', group_name: 'patah', days: ['jueves'], time: '8pm', text: 'x' } }, deps, ctx),
    /No entendí la hora/
  );
  assert.match(
    await dispatchTool({ name: 'schedule_group_message', input: { action: 'create', group_name: 'patah', days: ['jueves'], time: '20:00', text: '  ' } }, deps, ctx),
    /falta el texto/
  );
  assert.equal(deps._state.created.length, 0);
});

test('schedule_group_message list y cancel', async () => {
  const deps = scheduleDeps();
  const list = await dispatchTool({ name: 'schedule_group_message', input: { action: 'list' } }, deps, ctx);
  assert.match(list, /#7/);
  assert.match(list, /domingo y jueves a las 20:00/);

  const ok = await dispatchTool({ name: 'schedule_group_message', input: { action: 'cancel', id: 7 } }, deps, ctx);
  assert.match(ok, /#7 cancelado/);
  const noId = await dispatchTool({ name: 'schedule_group_message', input: { action: 'cancel' } }, deps, ctx);
  assert.match(noId, /necesito el id/);
});

test('schedule_group_message: gateo — disponible en DM (boss y admin), NUNCA en grupos', async () => {
  const { toolsForRole } = await import('../src/claude/index.js');
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(names(toolsForRole('boss')).includes('schedule_group_message'), 'boss en DM sí');
  assert.ok(names(toolsForRole('admin')).includes('schedule_group_message'), 'admin en DM sí');
  assert.ok(!names(toolsForRole('boss', { isGroup: true })).includes('schedule_group_message'), 'en grupo no');
  assert.ok(!names(toolsForRole('unknown', { isGroup: true })).includes('schedule_group_message'), 'en grupo no (unknown)');
});
