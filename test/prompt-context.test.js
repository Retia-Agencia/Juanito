// test/prompt-context.test.js
// Regresión del BUG CRÍTICO de rol por contexto: en grupos Juanito debe ser un
// chatbot general AISLADO — sin tocar memoria/recordatorios/resúmenes ni inyectar
// datos privados del jefe. En DM (jefe/admin) sí carga e inyecta ese contexto.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// El SDK de Anthropic exige una apiKey al construir el cliente (claude/index.js).
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const { buildSystemPrompt } = await import('../src/claude/index.js');

// Deps espía: cuentan cuántas veces se llama a cada fuente de datos privados y
// devuelven datos "marcados" para detectar si se filtran al prompt.
function spyDeps() {
  const calls = { getAllMemory: 0, getRecentSummaries: 0, getUpcomingReminders: 0 };
  return {
    calls,
    getAllMemory: async () => {
      calls.getAllMemory++;
      return [
        { key: 'cuenta_bancaria', value: 'SECRETO-NUCLEO-123' },
        { key: 'boss_note:cafe', value: 'SECRETO-NOTA-JEFE' },
      ];
    },
    getRecentSummaries: async () => {
      calls.getRecentSummaries++;
      return [{ chat_name: 'Equipo', summary: 'SECRETO-RESUMEN-GRUPO' }];
    },
    getUpcomingReminders: async () => {
      calls.getUpcomingReminders++;
      return [{ due_at: '2026-06-10 09:00:00', text: 'SECRETO-RECORDATORIO' }];
    },
  };
}

test('grupo: NO consulta memoria/resúmenes/recordatorios', async () => {
  const deps = spyDeps();
  await buildSystemPrompt(deps, { isGroup: true, role: 'boss' });
  assert.equal(deps.calls.getAllMemory, 0, 'no debe leer memoria en grupos');
  assert.equal(deps.calls.getRecentSummaries, 0, 'no debe leer resúmenes en grupos');
  assert.equal(deps.calls.getUpcomingReminders, 0, 'no debe leer recordatorios en grupos');
});

test('grupo: el prompt NO contiene datos privados del jefe', async () => {
  const deps = spyDeps();
  const prompt = await buildSystemPrompt(deps, { isGroup: true, role: 'boss' });
  for (const secret of [
    'SECRETO-NUCLEO-123',
    'SECRETO-NOTA-JEFE',
    'SECRETO-RESUMEN-GRUPO',
    'SECRETO-RECORDATORIO',
  ]) {
    assert.ok(!prompt.includes(secret), `el prompt de grupo no debe filtrar ${secret}`);
  }
});

test('grupo: persona de chatbot general, no "asistente del jefe"', async () => {
  const deps = spyDeps();
  const prompt = await buildSystemPrompt(deps, { isGroup: true, role: 'boss' });
  assert.ok(/grupo de WhatsApp/i.test(prompt), 'debe presentarse como chatbot de grupo');
  assert.ok(!/dueño de esto/i.test(prompt), 'no debe tratar al interlocutor como el dueño');
  assert.ok(/Reglas de seguridad/i.test(prompt), 'debe conservar el bloque de seguridad');
});

test('grupo: aunque el rol llegue como boss, sigue aislado', async () => {
  // Defensa: handleGroupMessage pasa el rol real, pero si por error llega 'boss'
  // el prompt de grupo NO debe inyectar datos ni cambiar de persona.
  const deps = spyDeps();
  const prompt = await buildSystemPrompt(deps, { isGroup: true, role: 'boss' });
  assert.equal(deps.calls.getAllMemory, 0);
  assert.ok(!prompt.includes('SECRETO-NUCLEO-123'));
});

test('DM del jefe: SÍ inyecta memoria y recordatorios', async () => {
  const deps = spyDeps();
  const prompt = await buildSystemPrompt(deps, { isGroup: false, role: 'boss' });
  assert.equal(deps.calls.getAllMemory, 1, 'debe leer memoria en DM');
  assert.equal(deps.calls.getUpcomingReminders, 1, 'debe leer recordatorios en DM');
  assert.ok(prompt.includes('SECRETO-NUCLEO-123'), 'la memoria núcleo va en el DM del jefe');
  assert.ok(prompt.includes('SECRETO-RECORDATORIO'), 'los recordatorios van en el DM del jefe');
  assert.ok(/el jefe \(dueño\)/i.test(prompt), 'persona de asistente del jefe en DM');
});

test('DM del admin: persona de equipo técnico', async () => {
  const deps = spyDeps();
  const prompt = await buildSystemPrompt(deps, { isGroup: false, role: 'admin' });
  assert.ok(/equipo técnico \(admin\)/i.test(prompt), 'persona de admin en DM');
  assert.ok(prompt.includes('SECRETO-NUCLEO-123'), 'el admin sí ve la memoria núcleo');
});

// ─── Personalidad por grupo (aditiva sobre el prompt aislado) ──────────────────

test('grupo con persona configurada: la inyecta SIN romper el aislamiento', async () => {
  const deps = spyDeps();
  deps.getGroupPersona = async (chatId) =>
    chatId === 'patah@g.us' ? 'Grupo religioso católico. Refiérete a los participantes como "muchachos".' : null;

  const prompt = await buildSystemPrompt(deps, { isGroup: true, role: 'unknown', chatId: 'patah@g.us' });

  assert.ok(prompt.includes('muchachos'), 'inyecta la persona del grupo');
  assert.ok(/Personalidad específica de ESTE grupo/i.test(prompt), 'la marca como configurada por el equipo');
  // El blindaje sigue intacto:
  assert.equal(deps.calls.getAllMemory, 0, 'la persona NO reabre memoria');
  assert.ok(!prompt.includes('SECRETO-NUCLEO-123'));
  assert.ok(/Reglas de seguridad/i.test(prompt), 'conserva el bloque de seguridad');
  assert.ok(/NO tienes acceso a datos privados/i.test(prompt), 'conserva el aviso de contexto');
});

test('grupo SIN persona (u otro chatId): prompt genérico de siempre', async () => {
  const deps = spyDeps();
  deps.getGroupPersona = async (chatId) => (chatId === 'patah@g.us' ? 'persona X' : null);

  const otro = await buildSystemPrompt(deps, { isGroup: true, role: 'unknown', chatId: 'otro@g.us' });
  assert.ok(!otro.includes('persona X'), 'la persona de un grupo no se filtra a otro');
  assert.ok(!/Personalidad específica de ESTE grupo/i.test(otro));

  const sinChatId = await buildSystemPrompt(deps, { isGroup: true, role: 'unknown' });
  assert.ok(!sinChatId.includes('persona X'), 'sin chatId no hay persona');
});

test('grupo: getGroupPersona que falla no rompe el prompt', async () => {
  const deps = spyDeps();
  deps.getGroupPersona = async () => {
    throw new Error('db caída');
  };
  const prompt = await buildSystemPrompt(deps, { isGroup: true, role: 'unknown', chatId: 'x@g.us' });
  assert.ok(/grupo de WhatsApp/i.test(prompt), 'cae al prompt genérico');
});

// ─── Respuestas de grupo pendientes (bloque de aprobación en el DM del jefe) ──

test('DM del jefe: inyecta las respuestas de grupo pendientes', async () => {
  const deps = spyDeps();
  deps.listPendingReplies = async () => [
    { id: 7, group_name: 'Patah', trigger_sender: 'Pedro', trigger_text: 'hora?', draft: 'RESP-PENDIENTE-MARCA' },
  ];
  const prompt = await buildSystemPrompt(deps, { isGroup: false, role: 'boss' });
  assert.ok(prompt.includes('RESP-PENDIENTE-MARCA'), 'la respuesta pendiente va en el DM del jefe');
  assert.ok(/manage_replies/i.test(prompt), 'instruye usar la tool manage_replies');
});

test('grupo: NUNCA inyecta respuestas pendientes (aislamiento)', async () => {
  const deps = spyDeps();
  let asked = 0;
  deps.listPendingReplies = async () => {
    asked++;
    return [{ id: 7, group_name: 'Patah', trigger_sender: 'Pedro', trigger_text: 'x', draft: 'RESP-PENDIENTE-MARCA' }];
  };
  const prompt = await buildSystemPrompt(deps, { isGroup: true, role: 'boss', chatId: 'g@g.us' });
  assert.equal(asked, 0, 'en grupo ni se consulta');
  assert.ok(!prompt.includes('RESP-PENDIENTE-MARCA'));
});

test('DM: la persona de grupo NO aplica (es solo para grupos)', async () => {
  const deps = spyDeps();
  let asked = 0;
  deps.getGroupPersona = async () => {
    asked++;
    return 'persona de grupo';
  };
  const prompt = await buildSystemPrompt(deps, { isGroup: false, role: 'boss', chatId: 'dm@s.whatsapp.net' });
  assert.equal(asked, 0, 'en DM ni se consulta');
  assert.ok(!prompt.includes('persona de grupo'));
});
