// test/group-messages.test.js
// Tests PUROS del ciclo de mensajes programados (fixed + generated con aprobación).
// Usa __setDeps para inyectar DB/WA/Claude falsos — sin better-sqlite3, sin red.
// Corre nativo en Windows: node --test test/group-messages.test.js

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.BOSS_PHONE = '573000000001';
process.env.TZ = 'America/Bogota';

const { runScheduledMessagesCycle, __setDeps, __resetDeps } = await import(
  '../src/scheduler/group-messages.js'
);

// Jueves 2026-06-11. Las horas de abajo son hora Bogotá (UTC-5).
const bogota = (hm) => new Date(`2026-06-11T${hm}:00-05:00`);

// Doble del mundo: store en memoria con la misma semántica que la DB real.
function makeWorld({ rows = [], authorized = true } = {}) {
  const world = {
    rows,
    drafts: [],
    settings: {},
    sent: [], // { to, text }
    generated: 0,
    nextDraftId: 1,
  };
  const deps = {
    listScheduledMessages: () => world.rows.filter((r) => r.active !== 0),
    markScheduledMessageSent: (id, date) => {
      const r = world.rows.find((x) => x.id === id);
      if (r) r.last_sent_date = date;
    },
    isGroupAuthorized: () => authorized,
    createDraft: ({ scheduledId, publishDate, draft }) => {
      if (world.drafts.some((d) => d.scheduled_id === scheduledId && d.publish_date === publishDate)) return null;
      const row = {
        id: world.nextDraftId++,
        scheduled_id: scheduledId,
        publish_date: publishDate,
        draft,
        status: 'pending',
        reminded: 0,
      };
      world.drafts.push(row);
      return row.id;
    },
    getDraftFor: (scheduledId, publishDate) =>
      world.drafts.find((d) => d.scheduled_id === scheduledId && d.publish_date === publishDate) || null,
    markDraftPublished: (id) => {
      const d = world.drafts.find((x) => x.id === id);
      if (d && d.status === 'approved') {
        d.status = 'published';
        return 1;
      }
      return 0;
    },
    markDraftReminded: (id) => {
      const d = world.drafts.find((x) => x.id === id);
      if (d) d.reminded = 1;
    },
    listRecentPublishedDrafts: () => [],
    getSetting: (key, def) => world.settings[key] ?? def,
    sendMessage: async (to, text) => world.sent.push({ to, text }),
    generateScheduledDraft: async ({ brief }) => {
      world.generated++;
      return `GENERADO[${brief}]#${world.generated}`;
    },
  };
  return { world, deps };
}

const FIXED = { id: 1, group_id: 'patah@g.us', group_name: 'Patah', days: '4', time_hm: '20:00', text: 'Invitación fija', last_sent_date: null, active: 1, kind: 'fixed' };
const GENERATED = { id: 2, group_id: 'patah@g.us', group_name: 'Patah', days: '4', time_hm: '09:00', text: '', last_sent_date: null, active: 1, kind: 'generated', brief: 'San José' };

afterEach(() => __resetDeps());

test('fixed: publica a la hora, una sola vez', async () => {
  const { world, deps } = makeWorld({ rows: [{ ...FIXED }] });
  __setDeps(deps);
  assert.equal(await runScheduledMessagesCycle(bogota('20:00')), 1);
  assert.deepEqual(world.sent, [{ to: 'patah@g.us', text: 'Invitación fija' }]);
  assert.equal(await runScheduledMessagesCycle(bogota('20:01')), 0, 'no repite el mismo día');
});

test('generated: a la hora del lead genera el borrador y se lo manda al JEFE (no al grupo)', async () => {
  const { world, deps } = makeWorld({ rows: [{ ...GENERATED }] });
  __setDeps(deps);
  const sent = await runScheduledMessagesCycle(bogota('08:00'));
  assert.equal(sent, 0, 'no publica nada aún');
  assert.equal(world.drafts.length, 1);
  assert.equal(world.drafts[0].status, 'pending');
  assert.equal(world.sent.length, 1);
  assert.equal(world.sent[0].to, process.env.BOSS_PHONE, 'el borrador va al jefe');
  assert.match(world.sent[0].text, /Borrador #1/);
  assert.match(world.sent[0].text, /GENERADO\[San José\]/);

  // El siguiente ciclo NO regenera (dedup por draft existente).
  await runScheduledMessagesCycle(bogota('08:01'));
  assert.equal(world.generated, 1);
  assert.equal(world.sent.length, 1);
});

test('generated: SIN aprobación no publica a la hora; recuerda al jefe UNA vez', async () => {
  const { world, deps } = makeWorld({ rows: [{ ...GENERATED }] });
  __setDeps(deps);
  await runScheduledMessagesCycle(bogota('08:00')); // genera
  world.sent = [];

  await runScheduledMessagesCycle(bogota('09:00')); // hora de publicar, sigue pending
  assert.equal(world.sent.length, 1, 'manda recordatorio');
  assert.equal(world.sent[0].to, process.env.BOSS_PHONE);
  assert.match(world.sent[0].text, /SIN aprobar/);

  await runScheduledMessagesCycle(bogota('09:05'));
  assert.equal(world.sent.length, 1, 'el recordatorio es UNA sola vez');
  assert.ok(!world.sent.some((s) => s.to === 'patah@g.us'), 'el grupo nunca recibió nada');
});

test('generated: aprobado antes de la hora → publica exactamente a la hora', async () => {
  const { world, deps } = makeWorld({ rows: [{ ...GENERATED }] });
  __setDeps(deps);
  await runScheduledMessagesCycle(bogota('08:00')); // genera
  world.drafts[0].status = 'approved'; // el jefe aprobó por DM
  world.sent = [];

  assert.equal(await runScheduledMessagesCycle(bogota('08:30')), 0, 'antes de la hora no publica');
  assert.equal(await runScheduledMessagesCycle(bogota('09:00')), 1);
  assert.deepEqual(world.sent, [{ to: 'patah@g.us', text: world.drafts[0].draft }]);
  assert.equal(world.drafts[0].status, 'published');
  assert.equal(await runScheduledMessagesCycle(bogota('09:01')), 0, 'no repite');
});

test('generated: aprobación TARDÍA publica en el siguiente ciclo del mismo día', async () => {
  const { world, deps } = makeWorld({ rows: [{ ...GENERATED }] });
  __setDeps(deps);
  await runScheduledMessagesCycle(bogota('08:00')); // genera
  await runScheduledMessagesCycle(bogota('09:00')); // recordatorio (pending)
  world.sent = [];

  world.drafts[0].status = 'approved'; // el jefe aprueba a las 11
  assert.equal(await runScheduledMessagesCycle(bogota('11:00')), 1, 'publica tarde el mismo día');
  assert.equal(world.sent[0].to, 'patah@g.us');
});

test('generated: grupo no autorizado NO recibe ni aprobado', async () => {
  const { world, deps } = makeWorld({ rows: [{ ...GENERATED }], authorized: false });
  __setDeps(deps);
  await runScheduledMessagesCycle(bogota('08:00'));
  world.drafts[0].status = 'approved';
  world.sent = [];
  assert.equal(await runScheduledMessagesCycle(bogota('09:00')), 0);
  assert.equal(world.sent.length, 0);
});

test('re-entrancy: dos ciclos solapados NO generan el borrador dos veces', async () => {
  const { world, deps } = makeWorld({ rows: [{ ...GENERATED }] });
  deps.generateScheduledDraft = async ({ brief }) => {
    world.generated++;
    await new Promise((r) => setTimeout(r, 20)); // generación "lenta": el 1º ciclo sigue en curso
    return `GENERADO[${brief}]#${world.generated}`;
  };
  __setDeps(deps);
  const p1 = runScheduledMessagesCycle(bogota('08:00')); // arranca y queda generando
  const p2 = runScheduledMessagesCycle(bogota('08:00')); // entra mientras p1 corre → guarda lo salta
  const [, s2] = await Promise.all([p1, p2]);
  assert.equal(world.generated, 1, 'una sola generación pese a dos ciclos solapados');
  assert.equal(world.drafts.length, 1, 'un solo borrador creado');
  assert.equal(s2, 0, 'el ciclo saltado devuelve 0');
});

test('un fallo en una fila no rompe el resto del ciclo', async () => {
  const { world, deps } = makeWorld({ rows: [{ ...FIXED, id: 9, text: 'boom' }, { ...FIXED, id: 10, text: 'ok' }] });
  const origSend = deps.sendMessage;
  deps.sendMessage = async (to, text) => {
    if (text === 'boom') throw new Error('falló WA');
    return origSend(to, text);
  };
  __setDeps(deps);
  assert.equal(await runScheduledMessagesCycle(bogota('20:00')), 1, 'la fila sana se envía');
  assert.equal(world.rows.find((r) => r.id === 9).last_sent_date, null, 'la fallida NO se marca (reintenta)');
});
