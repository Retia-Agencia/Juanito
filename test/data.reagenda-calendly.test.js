// test/data.reagenda-calendly.test.js
// §18.BW — el SQL de la reagenda hecha en Calendly, contra la DB real.
// REQUIERE better-sqlite3 nativo → corre en Docker/VPS (igual que data.outcomes.test.js).
//
// Lo que se fija acá es la mitad que NO se ve: cuando una call se mueve, su fila vieja tiene
// que dejar de existir para TODOS los que leen esta tabla, no solo para la entrega del Push 3.
// Push 1, Push 2 y la agenda del jefe salen de `getScheduledCallsInWindow`, así que una fila
// vieja que sobreviva ahí es un fantasma que el closer ve en su lista del día.
//
// DB propia a propósito: `data.scheduled-calls.test.js` comparte una entre tests y ahí ya hay
// dos fixtures que chocan entre sí. No se le suma equipaje.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cal-reagenda-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  db = await import('../src/db/index.js');
});

after(() => rmSync(dir, { recursive: true, force: true }));

const VENCIDO = '2020-01-01 00:00:00';
const VIEJO = '5dfbeed1-920a-43c7-8672-f798e8bde715';
const NUEVO = '9164800c-9606-49a3-ae77-98800cfee921';

// Ventanas de día en Bogotá (UTC-5), como las arma dayRangeUtc.
const JUE_4 = ['2026-09-04 05:00:00', '2026-09-05 05:00:00'];
const VIE_5 = ['2026-09-05 05:00:00', '2026-09-06 05:00:00'];

const push = (over = {}) => ({
  event_uuid: VIEJO,
  push_n: 3,
  program: 'tactical_investor',
  closer_email: 'registro@ttrading.co',
  closer_phone: '+573132484664',
  prospect_name: 'Juan Ferrujo',
  prospect_phone: '+573142653368',
  call_start: '2026-09-04 15:30:00',
  due_at: VENCIDO,
  message: 'push',
  ...over,
});

test('getPushesByEventUuid devuelve TODAS las filas de la cita, en cualquier estado', () => {
  db.scheduleCalendlyPush(push({ push_n: 0 }));
  db.scheduleCalendlyPush(push({ push_n: 3 }));
  db.scheduleCalendlyPush(push({ push_n: 5 }));
  const filas = db.getPushesByEventUuid(VIEJO);
  assert.deepEqual(
    filas.map((f) => f.push_n),
    [0, 3, 5]
  );
  assert.equal(db.getPushesByEventUuid('no-existe').length, 0);
});

test('supersedeRescheduledCalendly mata las scheduled y NO toca las ya enviadas', () => {
  // El Push 0 ya salió ("te reservaron un espacio"): ese mensaje está en el WhatsApp del
  // closer y reescribir su fila no lo desmanda, solo perdería el rastro de que se envió.
  db.markCalendlyPushSent(db.getPushesByEventUuid(VIEJO).find((f) => f.push_n === 0).id);

  const matados = db.supersedeRescheduledCalendly(VIEJO, NUEVO);
  assert.equal(matados, 2, 'mató el Push 3 y el Push 5, que seguían scheduled');

  const filas = db.getPushesByEventUuid(VIEJO);
  const porN = Object.fromEntries(filas.map((f) => [f.push_n, f]));
  assert.equal(porN[0].status, 'sent', 'la enviada queda como está');
  assert.equal(porN[3].status, 'skipped');
  assert.equal(porN[3].skip_reason, 'reagendada');
  assert.match(porN[3].message, new RegExp(NUEVO), 'el message deja el rastro de a dónde se movió');
  assert.equal(porN[5].status, 'skipped');
});

test('la call muerta desaparece de los digests, aunque le quede un push enviado', () => {
  // Este es el punto de Push 1 y Push 2: no se agendan, se CALCULAN con esta query en cada
  // cron. El fantasma del incidente vivía justo acá — el Push 0 enviado mantenía viva la fila
  // de una cita que ya no existía, y el closer la seguía viendo en su lista del día.
  const delJueves = db.getScheduledCallsInWindow(...JUE_4);
  assert.equal(
    delJueves.filter((c) => c.event_uuid === VIEJO).length,
    0,
    'la cita vieja ya no cuenta como viva, ni por su Push 0 enviado'
  );
});

test('y la call nueva aparece sola en el día NUEVO: los digests siguen a la call', () => {
  db.scheduleCalendlyPush(push({ event_uuid: NUEVO, push_n: 3, call_start: '2026-09-05 14:00:00' }));

  const jueves = db.getScheduledCallsInWindow(...JUE_4);
  assert.equal(jueves.length, 0, 'el jueves ya no tiene nada: la call se fue');

  const viernes = db.getScheduledCallsInWindow(...VIE_5);
  assert.equal(viernes.length, 1, 'el digest del viernes la toma sola, sin agendar nada nuevo');
  assert.equal(viernes[0].event_uuid, NUEVO);
  assert.equal(viernes[0].call_start, '2026-09-05 14:00:00');
});

test('una cita cancelada tampoco sobrevive por su Push 4 (el caso más común medido)', () => {
  const CANCELADA = 'cancelada-con-push4';
  db.scheduleCalendlyPush(push({ event_uuid: CANCELADA, push_n: 3, call_start: '2026-09-05 20:00:00' }));
  db.scheduleCalendlyPush(push({ event_uuid: CANCELADA, push_n: 4, call_start: '2026-09-05 20:00:00' }));

  assert.equal(
    db.getScheduledCallsInWindow(...VIE_5).filter((c) => c.event_uuid === CANCELADA).length,
    1,
    'mientras está viva, cuenta'
  );

  const p3 = db.getPushesByEventUuid(CANCELADA).find((f) => f.push_n === 3);
  db.markCalendlyPushSkipped(p3.id, 'cita canceled', 'cancelada');
  db.markCalendlyPushSent(db.getPushesByEventUuid(CANCELADA).find((f) => f.push_n === 4).id);

  assert.equal(
    db.getScheduledCallsInWindow(...VIE_5).filter((c) => c.event_uuid === CANCELADA).length,
    0,
    'con el Push 3 rendido, la call no va — aunque su Push 4 haya salido'
  );
});
