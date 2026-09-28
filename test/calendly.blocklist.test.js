// test/calendly.blocklist.test.js
// Lista negra de leads: el troll que agenda ~20 veces con el mismo número ("Gerardo",
// +52 871 518 5780) no le genera pushes al closer — ni el individual ni la línea del digest.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.CALENDLY_REQUIRE_OPTIN = 'true';
process.env.CALENDLY_DRY_RUN = 'false';

const { isBlockedPhone, anyBlockedPhone, mentionsBlockedPhone, claveTelefono } = await import(
  '../src/calendly/blocklist.js'
);
const scheduler = await import('../src/scheduler/calendly.js');
const { installHarness, makeEvent } = await import('./helpers/calendly-harness.js');
const { CLOSERS } = await import('../src/calendly/closers.js');

beforeEach(() => {
  delete process.env.CALENDLY_BLOCKED_PHONES;
});

// ─── Puro ─────────────────────────────────────────────────────────────────────

test('el número del troll se reconoce en todas sus formas', () => {
  for (const f of ['+52 871 518 5780', '528715185780', '5218715185780', '871-518-5780', '(871) 518 5780']) {
    assert.ok(isBlockedPhone(f), f);
  }
});

test('un número cualquiera, vacío o corto no está bloqueado', () => {
  assert.equal(isBlockedPhone('+573001112233'), false);
  assert.equal(isBlockedPhone(''), false);
  assert.equal(isBlockedPhone(null), false);
  assert.equal(isBlockedPhone('5780'), false);
  assert.equal(claveTelefono('12345'), null);
});

test('CALENDLY_BLOCKED_PHONES suma números sin tocar el código', () => {
  assert.equal(isBlockedPhone('+57 300 999 8877'), false);
  process.env.CALENDLY_BLOCKED_PHONES = '+57 300 999 8877, 3110000000';
  assert.ok(isBlockedPhone('573009998877'));
  assert.ok(isBlockedPhone('+57 311 000 0000'));
  assert.ok(isBlockedPhone('+52 871 518 5780'), 'la lista del código sigue valiendo');
});

test('anyBlockedPhone: con que uno de los dos números sea del troll alcanza', () => {
  assert.ok(anyBlockedPhone(['+573001112233', '+52 871 518 5780']));
  assert.equal(anyBlockedPhone(['+573001112233', null]), false);
});

test('mentionsBlockedPhone lo encuentra en claro y en el link wa.me, sin falsos positivos por la hora', () => {
  assert.ok(mentionsBlockedPhone('📞 +52 871 518 5780'));
  assert.ok(mentionsBlockedPhone('👉 https://wa.me/528715185780?text=hola'));
  assert.equal(mentionsBlockedPhone('10:30 am · 📞 +57 300 111 2233'), false);
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

const OPERACIONES_ET = 'https://api.calendly.com/event_types/8462e92a-8210-4bb2-8e2b-583aa3c3d877';
const CLOSER = { email: 'pablo.lozano@30x.com', phone: CLOSERS['pablo.lozano@30x.com'].phone };

function armar(prospectPhone) {
  const now = Date.parse('2026-08-26T14:00:00Z');
  const h = installHarness(scheduler, {
    nowMs: now,
    optins: [{ phone: CLOSER.phone, source: 'self', contactJid: '111@lid' }],
    events: [
      makeEvent({
        uuid: 'e-troll',
        startInMin: 10,
        closerEmail: CLOSER.email,
        eventType: OPERACIONES_ET,
        prospectName: 'Gerardo',
        prospectPhone,
        nowMs: now,
      }),
    ],
  });
  scheduler.__setDeps(h.deps);
  return h;
}

test('push de un lead en lista negra: no se envía y queda skipped con slug "bloqueado"', async () => {
  const { store, wa } = armar('+52 871 518 5780');
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();

  const filas = store._rows.filter((r) => r.event_uuid === 'e-troll');
  assert.ok(filas.length, 'el poll igual registra la cita');
  const debidas = filas.filter((r) => r.status !== 'scheduled');
  assert.ok(debidas.length, 'algún push venció en este tick');
  for (const r of debidas) {
    assert.equal(r.status, 'skipped');
    assert.equal(r.skip_reason, 'bloqueado');
  }
  assert.equal(wa.sent.length, 0, 'al closer no le llegó nada');
});

test('control: el mismo escenario con un lead normal sí entrega', async () => {
  const { wa } = armar('+573001112233');
  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();
  assert.ok(wa.sent.length > 0);
});

// ─── Digest (Push 1/2) ────────────────────────────────────────────────────────

const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';
const hoy = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const zulu = (hhmm) => `${hoy()}T${hhmm}:00.000Z`;

test('digest Push 2: la cita del troll no aparece; la del lead normal sí', async () => {
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_PUSH4_ENABLED = 'false';
  scheduler.__resetDeps();
  const h = installHarness(scheduler, {
    nowMs: Date.parse(zulu('11:30')),
    optins: [SALAZAR_PHONE],
    events: [
      makeEvent({ uuid: 'c1', startIso: zulu('15:00'), closerEmail: SALAZAR, prospectName: 'Ana Gómez', prospectPhone: '+573001112222' }),
      makeEvent({ uuid: 'c2', startIso: zulu('16:00'), closerEmail: SALAZAR, prospectName: 'Gerardo Troll', prospectPhone: '+52 871 518 5780' }),
    ],
  });
  scheduler.__setDeps(h.deps);

  await scheduler.runPush2();

  assert.equal(h.wa.sent.length, 1);
  const texto = h.wa.sent[0].text;
  assert.match(texto, /tienes 1 llamada/);
  assert.match(texto, /Ana Gómez/);
  assert.doesNotMatch(texto, /Gerardo/);
});

test('digest Push 2: si la única cita del closer es del troll, no hay digest', async () => {
  scheduler.__resetDeps();
  const h = installHarness(scheduler, {
    nowMs: Date.parse(zulu('11:30')),
    optins: [SALAZAR_PHONE],
    events: [
      makeEvent({ uuid: 'c2', startIso: zulu('16:00'), closerEmail: SALAZAR, prospectName: 'Gerardo Troll', prospectPhone: '+52 871 518 5780' }),
    ],
  });
  scheduler.__setDeps(h.deps);

  await scheduler.runPush2();
  assert.equal(h.wa.sent.length, 0);
});
