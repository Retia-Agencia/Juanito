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
    held: over.held || [],
    marks: { sent: [], expired: [], discarded: [], released: [] },
  };
  const deps = {
    _sent: sent,
    _state: state,
    listApprovedPendingReplies: () => state.approved,
    listExpiredPendingReplies: () => state.expired,
    listHeldPendingReplies: () => state.held,
    releaseHeldPendingReply: (id) => state.marks.released.push(id),
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

test('pendiente de DM (kind=dm) se entrega aunque NO esté autorizado como grupo', async () => {
  // Un DM nunca vive en authorized_groups → si se aplicara el chequeo, se descartaría siempre.
  const deps = makeDeps({
    approved: [{ id: 8, kind: 'dm', group_id: '57300@s.whatsapp.net', group_name: 'DM de Pedro', draft: 'Hola Pedro' }],
    isGroupAuthorized: () => false,
  });
  await runPendingRepliesCycle(deps);
  assert.deepEqual(deps._sent, [{ to: '57300@s.whatsapp.net', text: 'Hola Pedro' }]);
  assert.deepEqual(deps._state.marks.sent, [8]);
  assert.deepEqual(deps._state.marks.discarded, []);
});

test('vencimiento → rescate: avisa al remitente, re-avisa al jefe con cómo rescatar, marca expired', async () => {
  const deps = makeDeps({
    expired: [{
      id: 3, group_id: 'g@g.us', group_name: 'Patah', draft: 'vieja',
      trigger_sender: 'Ana', trigger_text: '¿precio?',
    }],
  });
  await runPendingRepliesCycle(deps);
  assert.deepEqual(deps._state.marks.expired, [3]);
  // a) aviso amable al remitente original (al grupo)
  const aRemitente = deps._sent.find((m) => m.to === 'g@g.us');
  assert.ok(aRemitente, 'debe avisar al remitente');
  // b) re-aviso al jefe con instrucciones de rescate (apruebo/no #id) + el borrador
  const aviso = deps._sent.find((m) => m.to === '111@lid');
  assert.ok(aviso, 'debe re-avisar al jefe');
  assert.match(aviso.text, /apruebo #3/i);
  assert.match(aviso.text, /no #3/i);
  assert.match(aviso.text, /vieja/, 'incluye el borrador para rescatarlo');
  // no se descarta (rescatable)
  assert.deepEqual(deps._state.marks.discarded, []);
});

test('vencimiento de un DM (kind=dm) → avisa al JID del remitente sin cita', async () => {
  const deps = makeDeps({
    expired: [{ id: 9, kind: 'dm', group_id: '57300@s.whatsapp.net', group_name: 'DM de Pedro', draft: 'resp' }],
  });
  const calls = [];
  deps.sendMessage = async (to, text, opts) => { calls.push({ to, text, opts }); };
  await runPendingRepliesCycle(deps);
  const aRemitente = calls.find((m) => m.to === '57300@s.whatsapp.net');
  assert.ok(aRemitente, 'avisa al remitente del DM');
  assert.equal(aRemitente.opts?.quoted, undefined, 'en DM no cita');
});

test('quiet hours OFF + retenidas → digest único al jefe y las libera', async () => {
  const deps = makeDeps({
    held: [
      { id: 10, group_id: 'g@g.us', group_name: 'Patah', trigger_sender: 'Ana', trigger_text: 'hola' },
      { id: 11, kind: 'dm', group_id: '57300@s.whatsapp.net', group_name: 'DM de Pedro', trigger_sender: 'Pedro', trigger_text: 'q tal' },
    ],
  });
  await runPendingRepliesCycle(deps);
  // un solo mensaje al jefe (digest) que menciona ambas
  const digest = deps._sent.filter((m) => m.to === '111@lid');
  assert.equal(digest.length, 1, 'un solo digest');
  assert.match(digest[0].text, /#10/);
  assert.match(digest[0].text, /#11/);
  // ambas liberadas
  assert.deepEqual(deps._state.marks.released.sort(), [10, 11]);
});

test('quiet hours ON → NO manda digest ni libera (el jefe duerme)', async () => {
  process.env.QUIET_HOURS_START = '00:00';
  process.env.QUIET_HOURS_END = '23:59'; // ventana que cubre casi todo el día
  try {
    const deps = makeDeps({
      held: [{ id: 12, group_id: 'g@g.us', group_name: 'Patah', trigger_sender: 'Ana', trigger_text: 'hola' }],
    });
    await runPendingRepliesCycle(deps);
    assert.equal(deps._sent.filter((m) => m.to === '111@lid').length, 0, 'no notifica dentro del descanso');
    assert.deepEqual(deps._state.marks.released, [], 'no libera dentro del descanso');
  } finally {
    delete process.env.QUIET_HOURS_START;
    delete process.env.QUIET_HOURS_END;
  }
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

test('re-entrancy: dos ciclos solapados NO re-envían las mismas filas (anti doble-envío)', async () => {
  // makeDeps NO quita las filas de `approved` al marcarlas sent (markPendingReplySent solo
  // registra el id), así que si el 2º ciclo llegara a correr volvería a tomar la #20 → doble
  // envío. La guarda de re-entrada debe hacer que el 2º ciclo salga temprano.
  const deps = makeDeps({
    approved: [{ id: 20, group_id: 'g@g.us', group_name: 'X', draft: 'hola' }],
  });
  deps.sendMessage = async (to, text) => {
    deps._sent.push({ to, text });
    await new Promise((r) => setTimeout(r, 20)); // envío "lento": el 1º ciclo sigue en curso
  };
  const p1 = runPendingRepliesCycle(deps); // arranca y queda awaiting en sendMessage
  const p2 = runPendingRepliesCycle(deps); // entra mientras p1 corre → guarda lo salta
  await Promise.all([p1, p2]);
  assert.equal(deps._sent.length, 1, 'un solo envío pese a dos ciclos solapados');
  assert.deepEqual(deps._state.marks.sent, [20]);
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
