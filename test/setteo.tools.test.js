// test/setteo.tools.test.js
// Tools del closer agéntico (§18.AV): gateo por rol, dispatch y AISLAMIENTO del prompt.
// Sin red ni DB (todo mockeado) → corre en Windows.
//
// Lo que estos tests protegen: que la identidad del closer venga SIEMPRE del JID y nunca del
// modelo, que un closer no pueda tocar lo de otro, y que su prompt no filtre datos del jefe.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const { dispatchTool, toolsForRole, buildSystemPrompt } = await import('../src/claude/index.js');

const SEBAS = { email: 'sebastian@30x.com', name: 'Sebastian Rodriguez', phone: '+573102212005' };
const names = (tools) => tools.map((t) => t.name);
const CLOSER_TOOLS = ['registrar_setteo', 'consultar_mis_setteos', 'corregir_setteo'];

// ─── Gateo por rol ────────────────────────────────────────────────────────────

test('el closer ve EXACTAMENTE sus tres tools y ninguna más', () => {
  assert.deepEqual(names(toolsForRole('closer')).sort(), [...CLOSER_TOOLS].sort());
});

test('el closer NO tiene memoria, recordatorios ni búsqueda en los datos del jefe', () => {
  const t = names(toolsForRole('closer'));
  for (const prohibida of ['save_memory', 'remember_note', 'create_reminder', 'search_knowledge', 'schedule_outreach', 'capture_task']) {
    assert.ok(!t.includes(prohibida), `un closer no puede tener ${prohibida}`);
  }
});

// Registrar el setteo de alguien en un chat compartido filtraría nombres de leads al grupo.
test('un closer en un GRUPO no tiene ninguna tool', () => {
  assert.deepEqual(toolsForRole('closer', { isGroup: true }), []);
});

test('las tools del closer NO se le exponen al jefe ni al admin', () => {
  for (const role of ['boss', 'admin']) {
    const t = names(toolsForRole(role));
    for (const c of CLOSER_TOOLS) assert.ok(!t.includes(c), `${role} no debería ver ${c}`);
  }
});

test('un desconocido sigue sin tools', () => {
  assert.deepEqual(toolsForRole('unknown', { publicDm: true }), []);
});

// ─── Dispatch ─────────────────────────────────────────────────────────────────

function makeDeps(over = {}) {
  const calls = {};
  return {
    calls,
    localDateISO: () => '2026-08-03',
    guardarSetteos: async (args) => {
      calls.guardar = args;
      return { guardados: args.items.length, calls: 0, ambiguos: 0, sinMatch: 0, nombres: args.items.map((i) => i.leadName) };
    },
    buildMisSetteos: async (args) => {
      calls.mis = args;
      return 'MÉTRICAS';
    },
    listSetteosForCloser: async (args) => {
      calls.list = args;
      return [{ id: 7, lead_norm: 'maria gomez', lead_name: 'María Gómez' }];
    },
    updateSetteoFlags: async (args) => {
      calls.update = args;
      return 1;
    },
    deleteSetteo: async (args) => {
      calls.del = args;
      return 1;
    },
    ...over,
  };
}

// La garantía central: si el closer viniera del input, un mensaje bien redactado bastaría
// para escribirle setteos a otro.
test('sin ctx.closer las tres tools se niegan a hacer nada', async () => {
  const deps = makeDeps();
  for (const name of CLOSER_TOOLS) {
    const out = await dispatchTool({ name, input: { leads: [{ nombre: 'X Y' }], nombre: 'X Y', accion: 'borrar' } }, deps, {});
    assert.match(out, /solo funciona en el chat de un closer/);
  }
  assert.equal(deps.calls.guardar, undefined);
  assert.equal(deps.calls.del, undefined);
});

test('registrar_setteo usa el closer del ctx, no nada del input', async () => {
  const deps = makeDeps();
  const out = await dispatchTool(
    { name: 'registrar_setteo', input: { leads: [{ nombre: 'Juan Pérez', agendo: true }], closer_email: 'otro@30x.com' } },
    deps,
    { closer: SEBAS }
  );
  assert.equal(deps.calls.guardar.closer.email, 'sebastian@30x.com');
  assert.equal(deps.calls.guardar.items[0].leadNorm, 'juan perez');
  assert.equal(deps.calls.guardar.items[0].agendo, 1);
  assert.equal(deps.calls.guardar.items[0].contesto, 1, 'agendó implica que contestó');
  assert.match(out, /Guardados 1/);
});

test('registrar_setteo sin nombres usables no guarda nada', async () => {
  const deps = makeDeps();
  const out = await dispatchTool({ name: 'registrar_setteo', input: { leads: [{ nombre: '' }, { nombre: 'x' }] } }, deps, { closer: SEBAS });
  assert.equal(deps.calls.guardar, undefined);
  assert.match(out, /nombre/);
});

test('registrar_setteo deduplica el mismo lead dentro de la llamada', async () => {
  const deps = makeDeps();
  await dispatchTool(
    { name: 'registrar_setteo', input: { leads: [{ nombre: 'Ana Ruiz' }, { nombre: 'ana  RUIZ' }] } },
    deps,
    { closer: SEBAS }
  );
  assert.equal(deps.calls.guardar.items.length, 1);
});

// Un modelo que alucina una fecha no puede mandar el setteo del closer a otro mes.
test('registrar_setteo ignora una fecha futura o inválida y usa hoy', async () => {
  const deps = makeDeps();
  await dispatchTool({ name: 'registrar_setteo', input: { leads: [{ nombre: 'A B' }], fecha: '2027-01-01' } }, deps, { closer: SEBAS });
  assert.equal(deps.calls.guardar.fecha, '2026-08-03');

  await dispatchTool({ name: 'registrar_setteo', input: { leads: [{ nombre: 'C D' }], fecha: 'mañana' } }, deps, { closer: SEBAS });
  assert.equal(deps.calls.guardar.fecha, '2026-08-03');

  await dispatchTool({ name: 'registrar_setteo', input: { leads: [{ nombre: 'E F' }], fecha: '2026-08-01' } }, deps, { closer: SEBAS });
  assert.equal(deps.calls.guardar.fecha, '2026-08-01', 'una fecha pasada válida sí se respeta');
});

test('consultar_mis_setteos topea la ventana y pasa el closer del ctx', async () => {
  const deps = makeDeps();
  await dispatchTool({ name: 'consultar_mis_setteos', input: { dias: 9999 } }, deps, { closer: SEBAS });
  assert.equal(deps.calls.mis.dias, 90);
  assert.equal(deps.calls.mis.closer.email, 'sebastian@30x.com');

  await dispatchTool({ name: 'consultar_mis_setteos', input: {} }, deps, { closer: SEBAS });
  assert.equal(deps.calls.mis.dias, 1);
});

test('corregir_setteo filtra por el email del closer al buscar Y al escribir', async () => {
  const deps = makeDeps();
  await dispatchTool(
    { name: 'corregir_setteo', input: { nombre: 'María Gómez', accion: 'corregir', agendo: false } },
    deps,
    { closer: SEBAS }
  );
  assert.equal(deps.calls.list.closerEmail, 'sebastian@30x.com');
  assert.equal(deps.calls.update.closerEmail, 'sebastian@30x.com');
  assert.equal(deps.calls.update.id, 7);
  assert.equal(deps.calls.update.agendo, false);
});

test('corregir_setteo con accion=borrar borra, con el email en el filtro', async () => {
  const deps = makeDeps();
  const out = await dispatchTool({ name: 'corregir_setteo', input: { nombre: 'María Gómez', accion: 'borrar' } }, deps, { closer: SEBAS });
  assert.equal(deps.calls.del.closerEmail, 'sebastian@30x.com');
  assert.equal(deps.calls.del.id, 7);
  assert.match(out, /Borrado/);
});

test('corregir_setteo de un lead que no existe no rompe ni inventa', async () => {
  const deps = makeDeps({ listSetteosForCloser: async () => [] });
  const out = await dispatchTool({ name: 'corregir_setteo', input: { nombre: 'Nadie Aquí', accion: 'borrar' } }, deps, { closer: SEBAS });
  assert.match(out, /No encontré/);
  assert.equal(deps.calls.del, undefined);
});

// ─── Aislamiento del prompt ───────────────────────────────────────────────────

test('el prompt del closer no filtra memoria, roster ni datos del jefe', async () => {
  const deps = {
    getAllMemory: async () => [{ key: 'secreto_del_jefe', value: 'no debe salir' }],
    listPendingDrafts: async () => [{ id: 1, group_name: 'G', time_hm: '10:00', draft: 'borrador secreto' }],
    listPendingReplies: async () => [{ id: 2, group_name: 'G', trigger_sender: 'X', trigger_text: 't', draft: 'd' }],
    getUpcomingReminders: async () => [{ text: 'recordatorio del jefe', due_at: '2026-08-04 10:00:00' }],
    listBusinessContext: async () => [{ topic: 'proceso', fact: 'hecho interno del negocio' }],
    getRecentSummaries: async () => [{ group_name: 'G', summary: 'resumen privado' }],
  };
  const prompt = await buildSystemPrompt(deps, { role: 'closer', closerName: 'Sebastian Rodriguez' });

  for (const filtracion of ['no debe salir', 'borrador secreto', 'recordatorio del jefe', 'hecho interno del negocio', 'resumen privado']) {
    assert.ok(!prompt.includes(filtracion), `el prompt del closer no puede contener: ${filtracion}`);
  }
  // Y sí tiene lo suyo.
  assert.match(prompt, /CLOSER/);
  assert.match(prompt, /Sebastian Rodriguez/);
  assert.match(prompt, /setteo/i);
});

test('el prompt del closer le prohíbe inventar leads y ver los de otros', async () => {
  const prompt = await buildSystemPrompt({}, { role: 'closer', closerName: 'S' });
  assert.match(prompt, /NUNCA inventes un nombre de lead/);
  assert.match(prompt, /Solo puedes ver y tocar SUS setteos/);
  assert.match(prompt, /no cuenta para comisión/);
});
