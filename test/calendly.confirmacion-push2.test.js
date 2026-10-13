// test/calendly.confirmacion-push2.test.js
// §18.CN — después del Push 2 sale la pregunta "¿quiénes te confirmaron?".
//
// Tier 1: harness (sin DB nativa, sin red, sin WhatsApp real). Lo que se fija:
//   1. con la bandera, al Push 2 lo sigue la pregunta, numerada por hora, y el lote se guarda
//      con el id de cada cita (uuid de Calendly / hubspot:<id>) ANTES de mandarla;
//   2. sin la bandera (o para otra conexión) el Push 2 sale exactamente como antes;
//   3. si el Push 2 no se entregó, no se pregunta nada.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

// Closer de fixture del harness (conexión 'estadox', ver calendly.digest-hubspot.test.js).
const SALAZAR = 'sebastian.salazar@30x.com';
const SALAZAR_PHONE = '+573054312905';
const OWNER_ID = '77001';

const hoy = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const zulu = (hhmm) => `${hoy()}T${hhmm}:00.000Z`;
const NOW = () => Date.parse(zulu('11:30')); // 06:30 Bogotá

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH4_ENABLED = 'false';
  process.env.ADMIN_LID = '129446371655733@lid';
  __resetHealth();
  scheduler.__resetDeps();
});
afterEach(() => {
  delete process.env.CALENDLY_CONFIRMACION_PUSH2;
});

function montar({ optins = [SALAZAR_PHONE] } = {}) {
  const events = [
    makeEvent({ uuid: 'c-tarde', startIso: zulu('20:00'), closerEmail: SALAZAR, prospectName: 'Laura Ríos' }),
    makeEvent({ uuid: 'c-manana', startIso: zulu('15:00'), closerEmail: SALAZAR, prospectName: 'Ana Gómez' }),
  ];
  const h = installHarness(scheduler, { events, optins, nowMs: NOW() });
  const lotes = [];
  scheduler.__setDeps({
    ...h.deps,
    hubspotEnabled: () => true,
    async searchMeetingsInWindow() {
      return [{
        id: 'm9',
        properties: {
          hubspot_owner_id: OWNER_ID,
          hs_meeting_title: 'Entrevista de Postulación Programa AI Second Brain',
          hs_meeting_start_time: String(Date.parse(zulu('17:00'))),
          hs_createdate: new Date(NOW() - 86400000).toISOString(),
        },
      }];
    },
    async getOwnerEmailMap() {
      return { [OWNER_ID]: SALAZAR };
    },
    async getMeetingContact() {
      return { name: 'Beto Ruiz', phone: '+573001112222' };
    },
    guardarLoteConfirmacion(filas) {
      lotes.push({ filas, enviadosAntes: h.wa.sent.length });
    },
  });
  return { h, lotes };
}

test('con la bandera: al Push 2 lo sigue la pregunta y el lote queda guardado', async () => {
  process.env.CALENDLY_CONFIRMACION_PUSH2 = 'estadox';
  const { h, lotes } = montar();

  await scheduler.runPush2();

  assert.equal(h.wa.sent.length, 2, 'Push 2 + pregunta');
  const pregunta = h.wa.sent[1].text;
  assert.match(pregunta, /¿Quiénes te confirmaron hoy\?/);
  assert.ok(pregunta.indexOf('1. ') < pregunta.indexOf('Ana Gómez'));
  assert.ok(pregunta.indexOf('Ana Gómez') < pregunta.indexOf('Beto Ruiz'), 'numerada por hora');
  assert.ok(pregunta.indexOf('Beto Ruiz') < pregunta.indexOf('Laura Ríos'));

  assert.equal(lotes.length, 1);
  assert.equal(lotes[0].enviadosAntes, 1, 'el lote se guarda antes de mandar la pregunta');
  const filas = lotes[0].filas;
  assert.deepEqual(filas.map((f) => f.posicion), [1, 2, 3]);
  assert.deepEqual(filas.map((f) => f.event_uuid), ['c-manana', 'hubspot:m9', 'c-tarde']);
  assert.ok(filas.every((f) => f.closer_email === SALAZAR && f.lote.endsWith(`:${hoy()}`)));
});

test('sin la bandera, o para otra conexión: el Push 2 sale solo', async () => {
  for (const v of [undefined, '30x']) {
    if (v) process.env.CALENDLY_CONFIRMACION_PUSH2 = v;
    const { h, lotes } = montar();
    await scheduler.runPush2();
    assert.equal(h.wa.sent.length, 1, `bandera=${v}`);
    assert.equal(lotes.length, 0);
  }
});

test('si el Push 2 no se entregó (sin opt-in), no se pregunta', async () => {
  process.env.CALENDLY_CONFIRMACION_PUSH2 = 'estadox';
  const { h, lotes } = montar({ optins: [] });
  await scheduler.runPush2();
  assert.equal(h.wa.sent.length, 0);
  assert.equal(lotes.length, 0);
});
