// test/outreach.test.js
// Tests PUROS del ciclo de mensajes a terceros (schedule_outreach → outreach.js).
// Usa __setDeps para inyectar DB/WA/Claude falsos — sin better-sqlite3, sin red.
// Corre nativo en Windows: node --test test/outreach.test.js

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.TZ = 'America/Bogota';

const { runOutreachCycle, __setDeps, __resetDeps } = await import('../src/scheduler/outreach.js');

const BOSS = '573000000001';
// Jueves 2026-06-11. Las horas son hora Bogotá (UTC-5).
const bogota = (hm) => new Date(`2026-06-11T${hm}:00-05:00`);

function makeWorld({ rows = [], quiet = false } = {}) {
  const world = { rows, sent: [] }; // sent: { to, text }
  const deps = {
    listActiveOutreach: () => world.rows.filter((r) => r.active !== 0),
    markOutreachSent: (id, { nextDueAt = null, lastSentDate = null } = {}) => {
      const r = world.rows.find((x) => x.id === id);
      if (!r) return;
      r.sent_count = (r.sent_count || 0) + 1;
      if (nextDueAt != null) r.next_due_at = nextDueAt;
      if (lastSentDate != null) r.last_sent_date = lastSentDate;
    },
    finishOutreach: (id, status = 'done') => {
      const r = world.rows.find((x) => x.id === id);
      if (r) {
        r.active = 0;
        r.status = status;
      }
      return 1;
    },
    sendMessage: async (to, text) => world.sent.push({ to, text }),
    generateOutreachMessage: async ({ intent, fromName = null }) => `MSG[${intent}${fromName ? ` de ${fromName}` : ''}]`,
    bossTarget: async () => BOSS,
    isWithinQuietHours: () => quiet,
  };
  return { world, deps };
}

afterEach(() => __resetDeps());

test('once: envía al tercero, avisa al jefe y cierra (done)', async () => {
  const { world, deps } = makeWorld({
    rows: [{ id: 1, to_phone: '57300', to_name: 'Sebas', intent: 'que confirme', recur_kind: 'once', due_at: '2026-06-11 09:00:00', respect_quiet: 1, active: 1 }],
  });
  __setDeps(deps);
  assert.equal(await runOutreachCycle(bogota('09:00')), 1);
  assert.deepEqual(world.sent[0], { to: '57300', text: 'MSG[que confirme]' });
  assert.equal(world.sent[1].to, BOSS, 'le avisa al jefe');
  assert.match(world.sent[1].text, /Le escribí a Sebas/);
  assert.equal(world.rows[0].active, 0);
  assert.equal(world.rows[0].status, 'done');
  // No repite.
  world.sent = [];
  assert.equal(await runOutreachCycle(bogota('09:05')), 0);
  assert.equal(world.sent.length, 0);
});

test('le avisa al CREADOR (created_by) y el mensaje va de parte del sender_name (admin)', async () => {
  const ADMIN = '573009998877@lid';
  const { world, deps } = makeWorld({
    rows: [{ id: 9, to_phone: '57300', to_name: 'Sebas', intent: 'que confirme', recur_kind: 'once', due_at: '2026-06-11 09:00:00', respect_quiet: 1, active: 1, created_by: ADMIN, sender_name: 'Alejandro' }],
  });
  __setDeps(deps);
  await runOutreachCycle(bogota('09:00'));
  assert.equal(world.sent[0].to, '57300', 'le escribe al tercero');
  assert.match(world.sent[0].text, /de Alejandro/, 'el mensaje va de parte del creador (admin), no del jefe');
  assert.equal(world.sent[1].to, ADMIN, 'el aviso va al admin creador, no al jefe');
});

test('interval: envía y avanza next_due_at (+interval_min)', async () => {
  const { world, deps } = makeWorld({
    rows: [{ id: 2, to_phone: '57300', to_name: 'Sebas', intent: 'recordatorio', recur_kind: 'interval', interval_min: 40, next_due_at: '2026-06-11 09:00:00', until_at: '2026-06-11 18:00:00', sent_count: 0, respect_quiet: 1, active: 1 }],
  });
  __setDeps(deps);
  assert.equal(await runOutreachCycle(bogota('09:00')), 1);
  assert.equal(world.rows[0].active, 1, 'sigue activo');
  assert.match(world.rows[0].next_due_at, /^2026-06-11 09:40:00$/, 'próxima a +40 min');
  // Aún no es la próxima → no envía.
  world.sent = [];
  assert.equal(await runOutreachCycle(bogota('09:20')), 0);
});

test('interval: al llegar a max_count cierra (done)', async () => {
  const { world, deps } = makeWorld({
    rows: [{ id: 3, to_phone: '57300', to_name: 'Sebas', intent: 'x', recur_kind: 'interval', interval_min: 40, next_due_at: '2026-06-11 09:00:00', max_count: 2, sent_count: 1, respect_quiet: 1, active: 1 }],
  });
  __setDeps(deps);
  assert.equal(await runOutreachCycle(bogota('09:00')), 1);
  assert.equal(world.rows[0].active, 0, 'alcanzó el tope de veces');
  assert.equal(world.rows[0].status, 'done');
});

test('interval: si until ya pasó, cierra SIN enviar', async () => {
  const { world, deps } = makeWorld({
    rows: [{ id: 4, to_phone: '57300', to_name: 'Sebas', intent: 'x', recur_kind: 'interval', interval_min: 40, next_due_at: '2026-06-11 07:30:00', until_at: '2026-06-11 08:00:00', sent_count: 1, respect_quiet: 1, active: 1 }],
  });
  __setDeps(deps);
  assert.equal(await runOutreachCycle(bogota('09:00')), 0);
  assert.equal(world.sent.length, 0, 'no escribe al tercero');
  assert.equal(world.rows[0].active, 0);
  assert.equal(world.rows[0].status, 'done');
});

test('quiet hours: una fila que las respeta NO escribe ni avanza (pausa)', async () => {
  const { world, deps } = makeWorld({
    quiet: true,
    rows: [{ id: 5, to_phone: '57300', to_name: 'Sebas', intent: 'x', recur_kind: 'interval', interval_min: 40, next_due_at: '2026-06-11 09:00:00', until_at: '2026-06-11 23:59:00', sent_count: 0, respect_quiet: 1, active: 1 }],
  });
  __setDeps(deps);
  assert.equal(await runOutreachCycle(bogota('09:00')), 0);
  assert.equal(world.sent.length, 0);
  assert.equal(world.rows[0].active, 1, 'sigue activo: reanuda al salir del descanso');
  assert.equal(world.rows[0].sent_count, 0, 'no avanzó');
});

test('daily: envía a la hora una sola vez ese día', async () => {
  const { world, deps } = makeWorld({
    rows: [{ id: 6, to_phone: '57300', to_name: 'Sebas', intent: 'buenos días', recur_kind: 'daily', days: '4', time_hm: '09:00', last_sent_date: null, respect_quiet: 1, active: 1 }],
  });
  __setDeps(deps);
  assert.equal(await runOutreachCycle(bogota('09:00')), 1);
  assert.equal(world.rows[0].last_sent_date, '2026-06-11');
  world.sent = [];
  assert.equal(await runOutreachCycle(bogota('09:05')), 0, 'no repite el mismo día');
});

test('un fallo en una fila no rompe el resto del ciclo', async () => {
  const { world, deps } = makeWorld({
    rows: [
      { id: 7, to_phone: 'boom', to_name: 'A', intent: 'boom', recur_kind: 'once', due_at: '2026-06-11 09:00:00', respect_quiet: 1, active: 1 },
      { id: 8, to_phone: 'ok', to_name: 'B', intent: 'ok', recur_kind: 'once', due_at: '2026-06-11 09:00:00', respect_quiet: 1, active: 1 },
    ],
  });
  const origSend = deps.sendMessage;
  deps.sendMessage = async (to, text) => {
    if (to === 'boom') throw new Error('falló WA');
    return origSend(to, text);
  };
  __setDeps(deps);
  assert.equal(await runOutreachCycle(bogota('09:00')), 1, 'la fila sana se envía');
  assert.equal(world.rows[0].active, 1, 'la fallida NO se cierra (reintenta)');
  assert.equal(world.rows[1].active, 0, 'la sana se cerró');
});

// ─── Auditoría 2026-08-26, hallazgo 06 ───────────────────────────────────────
// El estado avanzaba DESPUÉS del FYI al creador. Si el mensaje principal salía pero el
// aviso fallaba, la fila no avanzaba y al minuto siguiente el cron le VOLVÍA A ESCRIBIR al
// tercero. Un mensaje repetido a alguien de afuera: nadie del equipo lo ve y quema la
// reputación del número.

// Falla el segundo sendMessage (el FYI) y solo ese.
function conFyiRoto({ rows, quien = null }) {
  const { world, deps } = makeWorld({ rows });
  const real = deps.sendMessage;
  deps.sendMessage = async (to, text) => {
    if (to === (quien ?? BOSS)) throw new Error('el JID del creador está muerto');
    return real(to, text);
  };
  return { world, deps };
}

test('si el FYI falla, al tercero NO se le escribe dos veces (once)', async () => {
  const fila = { id: 1, to_phone: '57300', to_name: 'Sebas', intent: 'que confirme', recur_kind: 'once', due_at: '2026-06-11 09:00:00', respect_quiet: 1, active: 1 };
  const { world, deps } = conFyiRoto({ rows: [fila] });
  __setDeps(deps);

  await runOutreachCycle(bogota('09:00'));
  assert.equal(world.sent.filter((m) => m.to === '57300').length, 1, 'salió una vez');
  assert.equal(world.rows[0].active, 0, 'la fila SÍ avanzó aunque el aviso falló');
  assert.equal(world.rows[0].status, 'done');

  // El minuto siguiente: el bug era acá.
  await runOutreachCycle(bogota('09:01'));
  assert.equal(
    world.sent.filter((m) => m.to === '57300').length,
    1,
    'el tercero NO recibe el mensaje repetido'
  );
});

test('si el FYI falla en una fila recurrente, tampoco se repite el envío', async () => {
  const fila = { id: 2, to_phone: '57301', to_name: 'Ana', intent: 'recordale', recur_kind: 'interval', interval_min: 60, next_due_at: '2026-06-11 09:00:00', respect_quiet: 1, active: 1, sent_count: 0 };
  const { world, deps } = conFyiRoto({ rows: [fila] });
  __setDeps(deps);

  await runOutreachCycle(bogota('09:00'));
  assert.equal(world.sent.filter((m) => m.to === '57301').length, 1);
  assert.equal(world.rows[0].sent_count, 1, 'contó el envío');
  assert.ok(world.rows[0].next_due_at > '2026-06-11 09:00:00', 'y corrió la próxima fecha');

  await runOutreachCycle(bogota('09:05'));
  assert.equal(world.sent.filter((m) => m.to === '57301').length, 1, 'sin repetido a Ana');
});

// La contrapartida: un fallo ANTES del envío principal sí tiene que reintentar. Sin esto,
// el arreglo de arriba se podría "lograr" avanzando el estado siempre, que sería peor.
test('si el envío PRINCIPAL falla, la fila NO avanza y se reintenta', async () => {
  const fila = { id: 3, to_phone: '57302', to_name: 'Caro', intent: 'saluda', recur_kind: 'once', due_at: '2026-06-11 09:00:00', respect_quiet: 1, active: 1 };
  const { world, deps } = makeWorld({ rows: [fila] });
  let caido = true;
  const real = deps.sendMessage;
  deps.sendMessage = async (to, text) => {
    if (to === '57302' && caido) throw new Error('WhatsApp caído');
    return real(to, text);
  };
  __setDeps(deps);

  assert.equal(await runOutreachCycle(bogota('09:00')), 0);
  assert.equal(world.rows[0].active, 1, 'la fila sigue viva');
  assert.equal(world.sent.length, 0);

  caido = false;
  assert.equal(await runOutreachCycle(bogota('09:01')), 1, 'lo reintenta y sale');
  assert.equal(world.sent[0].to, '57302');
});
