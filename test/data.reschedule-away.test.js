// test/data.reschedule-away.test.js
// SQL real de la reagenda hecha DENTRO del CRM (§18.AO): supersedeRescheduledPushes,
// getRescheduledAwayCalls y getCallsWithAnyPushInWindow.
// REQUIERE better-sqlite3 nativo → corre en Docker/VPS, igual que data.scheduled-calls.test.js.
//
// Lo que se fija acá es la coherencia entre las TRES consultas, que es donde estaba el hueco:
// al cancelar el push de una call, esa call desaparece de la agenda del jefe
// (getScheduledCallsInWindow) pero tiene que SEGUIR contando como "ya decidida" para el poll de
// HubSpot (getCallsWithAnyPushInWindow). Si no, el poll se la crea de nuevo bajo otro
// event_uuid en el ciclo siguiente y resucita el push que se acababa de matar.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cal-resched-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  db = await import('../src/db/index.js');
});

after(() => rmSync(dir, { recursive: true, force: true }));

const DIA = ['2026-07-24 05:00:00', '2026-07-25 05:00:00'];
const VENCIDO = '2020-01-01 00:00:00';

const push = (over = {}) => ({
  event_uuid: 'cal-vieja',
  push_n: 3,
  program: 'second_brain',
  closer_email: 'sebastian@30x.com',
  closer_phone: '+573001112222',
  prospect_name: 'Ana Gómez',
  prospect_phone: '+573004445555',
  call_start: '2026-07-24 15:00:00',
  due_at: VENCIDO,
  message: 'push',
  ...over,
});

test('la call reagendada pierde TODOS sus pushes pendientes de una sola pasada', () => {
  for (const n of [0, 3, 4]) db.scheduleCalendlyPush(push({ push_n: n }));
  const n = db.supersedeRescheduledPushes('sebastian@30x.com', '2026-07-24 15:00:00', '2026-07-25 17:00:00');
  assert.equal(n, 3, 'push 0, 3 y 4 de esa call');
  assert.equal(db.getDueCalendlyPushes().filter((p) => p.event_uuid === 'cal-vieja').length, 0);
});

test('sale de la agenda del jefe pero SIGUE contando como decidida para el poll', () => {
  // El caso exacto que motivó getCallsWithAnyPushInWindow.
  assert.ok(
    !db.getScheduledCallsInWindow(...DIA).some((c) => c.event_uuid === 'cal-vieja'),
    'la agenda de las 7am no puede listar una call que ya no va'
  );
  assert.ok(
    db.getCallsWithAnyPushInWindow(...DIA).some((c) => c.event_uuid === 'cal-vieja'),
    'el poll tiene que verla, o le crea un push nuevo bajo otro uuid'
  );
});

test('getRescheduledAwayCalls devuelve closer + hora, en minúsculas, sin duplicar', () => {
  const movidas = db.getRescheduledAwayCalls(...DIA);
  assert.equal(movidas.length, 1, 'los 3 pushes son UNA call movida');
  assert.equal(movidas[0].closer_email, 'sebastian@30x.com');
  assert.equal(movidas[0].call_start, '2026-07-24 15:00:00');
});

test('el match es por closer + MINUTO, no por segundo exacto', () => {
  db.scheduleCalendlyPush(push({ event_uuid: 'hs-seg', call_start: '2026-07-24 18:00:45' }));
  const n = db.supersedeRescheduledPushes('  SEBASTIAN@30X.com ', '2026-07-24 18:00:00', '2026-07-26 12:00:00');
  assert.equal(n, 1, 'segundos distintos y mayúsculas no deben impedir el match');
});

test('no toca la call de OTRO closer a la misma hora', () => {
  db.scheduleCalendlyPush(push({ event_uuid: 'otro-closer', closer_email: 'pablo.lozano@30x.com', call_start: '2026-07-24 19:00:00' }));
  const n = db.supersedeRescheduledPushes('sebastian@30x.com', '2026-07-24 19:00:00', '2026-07-26 12:00:00');
  assert.equal(n, 0);
  assert.ok(db.getScheduledCallsInWindow(...DIA).some((c) => c.event_uuid === 'otro-closer'));
});

test('un push YA ENVIADO no se reescribe: el mensaje salió y cancelarlo no lo desmanda', () => {
  db.scheduleCalendlyPush(push({ event_uuid: 'ya-enviada', call_start: '2026-07-24 20:00:00' }));
  const fila = db.getDueCalendlyPushes().find((p) => p.event_uuid === 'ya-enviada');
  db.claimCalendlyPush(fila.id);
  db.markCalendlyPushSent(fila.id);
  const n = db.supersedeRescheduledPushes('sebastian@30x.com', '2026-07-24 20:00:00', '2026-07-26 12:00:00');
  assert.equal(n, 0);
  assert.ok(db.getScheduledCallsInWindow(...DIA).some((c) => c.event_uuid === 'ya-enviada'));
});

test('una call sin reagendar no aparece como movida', () => {
  const movidas = db.getRescheduledAwayCalls(...DIA).map((c) => c.call_start);
  assert.ok(!movidas.includes('2026-07-24 19:00:00'), 'la de otro closer sigue viva');
  assert.ok(!movidas.includes('2026-07-24 20:00:00'), 'la ya enviada sigue viva');
});

test('la ventana filtra por call_start [from, to)', () => {
  assert.equal(db.getRescheduledAwayCalls('2020-01-01 00:00:00', '2020-01-02 00:00:00').length, 0);
  assert.equal(db.getCallsWithAnyPushInWindow('2020-01-01 00:00:00', '2020-01-02 00:00:00').length, 0);
});
