// test/brain.tools.test.js
// Tests de dispatch de herramientas (Track B), con db/contacts/openwa mockeados
// según el contrato del Track A. Runner nativo: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool, parseBusinessFacts } from '../src/claude/index.js';

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
    isGroupAuthorized: overrides.isGroupAuthorized || (async () => true),
    getRecentMessages: overrides.getRecentMessages || rec('getRecentMessages'),
    summarizeGroupMessages: overrides.summarizeGroupMessages || rec('summarizeGroupMessages'),
    saveSummary: rec('saveSummary'),
    searchMessages: overrides.searchMessages || rec('searchMessages'),
    searchMemory: overrides.searchMemory || rec('searchMemory'),
    searchSummaries: overrides.searchSummaries || rec('searchSummaries'),
    createTask: rec('createTask'),
    approvalsTarget: overrides.approvalsTarget || (async () => 'team@g.us'),
    sendMessage: rec('sendMessage'),
    createBusinessFact: rec('createBusinessFact'),
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

test('create_reminder con fecha mal formada NO guarda y pide la fecha exacta', async () => {
  const deps = makeDeps();
  const result = await dispatchTool(
    { name: 'create_reminder', input: { text: 'pagar', due_at: 'mañana 3pm' } },
    deps,
    ctx
  );
  assert.equal(deps.calls.saveReminder, undefined); // no se guardó basura que nunca dispararía
  assert.match(result, /YYYY-MM-DD|fecha y hora exact/i);
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

// ─── create_reminder → grupo (recordatorios únicos a un grupo, §18.Q) ──────────

test('create_reminder con group_name resuelto y autorizado guarda con toGroup', async () => {
  const deps = makeDeps({
    resolveGroupByName: async () => ({ id: '12345@g.us', name: 'Patah' }),
  });

  const result = await dispatchTool(
    {
      name: 'create_reminder',
      input: { text: 'tenemos misa', due_at: '2026-06-21 17:00:00', group_name: 'Patah' },
    },
    deps,
    ctx
  );

  assert.equal(deps.calls.saveReminder.length, 1);
  const arg = deps.calls.saveReminder[0][0];
  assert.equal(arg.toGroup, '12345@g.us');
  assert.equal(arg.toGroupName, 'Patah');
  assert.equal(arg.createdBy, BOSS);
  assert.equal(arg.toPhone, undefined); // no es a una persona
  assert.match(result, /Patah/);
});

test('create_reminder con "aquí" dentro de un grupo usa el grupo actual', async () => {
  const deps = makeDeps({
    // si cayera en resolveGroupByName fallaría el test (debe usar ctx.currentGroupId)
    resolveGroupByName: async () => null,
  });

  await dispatchTool(
    {
      name: 'create_reminder',
      input: { text: 'reunión 6:30pm', due_at: '2026-06-21 18:00:00', group_name: 'aquí' },
    },
    deps,
    { createdBy: BOSS, currentGroupId: '999@g.us', currentGroupName: 'Closers' }
  );

  const arg = deps.calls.saveReminder[0][0];
  assert.equal(arg.toGroup, '999@g.us');
  assert.equal(arg.toGroupName, 'Closers');
});

test('create_reminder a grupo NO autorizado no guarda y pide habilitarlo', async () => {
  const deps = makeDeps({
    resolveGroupByName: async () => ({ id: '12345@g.us', name: 'Random' }),
    isGroupAuthorized: async () => false,
  });

  const result = await dispatchTool(
    {
      name: 'create_reminder',
      input: { text: 'algo', due_at: '2026-06-21 17:00:00', group_name: 'Random' },
    },
    deps,
    ctx
  );

  assert.equal(deps.calls.saveReminder, undefined); // no se guardó
  assert.match(result, /no está autorizado|habilit/i);
});

test('create_reminder a grupo NO resuelto no guarda y pide el nombre exacto', async () => {
  const deps = makeDeps({ resolveGroupByName: async () => null });

  const result = await dispatchTool(
    {
      name: 'create_reminder',
      input: { text: 'algo', due_at: '2026-06-21 17:00:00', group_name: 'Zzz' },
    },
    deps,
    ctx
  );

  assert.equal(deps.calls.saveReminder, undefined); // no se guardó
  assert.match(result, /no encontré|exacto/i);
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

  // save_memory → memoria del SISTEMA: owner_lid = null (3er arg) para que la vean todos.
  assert.deepEqual(deps.calls.setMemory[0], ['numero_cuenta', '1234567', null]);
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

  assert.deepEqual(deps.calls.setMemory[0], ['k', 'v', null]);
});

test('remember_note (jefe) guarda nota PERSONAL: key namespaced por LID + owner_lid', async () => {
  const deps = makeDeps();

  const result = await dispatchTool(
    { name: 'remember_note', input: { note: 'café sin azúcar', label: 'Café Favorito' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );

  const [key, value, ownerLid] = deps.calls.setMemory[0];
  assert.equal(key, `boss_note:${BOSS}:cafe_favorito`); // LID + slug del label
  assert.equal(value, 'café sin azúcar');
  assert.equal(ownerLid, BOSS); // dueño = quien la pidió → filtro de carga (§18 1B)
  assert.match(result, /anotado/i);
});

test('remember_note sin label usa una key con prefijo boss_note:<lid>:', async () => {
  const deps = makeDeps();

  await dispatchTool(
    { name: 'remember_note', input: { note: 'odia los lunes' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );

  const [key, value, ownerLid] = deps.calls.setMemory[0];
  assert.ok(key.startsWith(`boss_note:${BOSS}:`));
  assert.equal(value, 'odia los lunes');
  assert.equal(ownerLid, BOSS);
});

// ─── Aislamiento de memoria personal por LID (§18 1B) ─────────────────────────
// El bug que originó esto: un admin dijo "me llamo Alejandro" y se filtró al contexto del jefe.

test('memoria personal: la nota de un admin queda con SU LID, no el del jefe', async () => {
  const ADMIN = '573009998877';
  const deps = makeDeps();

  await dispatchTool(
    { name: 'remember_note', input: { note: 'me llamo Alejandro', label: 'nombre' } },
    deps,
    { createdBy: ADMIN, role: 'admin' }
  );

  const [key, , ownerLid] = deps.calls.setMemory[0];
  assert.equal(ownerLid, ADMIN); // dueño = el admin, NO el jefe
  assert.ok(key.startsWith(`boss_note:${ADMIN}:`));
  assert.notEqual(ownerLid, BOSS); // nunca se atribuye al jefe
});

test('search_knowledge pasa el LID del que habla a searchMemory (no ve notas ajenas)', async () => {
  const seen = [];
  const deps = makeDeps({ searchMemory: (q, owner) => { seen.push([q, owner]); return []; } });

  await dispatchTool(
    { name: 'search_knowledge', input: { query: 'cuenta' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ['cuenta', BOSS]); // filtra por el LID del interlocutor
});

// ─── capture_task (órdenes libres del jefe que ninguna tool ejecuta) ──────────

test('capture_task (jefe) guarda la orden y avisa al equipo', async () => {
  const deps = makeDeps();

  const result = await dispatchTool(
    { name: 'capture_task', input: { request: 'súbeme esto a una hoja nueva', detail: 'col A: fechas' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );

  assert.equal(deps.calls.createTask.length, 1);
  assert.deepEqual(deps.calls.createTask[0][0], {
    request: 'súbeme esto a una hoja nueva',
    detail: 'col A: fechas',
    createdBy: BOSS,
  });
  // avisó al destino de aprobaciones (no al jefe)
  assert.equal(deps.calls.sendMessage.length, 1);
  assert.equal(deps.calls.sendMessage[0][0], 'team@g.us');
  assert.match(deps.calls.sendMessage[0][1], /El jefe pidió|\/tareas/);
  assert.match(result, /equipo/i); // confirma al jefe con naturalidad
});

test('capture_task (admin) también guarda la orden', async () => {
  const deps = makeDeps();
  await dispatchTool(
    { name: 'capture_task', input: { request: 'algo nuevo' } },
    deps,
    { createdBy: BOSS, role: 'admin' }
  );
  assert.equal(deps.calls.createTask.length, 1);
  assert.equal(deps.calls.createTask[0][0].detail, null); // sin detail → null
});

test('capture_task con rol no privilegiado NO guarda ni avisa (defensa en profundidad)', async () => {
  const deps = makeDeps();

  const result = await dispatchTool(
    { name: 'capture_task', input: { request: 'hazme algo' } },
    deps,
    { createdBy: 'intruso@s.whatsapp.net', role: 'unknown' }
  );

  assert.equal(deps.calls.createTask, undefined); // nunca creó la tarea
  assert.equal(deps.calls.sendMessage, undefined); // ni avisó al equipo
  assert.doesNotMatch(result, /equipo/i);
});

test('capture_task sin request no guarda y pide aclaración', async () => {
  const deps = makeDeps();
  const result = await dispatchTool(
    { name: 'capture_task', input: { request: '   ' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );
  assert.equal(deps.calls.createTask, undefined);
  assert.match(result, /\?|qué/i);
});

test('capture_task: gateo — en DM (boss y admin) sí, en grupo y publicDm NUNCA', async () => {
  const { toolsForRole } = await import('../src/claude/index.js');
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(names(toolsForRole('boss')).includes('capture_task'), 'boss en DM sí');
  assert.ok(names(toolsForRole('admin')).includes('capture_task'), 'admin en DM sí');
  assert.ok(!names(toolsForRole('boss', { isGroup: true })).includes('capture_task'), 'en grupo no');
  assert.equal(toolsForRole('unknown', { publicDm: true }).length, 0, 'publicDm sin tools');
});

// ─── remember_business (contexto del negocio, Fase 2) ─────────────────────────

test('remember_business (jefe) guarda hecho activo del negocio con topic+source', async () => {
  const deps = makeDeps();
  const result = await dispatchTool(
    { name: 'remember_business', input: { topic: 'closers', fact: 'Sebas cierra los planes anuales' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );
  assert.equal(deps.calls.createBusinessFact.length, 1);
  assert.deepEqual(deps.calls.createBusinessFact[0][0], {
    topic: 'closers',
    fact: 'Sebas cierra los planes anuales',
    status: 'active',
    source: 'taught',
    createdBy: BOSS,
  });
  assert.match(result, /negocio/i);
});

test('remember_business (admin) también guarda', async () => {
  const deps = makeDeps();
  await dispatchTool(
    { name: 'remember_business', input: { topic: 'proceso', fact: 'el cierre es a 1 llamada' } },
    deps,
    { createdBy: BOSS, role: 'admin' }
  );
  assert.equal(deps.calls.createBusinessFact.length, 1);
});

test('remember_business: topic inválido cae en "otro"', async () => {
  const deps = makeDeps();
  await dispatchTool(
    { name: 'remember_business', input: { topic: 'xyz', fact: 'algo' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );
  assert.equal(deps.calls.createBusinessFact[0][0].topic, 'otro');
});

test('remember_business con rol no privilegiado NO guarda (defensa en profundidad)', async () => {
  const deps = makeDeps();
  const result = await dispatchTool(
    { name: 'remember_business', input: { topic: 'closers', fact: 'x' } },
    deps,
    { createdBy: 'intruso@s.whatsapp.net', role: 'unknown' }
  );
  assert.equal(deps.calls.createBusinessFact, undefined);
  assert.doesNotMatch(result, /negocio/i);
});

test('remember_business sin fact no guarda y pide aclaración', async () => {
  const deps = makeDeps();
  const result = await dispatchTool(
    { name: 'remember_business', input: { topic: 'closers', fact: '  ' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );
  assert.equal(deps.calls.createBusinessFact, undefined);
  assert.match(result, /\?|qué/i);
});

test('remember_business: gateo — DM (boss/admin) sí, grupo y publicDm NO', async () => {
  const { toolsForRole } = await import('../src/claude/index.js');
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(names(toolsForRole('boss')).includes('remember_business'), 'boss DM sí');
  assert.ok(names(toolsForRole('admin')).includes('remember_business'), 'admin DM sí');
  assert.ok(!names(toolsForRole('boss', { isGroup: true })).includes('remember_business'), 'grupo no');
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

// ─── Órdenes del jefe DESDE el grupo (bossInGroup) ────────────────────────────

test('schedule_group_message create SIN group_name usa el grupo actual (ctx.currentGroupId)', async () => {
  const deps = scheduleDeps();
  const result = await dispatchTool(
    {
      name: 'schedule_group_message',
      input: { action: 'create', days: ['lunes'], time: '08:00', text: 'Buenos días equipo' },
    },
    deps,
    { createdBy: BOSS, role: 'boss', currentGroupId: 'patah@g.us', currentGroupName: 'Patah' }
  );
  assert.equal(deps._state.created.length, 1);
  assert.equal(deps._state.created[0].groupId, 'patah@g.us');
  assert.match(result, /#7/);
});

test('set_group_instructions guarda la persona de ESTE grupo (reutiliza setGroupPersona)', async () => {
  const calls = { set: [], del: [] };
  const deps = {
    setGroupPersona: (row) => calls.set.push(row),
    deleteGroupPersona: (id) => { calls.del.push(id); return 1; },
  };
  const result = await dispatchTool(
    { name: 'set_group_instructions', input: { instructions: 'Sé más formal y sin emojis.' } },
    deps,
    { createdBy: BOSS, role: 'boss', currentGroupId: 'patah@g.us', currentGroupName: 'Patah' }
  );
  assert.equal(calls.set.length, 1);
  assert.equal(calls.set[0].groupId, 'patah@g.us');
  assert.equal(calls.set[0].persona, 'Sé más formal y sin emojis.');
  assert.match(result, /Patah/);
});

test('set_group_instructions con clear=true (o vacío) borra la persona del grupo', async () => {
  const calls = { set: [], del: [] };
  const deps = {
    setGroupPersona: (row) => calls.set.push(row),
    deleteGroupPersona: (id) => { calls.del.push(id); return 1; },
  };
  await dispatchTool(
    { name: 'set_group_instructions', input: { clear: true } },
    deps,
    { createdBy: BOSS, role: 'boss', currentGroupId: 'patah@g.us', currentGroupName: 'Patah' }
  );
  assert.deepEqual(calls.del, ['patah@g.us']);
  assert.equal(calls.set.length, 0);
});

test('set_group_instructions fuera de un grupo (sin currentGroupId) no hace nada', async () => {
  const calls = { set: [], del: [] };
  const deps = {
    setGroupPersona: (row) => calls.set.push(row),
    deleteGroupPersona: (id) => { calls.del.push(id); return 1; },
  };
  const result = await dispatchTool(
    { name: 'set_group_instructions', input: { instructions: 'algo' } },
    deps,
    { createdBy: BOSS, role: 'boss' }
  );
  assert.equal(calls.set.length, 0);
  assert.match(result, /desde el propio grupo/i);
});

// ─── schedule_group_message generated + manage_drafts (aprobación) ─────────────

function draftDeps() {
  const state = {
    created: [],
    drafts: [
      { id: 5, scheduled_id: 7, publish_date: '2026-06-11', draft: 'Borrador original', status: 'pending', group_name: 'Patah', time_hm: '09:00' },
    ],
    settings: {},
  };
  return {
    _state: state,
    resolveGroupByName: async (name) => (/patah/i.test(name || '') ? { id: 'patah@g.us', name: 'Patah' } : null),
    isGroupAuthorized: () => true,
    createScheduledMessage: (row) => {
      state.created.push(row);
      return 7;
    },
    listScheduledMessages: () => [
      { id: 7, group_id: 'patah@g.us', group_name: 'Patah', days: '1,2,3,4,5,6,0', time_hm: '09:00', kind: 'generated', brief: 'San José para jóvenes' },
    ],
    listPendingDrafts: () => state.drafts.filter((d) => d.status === 'pending'),
    getDraft: (id) => state.drafts.find((d) => d.id === id) || null,
    approveDraft: (id) => {
      const d = state.drafts.find((x) => x.id === id && x.status === 'pending');
      if (!d) return 0;
      d.status = 'approved';
      return 1;
    },
    reviseDraft: (id, newDraft, feedback) => {
      const d = state.drafts.find((x) => x.id === id);
      if (!d) return 0;
      d.draft = newDraft;
      d.feedback = feedback;
      d.status = 'pending';
      return 1;
    },
    discardDraft: (id) => {
      const d = state.drafts.find((x) => x.id === id && (x.status === 'pending' || x.status === 'approved'));
      if (!d) return 0;
      d.status = 'discarded';
      return 1;
    },
    listRecentPublishedDrafts: () => ['texto de ayer'],
    getSetting: (k, def) => state.settings[k] ?? def,
    setSetting: (k, v) => (state.settings[k] = v),
    generateScheduledDraft: async ({ feedback }) => `REGENERADO con [${feedback}]`,
  };
}

test('schedule_group_message create generated: guarda kind/brief sin exigir texto', async () => {
  const deps = draftDeps();
  const result = await dispatchTool(
    {
      name: 'schedule_group_message',
      input: { action: 'create', group_name: 'patah', days: ['jueves'], time: '09:00', generated: true, brief: 'Mensaje sobre San José, tono cálido, jóvenes 18-28' },
    },
    deps,
    ctx
  );
  assert.equal(deps._state.created.length, 1);
  assert.equal(deps._state.created[0].kind, 'generated');
  assert.match(deps._state.created[0].brief, /San José/);
  assert.match(result, /GENERADO/);
  assert.match(result, /sin tu visto bueno no se publica/i);
});

test('schedule_group_message create generated SIN brief → lo pide, no guarda', async () => {
  const deps = draftDeps();
  const result = await dispatchTool(
    { name: 'schedule_group_message', input: { action: 'create', group_name: 'patah', days: ['jueves'], time: '09:00', generated: true } },
    deps,
    ctx
  );
  assert.match(result, /brief/i);
  assert.equal(deps._state.created.length, 0);
});

test('manage_drafts list muestra los pendientes de hoy', async () => {
  const out = await dispatchTool({ name: 'manage_drafts', input: { action: 'list' } }, draftDeps(), ctx);
  assert.match(out, /Borrador #5/);
  assert.match(out, /Borrador original/);
});

test('manage_drafts approve cambia el estado; doble aprobación lo dice', async () => {
  const deps = draftDeps();
  assert.match(await dispatchTool({ name: 'manage_drafts', input: { action: 'approve', id: 5 } }, deps, ctx), /aprobado ✅/);
  assert.equal(deps._state.drafts[0].status, 'approved');
  assert.match(await dispatchTool({ name: 'manage_drafts', input: { action: 'approve', id: 5 } }, deps, ctx), /no está pendiente/);
});

test('manage_drafts revise: acumula el feedback y regenera con él', async () => {
  const deps = draftDeps();
  const out = await dispatchTool(
    { name: 'manage_drafts', input: { action: 'revise', id: 5, feedback: 'más corto y sin tantos emojis' } },
    deps,
    ctx
  );
  assert.match(out, /REGENERADO con \[- más corto y sin tantos emojis\]/);
  assert.equal(deps._state.drafts[0].draft, 'REGENERADO con [- más corto y sin tantos emojis]');
  assert.equal(deps._state.settings['editorial_feedback:7'], '- más corto y sin tantos emojis');

  // Segunda corrección se ACUMULA (no reemplaza).
  await dispatchTool({ name: 'manage_drafts', input: { action: 'revise', id: 5, feedback: 'agrega una petición' } }, deps, ctx);
  assert.equal(deps._state.settings['editorial_feedback:7'], '- más corto y sin tantos emojis\n- agrega una petición');
});

test('manage_drafts discard: descarta el borrador y no se vuelve a descartar', async () => {
  const deps = draftDeps();
  const out = await dispatchTool({ name: 'manage_drafts', input: { action: 'discard', id: 5 } }, deps, ctx);
  assert.match(out, /descart/i);
  assert.equal(deps._state.drafts[0].status, 'discarded');
  // Ya descartado → no se puede de nuevo (estado ya no es pending/approved).
  assert.match(
    await dispatchTool({ name: 'manage_drafts', input: { action: 'discard', id: 5 } }, deps, ctx),
    /no se puede descartar/i
  );
});

test('manage_drafts discard: un borrador ya publicado no se descarta', async () => {
  const deps = draftDeps();
  deps._state.drafts[0].status = 'published';
  const out = await dispatchTool({ name: 'manage_drafts', input: { action: 'discard', id: 5 } }, deps, ctx);
  assert.match(out, /ya se publicó/i);
  assert.equal(deps._state.drafts[0].status, 'published');
});

test('manage_drafts: gateo — DM sí (boss/admin), grupos NUNCA', async () => {
  const { toolsForRole } = await import('../src/claude/index.js');
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(names(toolsForRole('boss')).includes('manage_drafts'));
  assert.ok(names(toolsForRole('admin')).includes('manage_drafts'));
  assert.ok(!names(toolsForRole('boss', { isGroup: true })).includes('manage_drafts'));
});

// ─── manage_replies (aprobación de respuestas en grupos) ──────────────────────

function replyDeps() {
  const state = {
    replies: [
      { id: 9, group_id: 'g@g.us', group_name: 'Patah', trigger_sender: 'Pedro', trigger_text: 'a qué hora la misa?', draft: 'A las 6:30pm 🙏', status: 'pending', feedback: null },
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
    revisePendingReply: (id, newDraft, feedback) => {
      const r = state.replies.find((x) => x.id === id);
      if (!r) return 0;
      r.draft = newDraft;
      r.feedback = feedback;
      r.status = 'pending';
      return 1;
    },
    discardPendingReply: (id) => {
      const r = state.replies.find((x) => x.id === id && (x.status === 'pending' || x.status === 'approved'));
      if (!r) return 0;
      r.status = 'discarded';
      return 1;
    },
    generateGroupReply: async ({ feedback }) => `REGENERADA [${feedback}]`,
  };
}

test('manage_replies list muestra las pendientes', async () => {
  const out = await dispatchTool({ name: 'manage_replies', input: { action: 'list' } }, replyDeps(), ctx);
  assert.match(out, /Respuesta #9/);
  assert.match(out, /6:30pm/);
});

test('manage_replies approve aprueba; doble aprobación lo dice', async () => {
  const deps = replyDeps();
  assert.match(await dispatchTool({ name: 'manage_replies', input: { action: 'approve', id: 9 } }, deps, ctx), /Aprobada ✅/);
  assert.equal(deps._state.replies[0].status, 'approved');
  assert.match(await dispatchTool({ name: 'manage_replies', input: { action: 'approve', id: 9 } }, deps, ctx), /no está pendiente/);
});

test('manage_replies revise: regenera con la corrección acumulada', async () => {
  const deps = replyDeps();
  const out = await dispatchTool({ name: 'manage_replies', input: { action: 'revise', id: 9, feedback: 'más cálido' } }, deps, ctx);
  assert.match(out, /REGENERADA \[- más cálido\]/);
  assert.equal(deps._state.replies[0].draft, 'REGENERADA [- más cálido]');
});

test('manage_replies discard: descarta y no se puede de nuevo', async () => {
  const deps = replyDeps();
  assert.match(await dispatchTool({ name: 'manage_replies', input: { action: 'discard', id: 9 } }, deps, ctx), /descart/i);
  assert.equal(deps._state.replies[0].status, 'discarded');
  assert.match(await dispatchTool({ name: 'manage_replies', input: { action: 'discard', id: 9 } }, deps, ctx), /no se puede descartar/i);
});

test('manage_replies: gateo — DM sí (boss/admin), grupos NUNCA', async () => {
  const { toolsForRole } = await import('../src/claude/index.js');
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(names(toolsForRole('boss')).includes('manage_replies'));
  assert.ok(names(toolsForRole('admin')).includes('manage_replies'));
  assert.ok(!names(toolsForRole('boss', { isGroup: true })).includes('manage_replies'));
});

// ─── schedule_outreach (mensajes a terceros por orden del jefe, §18.S) ────────

function outreachDeps({ contact = { name: 'Sebastián', phone: '573001234567' } } = {}) {
  const state = { created: [], upserts: [], canceled: [] };
  return {
    _state: state,
    resolveContact: async () => contact,
    upsertContact: ({ name, phone }) => state.upserts.push({ name, phone }),
    createOutreach: (row) => {
      state.created.push(row);
      return 11;
    },
    listOutreachByCreator: () => [
      { id: 11, to_name: 'Sebastián', to_phone: '573001234567', intent: 'que confirme', recur_kind: 'interval', interval_min: 40, until_at: '2026-06-23 18:00:00', sent_count: 2 },
    ],
    finishOutreach: (id) => (id === 11 ? 1 : 0),
  };
}

test('schedule_outreach once: resuelve contacto y guarda recurKind=once con dueAt', async () => {
  const deps = outreachDeps();
  const out = await dispatchTool(
    { name: 'schedule_outreach', input: { action: 'create', recipient: 'Sebastián', intent: 'que confirme la reunión', recurrence: 'once', due_at: '2026-06-23 17:00:00' } },
    deps,
    ctx
  );
  assert.equal(deps._state.created.length, 1);
  const row = deps._state.created[0];
  assert.equal(row.recurKind, 'once');
  assert.equal(row.dueAt, '2026-06-23 17:00:00');
  assert.equal(row.toPhone, '573001234567');
  assert.equal(row.toName, 'Sebastián');
  assert.equal(row.createdBy, BOSS);
  assert.match(out, /Sebastián/);
});

test('schedule_outreach interval con count: guarda intervalMin, nextDueAt y maxCount', async () => {
  const deps = outreachDeps();
  await dispatchTool(
    { name: 'schedule_outreach', input: { action: 'create', recipient: 'Sebastián', intent: 'que llame', recurrence: 'interval', interval_min: 40, count: 3 } },
    deps,
    ctx
  );
  const row = deps._state.created[0];
  assert.equal(row.recurKind, 'interval');
  assert.equal(row.intervalMin, 40);
  assert.equal(row.maxCount, 3);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.nextDueAt), 'nextDueAt con formato válido');
});

test('schedule_outreach interval por debajo del piso → rechaza, no guarda', async () => {
  const deps = outreachDeps();
  const out = await dispatchTool(
    { name: 'schedule_outreach', input: { action: 'create', recipient: 'Sebastián', intent: 'x', recurrence: 'interval', interval_min: 1, count: 2 } },
    deps,
    ctx
  );
  assert.equal(deps._state.created.length, 0);
  assert.match(out, /m[ií]nimo/i);
});

test('schedule_outreach interval sin until/count usa el inicio de quiet hours como parada', async () => {
  const saved = { q: process.env.QUIET_HOURS_START, tz: process.env.TZ };
  process.env.QUIET_HOURS_START = '21:00';
  process.env.TZ = 'America/Bogota';
  try {
    const deps = outreachDeps();
    await dispatchTool(
      { name: 'schedule_outreach', input: { action: 'create', recipient: 'Sebastián', intent: 'x', recurrence: 'interval', interval_min: 40 } },
      deps,
      ctx
    );
    assert.equal(deps._state.created.length, 1);
    const row = deps._state.created[0];
    assert.match(row.untilAt, /21:00:00$/, 'until por defecto = inicio del descanso');
    assert.equal(row.maxCount, null);
  } finally {
    if (saved.q === undefined) delete process.env.QUIET_HOURS_START; else process.env.QUIET_HOURS_START = saved.q;
    if (saved.tz === undefined) delete process.env.TZ; else process.env.TZ = saved.tz;
  }
});

test('schedule_outreach interval sin parada y SIN quiet hours → pide una parada', async () => {
  const saved = process.env.QUIET_HOURS_START;
  delete process.env.QUIET_HOURS_START;
  try {
    const deps = outreachDeps();
    const out = await dispatchTool(
      { name: 'schedule_outreach', input: { action: 'create', recipient: 'Sebastián', intent: 'x', recurrence: 'interval', interval_min: 40 } },
      deps,
      ctx
    );
    assert.equal(deps._state.created.length, 0);
    assert.match(out, /parada|hasta qu[eé]|cu[aá]ntas veces/i);
  } finally {
    if (saved === undefined) delete process.env.QUIET_HOURS_START; else process.env.QUIET_HOURS_START = saved;
  }
});

test('schedule_outreach daily: normaliza días y hora', async () => {
  const deps = outreachDeps();
  await dispatchTool(
    { name: 'schedule_outreach', input: { action: 'create', recipient: 'Sebastián', intent: 'buenos días', recurrence: 'daily', days: ['lunes', 'miercoles'], time: '9:00' } },
    deps,
    ctx
  );
  const row = deps._state.created[0];
  assert.equal(row.recurKind, 'daily');
  assert.equal(row.days, '1,3');
  assert.equal(row.timeHm, '09:00');
});

test('schedule_outreach con número nuevo + nombre lo guarda y ECHA el número en la confirmación', async () => {
  const deps = outreachDeps({ contact: { name: null, phone: '573009990000' } });
  const out = await dispatchTool(
    { name: 'schedule_outreach', input: { action: 'create', recipient: 'Carlos', recipient_phone: '300 999 0000', intent: 'salúdalo', recurrence: 'once', due_at: '2026-06-23 17:00:00' } },
    deps,
    ctx
  );
  assert.equal(deps._state.upserts.length, 1);
  assert.equal(deps._state.upserts[0].name, 'Carlos');
  // §18 1A: el número dictado se repite en la confirmación para que el jefe cace un dígito mal.
  assert.match(out, /3009990000/);
});

test('schedule_outreach con número inválido (muy corto) NO guarda y pide repetirlo (§18 1A)', async () => {
  const deps = outreachDeps();
  const out = await dispatchTool(
    { name: 'schedule_outreach', input: { action: 'create', recipient: 'Carlos', recipient_phone: '123', intent: 'x', recurrence: 'once', due_at: '2026-06-23 17:00:00' } },
    deps,
    ctx
  );
  assert.equal(deps._state.upserts.length, 0); // no guardó un número basura
  assert.equal(deps._state.created.length, 0); // ni programó nada
  assert.match(out, /repites|no me cuadra|corto/i);
});

test('schedule_outreach a contacto YA guardado (sin número dictado) no repite número', async () => {
  const deps = outreachDeps(); // contact por defecto: { name: 'Sebastián', phone: '573001234567' }
  const out = await dispatchTool(
    { name: 'schedule_outreach', input: { action: 'create', recipient: 'Sebastián', intent: 'que confirme', recurrence: 'once', due_at: '2026-06-23 17:00:00' } },
    deps,
    ctx
  );
  assert.doesNotMatch(out, /573001234567/); // no echa el número de un contacto ya conocido
});

test('schedule_outreach contacto no resuelto → pide el número, no guarda', async () => {
  const deps = outreachDeps({ contact: null });
  const out = await dispatchTool(
    { name: 'schedule_outreach', input: { action: 'create', recipient: 'Fulano', intent: 'x', recurrence: 'once', due_at: '2026-06-23 17:00:00' } },
    deps,
    ctx
  );
  assert.equal(deps._state.created.length, 0);
  assert.match(out, /n[uú]mero|no encontr[eé]/i);
});

test('schedule_outreach list y cancel', async () => {
  const deps = outreachDeps();
  const list = await dispatchTool({ name: 'schedule_outreach', input: { action: 'list' } }, deps, ctx);
  assert.match(list, /#11/);
  assert.match(list, /cada 40 min/);
  const ok = await dispatchTool({ name: 'schedule_outreach', input: { action: 'cancel', id: 11 } }, deps, ctx);
  assert.match(ok, /#11 cancelado/);
  const noId = await dispatchTool({ name: 'schedule_outreach', input: { action: 'cancel' } }, deps, ctx);
  assert.match(noId, /necesito el id/i);
});

test('schedule_outreach: gateo — SOLO el jefe (boss); admin NO, grupos NUNCA', async () => {
  const { toolsForRole } = await import('../src/claude/index.js');
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(names(toolsForRole('boss')).includes('schedule_outreach'), 'boss en DM sí');
  assert.ok(!names(toolsForRole('admin')).includes('schedule_outreach'), 'admin NO');
  assert.ok(!names(toolsForRole('boss', { isGroup: true })).includes('schedule_outreach'), 'en grupo no');
  assert.ok(!names(toolsForRole('boss', { isGroup: true, bossInGroup: true })).includes('schedule_outreach'), 'jefe-en-grupo no');
});

// ─── manage_reminders (ver/cancelar/posponer recordatorios del jefe) ──────────

function reminderDeps() {
  const state = {
    reminders: [
      { id: 3, text: 'pagar arriendo', due_at: '2026-06-20 09:00:00', to_phone: BOSS, created_by: BOSS, status: 'pending' },
      { id: 4, text: 'llamar a Ana', due_at: '2026-06-21 15:00:00', to_phone: '573009998877', created_by: BOSS, status: 'pending' },
    ],
  };
  return {
    _state: state,
    // Scope por created_by, igual que la DB real (aislamiento).
    listReminders: (createdBy) => state.reminders.filter((r) => r.status === 'pending' && r.created_by === createdBy),
    cancelReminder: (id, createdBy) => {
      const r = state.reminders.find((x) => x.id === id && x.created_by === createdBy && x.status === 'pending');
      if (!r) return 0;
      r.status = 'cancelled';
      return 1;
    },
    snoozeReminder: (id, newDueAt, createdBy) => {
      const r = state.reminders.find((x) => x.id === id && x.created_by === createdBy && x.status === 'pending');
      if (!r) return 0;
      r.due_at = newDueAt;
      return 1;
    },
  };
}

test('manage_reminders list muestra los pendientes; marca destinatario de terceros', async () => {
  const out = await dispatchTool({ name: 'manage_reminders', input: { action: 'list' } }, reminderDeps(), ctx);
  assert.match(out, /#3 → 2026-06-20 09:00:00: "pagar arriendo"/);
  assert.match(out, /#4 .* "llamar a Ana" \(para 573009998877\)/); // recordatorio para un tercero
  assert.doesNotMatch(out, /#3.*\(para/); // el propio no marca destinatario
});

test('manage_reminders list sin pendientes lo dice', async () => {
  const deps = reminderDeps();
  deps._state.reminders.forEach((r) => (r.status = 'cancelled'));
  const out = await dispatchTool({ name: 'manage_reminders', input: { action: 'list' } }, deps, ctx);
  assert.match(out, /no tienes recordatorios pendientes/i);
});

test('manage_reminders cancel por id cambia estado; doble cancel lo dice', async () => {
  const deps = reminderDeps();
  assert.match(await dispatchTool({ name: 'manage_reminders', input: { action: 'cancel', id: 3 } }, deps, ctx), /#3 cancelado ✅/);
  assert.equal(deps._state.reminders[0].status, 'cancelled');
  // Ya no está pending → no se vuelve a cancelar.
  assert.match(await dispatchTool({ name: 'manage_reminders', input: { action: 'cancel', id: 3 } }, deps, ctx), /no encontré/i);
});

test('manage_reminders cancel sin id pide listar primero', async () => {
  const out = await dispatchTool({ name: 'manage_reminders', input: { action: 'cancel' } }, reminderDeps(), ctx);
  assert.match(out, /necesito el id/i);
});

test('manage_reminders snooze reprograma la fecha', async () => {
  const deps = reminderDeps();
  const out = await dispatchTool(
    { name: 'manage_reminders', input: { action: 'snooze', id: 3, new_due_at: '2026-06-25 09:00:00' } },
    deps,
    ctx
  );
  assert.match(out, /#3 reprogramado para 2026-06-25 09:00:00 ✅/);
  assert.equal(deps._state.reminders[0].due_at, '2026-06-25 09:00:00');
});

test('manage_reminders snooze sin new_due_at pregunta para cuándo', async () => {
  const out = await dispatchTool({ name: 'manage_reminders', input: { action: 'snooze', id: 3 } }, reminderDeps(), ctx);
  assert.match(out, /para cuándo/i);
});

test('manage_reminders snooze con fecha mal formada NO reprograma y pide la fecha exacta', async () => {
  const deps = reminderDeps();
  const out = await dispatchTool(
    { name: 'manage_reminders', input: { action: 'snooze', id: 3, new_due_at: 'el lunes' } },
    deps,
    ctx
  );
  assert.match(out, /YYYY-MM-DD|fecha y hora exact/i);
  assert.equal(deps._state.reminders[0].due_at, '2026-06-20 09:00:00'); // intacto, no se guardó basura
});

test('manage_reminders: aislamiento — otro createdBy no ve ni cancela los del jefe', async () => {
  const deps = reminderDeps();
  const otherCtx = { createdBy: '573009990000' };
  // No ve los del jefe.
  assert.match(await dispatchTool({ name: 'manage_reminders', input: { action: 'list' } }, deps, otherCtx), /no tienes recordatorios/i);
  // No puede cancelar uno ajeno.
  assert.match(await dispatchTool({ name: 'manage_reminders', input: { action: 'cancel', id: 3 } }, deps, otherCtx), /no encontré/i);
  assert.equal(deps._state.reminders[0].status, 'pending'); // intacto
});

test('manage_reminders: gateo — DM sí (boss/admin), grupos NUNCA', async () => {
  const { toolsForRole } = await import('../src/claude/index.js');
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(names(toolsForRole('boss')).includes('manage_reminders'), 'boss en DM sí');
  assert.ok(names(toolsForRole('admin')).includes('manage_reminders'), 'admin en DM sí');
  assert.ok(!names(toolsForRole('boss', { isGroup: true })).includes('manage_reminders'), 'en grupo no');
  assert.ok(!names(toolsForRole('boss', { publicDm: true })).includes('manage_reminders'), 'en DM público no');
});

// ─── parseBusinessFacts (extracción de negocio, Fase 2B) ──────────────────────

test('parseBusinessFacts: array JSON válido → hechos con topic+fact', () => {
  const out = parseBusinessFacts('[{"topic":"closers","fact":"Marin cierra LinkedIn Sales"}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { topic: 'closers', fact: 'Marin cierra LinkedIn Sales' });
});

test('parseBusinessFacts: JSON envuelto en ```json … ``` o texto → lo extrae', () => {
  const raw = 'Claro, aquí tienes:\n```json\n[{"topic":"metas","fact":"meta Q3 100 cupos"}]\n```';
  const out = parseBusinessFacts(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].fact, 'meta Q3 100 cupos');
});

test('parseBusinessFacts: topic inválido → "otro"; fact vacío → descartado', () => {
  const out = parseBusinessFacts('[{"topic":"xyz","fact":"algo"},{"topic":"metas","fact":"   "}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].topic, 'otro');
});

test('parseBusinessFacts: dedup contra hechos ya conocidos (normalizado)', () => {
  const existing = [{ fact: 'Marin cierra LinkedIn Sales' }];
  const out = parseBusinessFacts('[{"topic":"closers","fact":"  marin   cierra LINKEDIN sales "}]', existing);
  assert.equal(out.length, 0); // mismo hecho con otro espaciado/caso → no se repropone
});

test('parseBusinessFacts: dedup dentro del mismo lote', () => {
  const out = parseBusinessFacts('[{"topic":"metas","fact":"vender cupos"},{"topic":"otro","fact":"Vender Cupos"}]');
  assert.equal(out.length, 1);
});

test('parseBusinessFacts: JSON inválido / no-array / vacío → []', () => {
  assert.deepEqual(parseBusinessFacts('no soy json'), []);
  assert.deepEqual(parseBusinessFacts('{"topic":"metas","fact":"x"}'), []); // objeto, no array
  assert.deepEqual(parseBusinessFacts(''), []);
  assert.deepEqual(parseBusinessFacts(null), []);
});
