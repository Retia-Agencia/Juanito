// test/group-replies.test.js
// Ciclo del scheduler de respuestas con aprobación (runPendingRepliesCycle), con deps
// inyectadas — sin DB/WA reales. Puro: corre nativo en Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOSS_LID = '111@lid'; // destino de avisos al jefe (bossDmTarget)
process.env.REPLY_APPROVAL_TTL_MIN = '30';

const { runPendingRepliesCycle } = await import('../src/scheduler/group-replies.js');

function makeDeps(over = {}) {
  const sent = [];
  const state = {
    approved: over.approved || [],
    expired: over.expired || [],
    marks: { sent: [], expired: [], discarded: [] },
  };
  const deps = {
    _sent: sent,
    _state: state,
    listApprovedPendingReplies: () => state.approved,
    listExpiredPendingReplies: () => state.expired,
    isGroupAuthorized: over.isGroupAuthorized || (() => true),
    markPendingReplySent: (id) => state.marks.sent.push(id),
    markPendingReplyExpired: (id) => state.marks.expired.push(id),
    discardPendingReply: (id) => state.marks.discarded.push(id),
    sendMessage: async (to, text) => sent.push({ to, text }),
  };
  return deps;
}

test('envía las aprobadas al grupo y las marca sent', async () => {
  const deps = makeDeps({
    approved: [{ id: 1, group_id: 'g@g.us', group_name: 'Patah', draft: 'Hola' }],
  });
  await runPendingRepliesCycle(deps);
  assert.deepEqual(deps._sent, [{ to: 'g@g.us', text: 'Hola' }]);
  assert.deepEqual(deps._state.marks.sent, [1]);
});

test('aprobada en grupo NO autorizado (revocado) → se descarta, no se envía', async () => {
  const deps = makeDeps({
    approved: [{ id: 2, group_id: 'g@g.us', group_name: 'Patah', draft: 'Hola' }],
    isGroupAuthorized: () => false,
  });
  await runPendingRepliesCycle(deps);
  assert.equal(deps._sent.length, 0);
  assert.deepEqual(deps._state.marks.discarded, [2]);
  assert.deepEqual(deps._state.marks.sent, []);
});

test('caduca las pendientes viejas y avisa al jefe', async () => {
  const deps = makeDeps({
    expired: [{ id: 3, group_id: 'g@g.us', group_name: 'Patah', draft: 'vieja' }],
  });
  await runPendingRepliesCycle(deps);
  assert.deepEqual(deps._state.marks.expired, [3]);
  // aviso al jefe (bossDmTarget = BOSS_LID)
  const aviso = deps._sent.find((m) => m.to === '111@lid');
  assert.ok(aviso, 'debe avisar al jefe');
  assert.match(aviso.text, /caduc/i);
});

test('cita el mensaje gatillo cuando hay trigger_msg_id (reconstruye quoted)', async () => {
  const deps = makeDeps({
    approved: [{
      id: 6, group_id: 'g@g.us', group_name: 'Patah', draft: 'La reunión es a las 8',
      trigger_msg_id: 'ABC123', trigger_participant: '57300@s.whatsapp.net', trigger_text: '¿a qué hora?',
    }],
  });
  const calls = [];
  deps.sendMessage = async (to, text, opts) => { calls.push({ to, text, opts }); };
  await runPendingRepliesCycle(deps);

  assert.equal(calls.length, 1);
  const q = calls[0].opts?.quoted;
  assert.ok(q, 'debe pasar quoted');
  assert.equal(q.key.id, 'ABC123');
  assert.equal(q.key.remoteJid, 'g@g.us');
  assert.equal(q.key.participant, '57300@s.whatsapp.net');
  assert.equal(q.key.fromMe, false);
  assert.equal(q.message.conversation, '¿a qué hora?');
});

test('respuesta pre-migración (sin trigger_msg_id) → envía SIN cita', async () => {
  const deps = makeDeps({
    approved: [{ id: 7, group_id: 'g@g.us', group_name: 'Patah', draft: 'Hola' }],
  });
  const calls = [];
  deps.sendMessage = async (to, text, opts) => { calls.push({ to, text, opts }); };
  await runPendingRepliesCycle(deps);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts?.quoted, undefined, 'sin trigger_msg_id no debe citar');
});

test('un fallo de envío no rompe el ciclo (sigue con las demás)', async () => {
  const deps = makeDeps({
    approved: [
      { id: 4, group_id: 'a@g.us', group_name: 'A', draft: 'x' },
      { id: 5, group_id: 'b@g.us', group_name: 'B', draft: 'y' },
    ],
  });
  let n = 0;
  deps.sendMessage = async (to, text) => {
    n += 1;
    if (n === 1) throw new Error('boom');
    deps._sent.push({ to, text });
  };
  await runPendingRepliesCycle(deps);
  // la #4 falló (no se marcó sent), la #5 sí salió
  assert.deepEqual(deps._state.marks.sent, [5]);
  assert.deepEqual(deps._sent, [{ to: 'b@g.us', text: 'y' }]);
});
