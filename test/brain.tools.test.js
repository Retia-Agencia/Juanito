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
