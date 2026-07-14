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

// ─── Reagendas (§18.AC) ───────────────────────────────────────────────────────

const REAG = (over = {}) => base({ event_uuid: 'evt-reag', closer_phone: '+573111111111', ...over });
const row = (uuid) => db.default.prepare(`SELECT * FROM call_outcomes WHERE event_uuid=?`).get(uuid);

test('"Reagendó" NO cierra el outcome: queda en awaiting_date esperando la fecha', () => {
  db.createPendingOutcome(REAG());
  db.setOutcomeAsistencia(row('evt-reag').id, 'reagendado', '3');
  const r = row('evt-reag');
  assert.equal(r.status, 'awaiting_date');
  assert.equal(r.asistencia, 'reagendado');
  assert.equal(r.answered_at, null, 'sigue abierto: falta la fecha');
  assert.ok(r.prompted_at, 'prompted_at se refresca — Juanito acaba de preguntar la fecha');
});

test('setOutcomeReschedule guarda la fecha + el uuid de la call nueva y cierra', () => {
  db.setOutcomeReschedule(row('evt-reag').id, {
    startUtc: '2026-07-14 20:00:00',
    uuid: 'manual:evt-reag:1',
    rawReply: 'hoy 3pm',
  });
  const r = row('evt-reag');
  assert.equal(r.status, 'answered');
  assert.equal(r.rescheduled_to, '2026-07-14 20:00:00');
  assert.equal(r.reschedule_uuid, 'manual:evt-reag:1');
  assert.ok(r.answered_at);
  assert.match(r.raw_reply, /hoy 3pm/);
});

// El bug que abre awaiting_date si no se acota: una fila a medio flujo ganaba SIEMPRE la
// prioridad, así que una reagenda sin fecha de ayer se llevaría la respuesta al Push 4 de hoy.
test('ventana de frescura: un mid-flow viejo NO secuestra el Push 4 de hoy', () => {
  const phone = '+573222222222';
  // Reagenda de ayer, aún sin fecha (mid-flow FRÍO).
  db.createPendingOutcome(base({ event_uuid: 'evt-fria', closer_phone: phone, lead_name: 'Vieja' }));
  db.setOutcomeAsistencia(row('evt-fria').id, 'reagendado', '3');
  db.default
    .prepare(`UPDATE call_outcomes SET prompted_at = datetime('now','-1 day'), asked_at = datetime('now','-1 day') WHERE event_uuid='evt-fria'`)
    .run();

  // Push 4 de hoy para el mismo closer (pending, sin asistencia).
  db.createPendingOutcome(base({ event_uuid: 'evt-hoy', closer_phone: phone, lead_name: 'De Hoy' }));

  const activo = db.getActiveOutcomeForCloser(phone);
  assert.equal(activo.event_uuid, 'evt-hoy', 'gana el Push 4 recién preguntado, no la reagenda fría');

  // Pero si NO hay nada más, la reagenda fría sigue capturando (no se pierde).
  db.setOutcomeAsistencia(db.getActiveOutcomeForCloser(phone).id, 'no_show', '2');
  assert.equal(db.getActiveOutcomeForCloser(phone).event_uuid, 'evt-fria');
});

test('mid-flow CALIENTE sí gana: el closer está contestando lo que le acaban de preguntar', () => {
  const phone = '+573333333333';
  db.createPendingOutcome(base({ event_uuid: 'evt-a', closer_phone: phone, lead_name: 'Primero' }));
  db.default.prepare(`UPDATE call_outcomes SET asked_at = datetime('now','-30 minutes') WHERE event_uuid='evt-a'`).run();
  db.createPendingOutcome(base({ event_uuid: 'evt-b', closer_phone: phone, lead_name: 'Segundo' }));
  // El closer contesta el de 'evt-b' → queda mid-flow esperando el resultado.
  db.setOutcomeAsistencia(row('evt-b').id, 'show', '1');
  assert.equal(db.getActiveOutcomeForCloser(phone).event_uuid, 'evt-b', 'el siguiente mensaje es su resultado');
});

test('insistencia por la fecha: se pide, se cuenta y al tope se cierra sin fecha', () => {
  const phone = '+573444444444';
  db.createPendingOutcome(base({ event_uuid: 'evt-sf', closer_phone: phone, lead_name: 'Sin Fecha' }));
  db.setOutcomeAsistencia(row('evt-sf').id, 'reagendado', '3');
  const id = row('evt-sf').id;

  // Recién preguntada → no se insiste el mismo rato.
  assert.equal(db.getAwaitingDateOutcomes().some((o) => o.id === id), false);

  // Al día siguiente sí.
  db.default.prepare(`UPDATE call_outcomes SET prompted_at = datetime('now','-1 day') WHERE id=?`).run(id);
  assert.ok(db.getAwaitingDateOutcomes().some((o) => o.id === id));

  // Tres insistencias y se cierra sola (deja de ocupar la ventana del closer).
  for (let i = 0; i < 3; i++) db.markReschedulePrompted(id);
  assert.equal(row('evt-sf').reschedule_asked, 3);
  assert.equal(db.getAwaitingDateOutcomes().some((o) => o.id === id), false, 'ya no se le pide más');
  db.expireAwaitingDateOutcomes({ maxAsked: 3 });
  const r = row('evt-sf');
  assert.equal(r.status, 'answered');
  assert.equal(r.rescheduled_to, null, 'reagendada sin fecha: cuenta como movida, no crea call');
});

test('supersede: si la reagenda entra por Calendly, se cancela el push sintético', () => {
  db.scheduleCalendlyPush({
    event_uuid: 'manual:evt-sup:1', push_n: 4, program: 'abogados',
    closer_email: 'x@30x.com', closer_phone: '573001112233',
    prospect_name: 'Ana Pérez', prospect_phone: '573109998877',
    call_start: '2026-07-20 20:00:00', due_at: '2026-07-20 20:35:00', message: 'push4',
  });
  db.createPendingOutcome(base({ event_uuid: 'evt-sup' }));
  db.setOutcomeReschedule(row('evt-sup').id, {
    startUtc: '2026-07-20 20:00:00',
    uuid: 'manual:evt-sup:1',
  });

  // El poll ve los sintéticos por entregar…
  const pend = db.getPendingManualPushes();
  assert.ok(pend.some((p) => p.event_uuid === 'manual:evt-sup:1'));

  // …y aparece el evento REAL de Calendly para ese lead → manda Calendly.
  const changes = db.supersedeManualPushes('manual:evt-sup:1', 'evt-real-999');
  assert.equal(changes, 1);
  const push = db.default.prepare(`SELECT * FROM calendly_pushes WHERE event_uuid='manual:evt-sup:1'`).get();
  assert.equal(push.status, 'skipped', 'no se pregunta dos veces');
  assert.match(push.message, /superseded por evento real evt-real-999/);
  assert.equal(row('evt-sup').reschedule_uuid, 'evt-real-999', 'el outcome apunta a la call real');
});
