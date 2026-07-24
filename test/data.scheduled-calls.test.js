// test/data.scheduled-calls.test.js
// Tests del SQL real de getScheduledCallsInWindow: la fuente de la AGENDA de las 7am.
// REQUIERE better-sqlite3 nativo → corre en Docker/VPS (igual que data.outcomes.test.js).
//
// Por qué existe: la agenda leía `call_outcomes`, que a las 7am está vacía SIEMPRE (su fila
// nace al entregar el Push 4, ~45 min después de cada call) → el reporte nunca se envió y no
// dejaba error. Esta query lee `calendly_pushes`, que sí tiene las calls del día desde que el
// poll las reserva. Lo que se fija acá: una fila por CALL (no por push) y el descarte de las
// calls que ya no van.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cal-agenda-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  db = await import('../src/db/index.js');
});

after(() => rmSync(dir, { recursive: true, force: true }));

// Ventana del 24-jul en Bogotá (UTC-5), igual que la que arma dayRangeUtc.
const DIA = ['2026-07-24 05:00:00', '2026-07-25 05:00:00'];

const push = (over = {}) => ({
  event_uuid: 'evt-1',
  push_n: 3,
  program: 'second_brain',
  closer_email: 'sebastian@30x.com',
  closer_phone: '+573001112222',
  prospect_name: 'Ana Gómez',
  prospect_phone: '+573004445555',
  call_start: '2026-07-24 15:00:00',
  due_at: '2026-07-24 14:35:00',
  message: 'push',
  ...over,
});

test('una fila por CALL aunque tenga varios pushes (0/3/4)', () => {
  for (const n of [0, 3, 4]) db.scheduleCalendlyPush(push({ push_n: n }));
  const calls = db.getScheduledCallsInWindow(...DIA);
  assert.equal(calls.length, 1, 'los 3 pushes son la MISMA call');
  assert.equal(calls[0].event_uuid, 'evt-1');
  assert.equal(calls[0].program, 'second_brain');
  assert.equal(calls[0].closer_email, 'sebastian@30x.com');
  assert.equal(calls[0].call_start, '2026-07-24 15:00:00');
});

test('cuenta calls de distintos closers/programas y las ordena por hora', () => {
  db.scheduleCalendlyPush(
    push({ event_uuid: 'evt-2', program: 'instagram', closer_email: 'sebastian.marin@30x.com', call_start: '2026-07-24 13:00:00' })
  );
  db.scheduleCalendlyPush(push({ event_uuid: 'evt-3', closer_email: 'pablo.lozano@30x.com', call_start: '2026-07-24 22:00:00' }));
  const calls = db.getScheduledCallsInWindow(...DIA);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.event_uuid), ['evt-2', 'evt-1', 'evt-3']);
});

test('un push ya ENVIADO mantiene la call en la agenda', () => {
  // A media mañana el Push 3 ya salió; la call sigue siendo del día.
  const due = db.getDueCalendlyPushes().filter((p) => p.event_uuid === 'evt-2');
  assert.ok(due.length, 'hay pushes de evt-2 por entregar');
  db.markCalendlyPushSent(due[0].id);
  const uuids = db.getScheduledCallsInWindow(...DIA).map((c) => c.event_uuid);
  assert.ok(uuids.includes('evt-2'), 'sent NO saca la call de la agenda');
});

test('call con TODOS sus pushes skipped (cancelada/superseded) sale de la agenda', () => {
  db.scheduleCalendlyPush(push({ event_uuid: 'evt-cancel', push_n: 3 }));
  db.scheduleCalendlyPush(push({ event_uuid: 'evt-cancel', push_n: 4, due_at: '2026-07-24 15:45:00' }));
  assert.ok(
    db.getScheduledCallsInWindow(...DIA).some((c) => c.event_uuid === 'evt-cancel'),
    'antes de saltarlos, cuenta'
  );
  for (const p of db.getDueCalendlyPushes().filter((p) => p.event_uuid === 'evt-cancel')) {
    db.markCalendlyPushSkipped(p.id, 'cita canceled');
  }
  assert.ok(
    !db.getScheduledCallsInWindow(...DIA).some((c) => c.event_uuid === 'evt-cancel'),
    'sin un solo push vivo, la call ya no va'
  );
});

test('reagenda manual superseded no se cuenta dos veces', () => {
  // El closer dictó la reagenda (uuid sintético) y después entró el evento real de Calendly.
  db.scheduleCalendlyPush(push({ event_uuid: 'manual:abc:1', call_start: '2026-07-24 19:00:00' }));
  db.scheduleCalendlyPush(push({ event_uuid: 'evt-real', call_start: '2026-07-24 19:00:00' }));
  assert.equal(
    db.getScheduledCallsInWindow(...DIA).filter((c) => c.call_start === '2026-07-24 19:00:00').length,
    2,
    'antes del supersede están las dos'
  );
  db.supersedeManualPushes('manual:abc:1', 'evt-real');
  const a19 = db.getScheduledCallsInWindow(...DIA).filter((c) => c.call_start === '2026-07-24 19:00:00');
  assert.equal(a19.length, 1, 'queda solo el evento real');
  assert.equal(a19[0].event_uuid, 'evt-real');
});

test('la ventana filtra por call_start [from, to)', () => {
  db.scheduleCalendlyPush(push({ event_uuid: 'evt-ayer', call_start: '2026-07-23 20:00:00' }));
  db.scheduleCalendlyPush(push({ event_uuid: 'evt-manana', call_start: '2026-07-25 15:00:00' }));
  const uuids = db.getScheduledCallsInWindow(...DIA).map((c) => c.event_uuid);
  assert.ok(!uuids.includes('evt-ayer') && !uuids.includes('evt-manana'));
  assert.equal(db.getScheduledCallsInWindow('2020-01-01 00:00:00', '2020-01-02 00:00:00').length, 0);
});
