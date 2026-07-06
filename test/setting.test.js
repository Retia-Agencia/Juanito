// test/setting.test.js
// Tests del ciclo de setteo (§18.AD) con __setDeps — sin Sheet/Twilio/DB reales.
//   node --test test/setting.test.js

import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.SETTING_TEMPLATE_ABOGADOS_TOUCH1 = 'HX1';
process.env.SETTING_TEMPLATE_ABOGADOS_TOUCH2 = 'HX2';

const { runSettingCycle, __setDeps, __resetDeps } = await import('../src/setting/index.js');

function makeWorld({ leads = [], bookedByKey = new Map(), due = [], optouts = [], paused = false, quiet = false } = {}) {
  const world = {
    scheduled: [], // { program, lead_key, touch_n, ... } de scheduleSettingTouch
    due: due.map((r) => ({ status: 'scheduled', ...r })),
    sent: [], // sendTemplate args
    boss: [], // FYI al jefe
    cancels: [],
    skips: [],
    reverts: [],
  };
  const optSet = new Set(optouts);
  const deps = {
    isSettingPaused: () => paused,
    fetchLeads: async () => ({ leads, bookedByKey }),
    isSettingOptedOut: (phone) => optSet.has(phone),
    scheduleSettingTouch: (p) => {
      const dup = world.scheduled.some((x) => x.program === p.program && x.lead_key === p.lead_key && x.touch_n === p.touch_n);
      world.scheduled.push(p);
      return dup ? 'exists' : 'new';
    },
    getDueSettingTouches: () => world.due.filter((r) => r.status === 'scheduled'),
    claimSettingTouch: (id) => {
      const r = world.due.find((x) => x.id === id);
      if (r && r.status === 'scheduled') {
        r.status = 'sending';
        return true;
      }
      return false;
    },
    revertSettingTouch: (id) => {
      const r = world.due.find((x) => x.id === id);
      if (r) r.status = 'scheduled';
      world.reverts.push(id);
    },
    markSettingSent: (id, msg) => {
      const r = world.due.find((x) => x.id === id);
      if (r) r.status = 'sent';
      return 1;
    },
    markSettingSkipped: (id, reason) => {
      const r = world.due.find((x) => x.id === id);
      if (r) r.status = 'skipped';
      world.skips.push({ id, reason });
    },
    cancelSettingTouches: (program, lead_key, reason) => {
      for (const r of world.due) if (r.program === program && r.lead_key === lead_key && r.status === 'scheduled') r.status = 'cancelled';
      world.cancels.push({ program, lead_key, reason });
    },
    sendTemplate: async (args) => {
      world.sent.push(args);
      return { sid: 'SM1' };
    },
    notifyTarget: async () => 'BOSS',
    sendBossMessage: async (t, x) => world.boss.push({ t, x }),
    isWithinQuietHours: () => quiet,
  };
  return { world, deps };
}

beforeEach(() => {
  process.env.SETTING_DRY_RUN = 'true';
});
afterEach(() => __resetDeps());

test('enrola: un lead reciente sin agendar agenda 2 toques', async () => {
  const now = new Date();
  const { world, deps } = makeWorld({
    leads: [{ program: 'abogados', lead_key: '573105551234', to_phone: '573105551234', to_name: 'Ana Pérez', submittedMs: now.getTime() - 3600 * 1000 }],
  });
  __setDeps(deps);
  const r = await runSettingCycle(now);
  assert.equal(r.enrolled, 2);
  assert.deepEqual(world.scheduled.map((x) => x.touch_n), [1, 2]);
  assert.equal(world.scheduled[0].program, 'abogados');
});

test('enrola: lead demasiado viejo NO se agenda', async () => {
  const now = new Date();
  const { world, deps } = makeWorld({
    leads: [{ program: 'abogados', lead_key: '57310', to_phone: '57310', to_name: 'X', submittedMs: now.getTime() - 100 * 3600 * 1000 }],
  });
  __setDeps(deps);
  const r = await runSettingCycle(now);
  assert.equal(r.enrolled, 0);
  assert.equal(world.scheduled.length, 0);
});

test('entrega DRY_RUN: marca sent sin llamar a la Cloud API', async () => {
  const now = new Date();
  const { world, deps } = makeWorld({
    due: [{ id: 1, program: 'abogados', lead_key: '573105551234', to_phone: '573105551234', to_name: 'Ana', touch_n: 1 }],
  });
  __setDeps(deps);
  const r = await runSettingCycle(now);
  assert.equal(r.sent, 1);
  assert.equal(world.sent.length, 0, 'DRY_RUN no llama a Twilio');
  assert.equal(world.due[0].status, 'sent');
});

test('entrega real: envía la plantilla y avisa al jefe', async () => {
  process.env.SETTING_DRY_RUN = 'false';
  const now = new Date();
  const { world, deps } = makeWorld({
    due: [{ id: 1, program: 'abogados', lead_key: '573105551234', to_phone: '573105551234', to_name: 'Ana Pérez', touch_n: 1 }],
  });
  __setDeps(deps);
  const r = await runSettingCycle(now);
  assert.equal(r.sent, 1);
  assert.equal(world.sent.length, 1);
  assert.deepEqual(world.sent[0], { to: '573105551234', contentSid: 'HX1', vars: { 1: 'Ana' } });
  assert.equal(world.boss.length, 1, 'FYI al jefe');
  assert.match(world.boss[0].x, /Setteo \(abogados\) toque 1/);
});

test('re-check: si el lead ya agendó, cancela y no envía', async () => {
  process.env.SETTING_DRY_RUN = 'false';
  const now = new Date();
  const { world, deps } = makeWorld({
    bookedByKey: new Map([['573105551234', true]]),
    due: [{ id: 1, program: 'abogados', lead_key: '573105551234', to_phone: '573105551234', to_name: 'Ana', touch_n: 2 }],
  });
  __setDeps(deps);
  const r = await runSettingCycle(now);
  assert.equal(r.sent, 0);
  assert.equal(world.sent.length, 0);
  assert.equal(world.cancels.length, 1);
  assert.equal(world.cancels[0].reason, 'ya-agendo');
});

test('opt-out: número de baja se salta y se cancela', async () => {
  process.env.SETTING_DRY_RUN = 'false';
  const now = new Date();
  const { world, deps } = makeWorld({
    optouts: ['573105551234'],
    due: [{ id: 1, program: 'abogados', lead_key: '573105551234', to_phone: '573105551234', to_name: 'Ana', touch_n: 1 }],
  });
  __setDeps(deps);
  await runSettingCycle(now);
  assert.equal(world.sent.length, 0);
  assert.equal(world.cancels[0].reason, 'optout');
});

test('sin plantilla configurada: el toque se salta (no inventa texto)', async () => {
  process.env.SETTING_DRY_RUN = 'false';
  delete process.env.SETTING_TEMPLATE_ABOGADOS_TOUCH2;
  const now = new Date();
  const { world, deps } = makeWorld({
    due: [{ id: 5, program: 'abogados', lead_key: '57310', to_phone: '57310', to_name: 'Z', touch_n: 2 }],
  });
  __setDeps(deps);
  await runSettingCycle(now);
  assert.equal(world.sent.length, 0);
  assert.equal(world.skips[0].reason, 'sin-plantilla');
  process.env.SETTING_TEMPLATE_ABOGADOS_TOUCH2 = 'HX2'; // restaurar
});

test('quiet hours: no envía y deja el toque scheduled (pausa)', async () => {
  process.env.SETTING_DRY_RUN = 'false';
  const now = new Date();
  const { world, deps } = makeWorld({
    quiet: true,
    due: [{ id: 1, program: 'abogados', lead_key: '57310', to_phone: '57310', to_name: 'Z', touch_n: 1 }],
  });
  __setDeps(deps);
  await runSettingCycle(now);
  assert.equal(world.sent.length, 0);
  assert.equal(world.due[0].status, 'scheduled', 'no avanza: reintenta al salir del descanso');
});

test('pausa global: no enrola ni entrega', async () => {
  const now = new Date();
  const { world, deps } = makeWorld({
    paused: true,
    leads: [{ program: 'abogados', lead_key: '57310', to_phone: '57310', to_name: 'Z', submittedMs: now.getTime() - 1000 }],
    due: [{ id: 1, program: 'abogados', lead_key: '57311', to_phone: '57311', to_name: 'Y', touch_n: 1 }],
  });
  __setDeps(deps);
  const r = await runSettingCycle(now);
  assert.deepEqual(r, { enrolled: 0, sent: 0 });
  assert.equal(world.scheduled.length, 0);
  assert.equal(world.due[0].status, 'scheduled');
});
