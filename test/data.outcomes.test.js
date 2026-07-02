// test/data.outcomes.test.js
// Tests del SQL real de call_outcomes (§18.AB): creación/dedup, captura en 2 pasos,
// match por teléfono normalizado, insistencia/expiración y ventana del reporte.
// REQUIERE better-sqlite3 nativo → corre en Docker/VPS. La decisión pura está en
// test/calendly.outcome-logic.test.js; la agregación en calendly.outcome-report.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cal-outcome-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  db = await import('../src/db/index.js');
});

after(() => rmSync(dir, { recursive: true, force: true }));

const base = (over = {}) => ({
  event_uuid: 'evt-1',
  program: 'second_brain',
  closer_email: 'maca.celis@30x.com',
  closer_phone: '+573246345899', // se guarda NORMALIZADO
  closer_name: 'Maca Celis',
  lead_name: 'Ana Gómez',
  lead_phone: '+57 300 111 2222',
  call_start: '2026-06-30 20:00:00',
  ...over,
});

test('createPendingOutcome: new la 1ª vez, exists en repetido (dedup por event_uuid)', () => {
  assert.equal(db.createPendingOutcome(base()), 'new');
  assert.equal(db.createPendingOutcome(base()), 'exists');
});

test('match por teléfono: getActiveOutcomeForCloser normaliza el número entrante', () => {
  // Guardado con '+' y espacios → la búsqueda con formato distinto igual matchea.
  const o = db.getActiveOutcomeForCloser('57 324 6345899');
  assert.ok(o, 'encontró el pendiente pese al formato distinto');
  assert.equal(o.lead_name, 'Ana Gómez');
  assert.equal(o.program, 'second_brain');
});

test('captura 2 pasos: Show queda pending (espera resultado) y luego answered', () => {
  db.createPendingOutcome(base({ event_uuid: 'evt-show', lead_name: 'Beto' }));
  const o = db.getActiveOutcomeForCloser('+573246345899'); // mid-flow primero, si no el más viejo
  // Tomamos explícitamente el de Beto para el test.
  const beto = db.default.prepare(`SELECT * FROM call_outcomes WHERE event_uuid='evt-show'`).get();
  db.setOutcomeAsistencia(beto.id, 'show', '1');
  const afterShow = db.default.prepare(`SELECT * FROM call_outcomes WHERE id=?`).get(beto.id);
  assert.equal(afterShow.status, 'pending', 'show no cierra: falta el resultado');
  assert.equal(afterShow.asistencia, 'show');
  db.setOutcomeResultado(beto.id, 'venta_cerrada', 'cerró');
  const done = db.default.prepare(`SELECT * FROM call_outcomes WHERE id=?`).get(beto.id);
  assert.equal(done.status, 'answered');
  assert.equal(done.resultado, 'venta_cerrada');
  assert.ok(done.answered_at);
  void o;
});

test('No show cierra de una (answered, sin resultado)', () => {
  db.createPendingOutcome(base({ event_uuid: 'evt-noshow' }));
  const id = db.default.prepare(`SELECT id FROM call_outcomes WHERE event_uuid='evt-noshow'`).get().id;
  db.setOutcomeAsistencia(id, 'no_show', '2');
  const row = db.default.prepare(`SELECT * FROM call_outcomes WHERE id=?`).get(id);
  assert.equal(row.status, 'answered');
  assert.equal(row.resultado, null);
});

test('recordAutoOutcome: cancelada cierra como auto (o crea nueva si no existía)', () => {
  // Sobre una pendiente existente.
  db.createPendingOutcome(base({ event_uuid: 'evt-cancel' }));
  db.recordAutoOutcome(base({ event_uuid: 'evt-cancel', asistencia: 'cancelado' }));
  const row = db.default.prepare(`SELECT * FROM call_outcomes WHERE event_uuid='evt-cancel'`).get();
  assert.equal(row.status, 'auto');
  assert.equal(row.asistencia, 'cancelado');
  // Sin pendiente previa.
  db.recordAutoOutcome(base({ event_uuid: 'evt-cancel2', asistencia: 'cancelado' }));
  const row2 = db.default.prepare(`SELECT * FROM call_outcomes WHERE event_uuid='evt-cancel2'`).get();
  assert.equal(row2.status, 'auto');
});

test('insistencia: due tras N min, se marca reminded y luego expira a no_answer', () => {
  // Pendiente "vieja": asked_at hace 40 min.
  db.createPendingOutcome(base({ event_uuid: 'evt-old', closer_phone: '+573999999999' }));
  db.default
    .prepare(`UPDATE call_outcomes SET asked_at = datetime('now','-40 minutes') WHERE event_uuid='evt-old'`)
    .run();
  const due = db.getDueOutcomeReminders(30);
  assert.ok(due.some((o) => o.event_uuid === 'evt-old'), 'aparece para recordar (>30 min)');
  const id = due.find((o) => o.event_uuid === 'evt-old').id;
  db.markOutcomeReminded(id);
  assert.equal(db.getDueOutcomeReminders(30).some((o) => o.id === id), false, 'ya no reaparece tras reminded');
  // Expira contra asked_at + 60: la fila tiene 40 min → NO expira aún.
  db.expireUnansweredOutcomes(60);
  assert.equal(db.default.prepare(`SELECT status FROM call_outcomes WHERE id=?`).get(id).status, 'pending');
  // La envejecemos a 70 min → ahora sí expira.
  db.default.prepare(`UPDATE call_outcomes SET asked_at = datetime('now','-70 minutes') WHERE id=?`).run(id);
  const res = db.expireUnansweredOutcomes(60);
  assert.ok(res.changes >= 1);
  assert.equal(db.default.prepare(`SELECT status FROM call_outcomes WHERE id=?`).get(id).status, 'no_answer');
});

test('getOutcomesInWindow filtra por call_start [from,to)', () => {
  const rows = db.getOutcomesInWindow('2026-06-30 00:00:00', '2026-07-01 00:00:00');
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.call_start >= '2026-06-30 00:00:00' && r.call_start < '2026-07-01 00:00:00'));
  // Fuera de ventana: vacío.
  assert.equal(db.getOutcomesInWindow('2020-01-01 00:00:00', '2020-01-02 00:00:00').length, 0);
});
