// test/data.playbook-corte.test.js
// §18.CU — el SQL del corte de la víspera. REQUIERE better-sqlite3 nativo → corre en
// Docker/VPS, no en Windows. El resto del playbook está en calendly.playbook.test.js (harness).
//
// Lo que se fija:
//   1. el lote del corte guarda tipo y teléfono, y sigue abierto mientras le quede una llamada
//      por empezar aunque hayan pasado las horas de CALENDLY_CONFIRMACION_HORAS;
//   2. un lote del Push 2 se cierra a las horas de siempre;
//   3. "el 2 confirmó" reactiva el Push 3 y el 7 que el corte había frenado, sin el sufijo
//      " | skip: …" en el mensaje, y no toca los frenados por otra razón.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'playbook-corte-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;
let raw;

before(async () => {
  execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env, DB_PATH }, stdio: 'pipe' });
  db = await import('../src/db/index.js');
  raw = db.default;
});

after(() => rmSync(dir, { recursive: true, force: true }));

const PHONE = '+573014477044';
const enHoras = (h) => new Date(Date.now() + h * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const fila = (over) => ({
  lote: `${PHONE}:2026-06-15:corte`,
  program: 'second_brain',
  closer_email: 'lucas.mendoza@30x.com',
  closer_phone: PHONE,
  closer_name: 'Lucas Mendoza',
  ...over,
});

test('corte: guarda tipo y teléfono, y sigue abierto hasta la última llamada', () => {
  db.guardarLoteConfirmacion([
    fila({ event_uuid: 'c-1', posicion: 1, lead_name: 'Ana', call_start: enHoras(20), tipo: 'corte', lead_phone: '+573001112222' }),
    fila({ event_uuid: 'c-2', posicion: 2, lead_name: 'Beto', call_start: enHoras(30), tipo: 'corte', lead_phone: '+573003334444' }),
  ]);
  // Preguntado hace 20 h: fuera de las 16 h de siempre, pero con llamadas por delante.
  raw.prepare(`UPDATE call_confirmaciones SET preguntada_at = datetime('now', '-20 hours') WHERE lote = ?`).run(fila({}).lote);
  const abiertas = db.getLoteConfirmacionAbierto(PHONE);
  assert.deepEqual(abiertas.map((f) => [f.event_uuid, f.tipo, f.lead_phone]), [
    ['c-1', 'corte', '+573001112222'],
    ['c-2', 'corte', '+573003334444'],
  ]);
  assert.deepEqual(db.getConfirmacionDeCita('c-2'), { estado: 'pendiente', tipo: 'corte' });
  assert.equal(db.getConfirmacionDeCita('no-existe'), null);
});

test('Push 2: el lote se cierra a las horas de siempre', () => {
  const p = '+573009998888';
  db.guardarLoteConfirmacion([
    { ...fila({ event_uuid: 'p2-1', posicion: 1, lead_name: 'Caro', call_start: enHoras(5) }), lote: `${p}:x`, closer_phone: p },
  ]);
  raw.prepare(`UPDATE call_confirmaciones SET preguntada_at = datetime('now', '-20 hours') WHERE lote = ?`).run(`${p}:x`);
  assert.equal(db.getLoteConfirmacionAbierto(p).length, 0);
  assert.equal(db.getConfirmacionDeCita('p2-1').tipo, 'push2');
});

test('una corrección reactiva el Push 3 y el 7 frenados por el corte, y nada más', () => {
  const push = (push_n, event_uuid = 'c-2') => ({
    event_uuid,
    push_n,
    closer_email: 'lucas.mendoza@30x.com',
    closer_phone: PHONE,
    prospect_name: 'Beto',
    prospect_phone: '+573003334444',
    call_start: enHoras(30),
    due_at: enHoras(29),
    message: `Push ${push_n} de Beto`,
  });
  for (const n of [3, 7, 4]) db.scheduleCalendlyPush(push(n));
  db.scheduleCalendlyPush(push(3, 'otra'));
  const id = (uuid, n) => raw.prepare(`SELECT id FROM calendly_pushes WHERE event_uuid = ? AND push_n = ?`).get(uuid, n).id;
  db.markCalendlyPushSkipped(id('c-2', 3), 'sin confirmar en el corte de la víspera', 'sin-confirmar');
  db.markCalendlyPushSkipped(id('c-2', 7), 'sin confirmar en el corte de la víspera', 'sin-confirmar');
  db.markCalendlyPushSkipped(id('c-2', 4), 'cita canceled', 'cancelada');
  db.markCalendlyPushSkipped(id('otra', 3), 'sin confirmar', 'sin-confirmar');

  assert.equal(db.reactivarPushesDelCorte('c-2'), 2);
  const fila3 = raw.prepare(`SELECT * FROM calendly_pushes WHERE id = ?`).get(id('c-2', 3));
  assert.equal(fila3.status, 'scheduled');
  assert.equal(fila3.skip_reason, null);
  assert.equal(fila3.message, 'Push 3 de Beto');
  assert.equal(raw.prepare(`SELECT status FROM calendly_pushes WHERE id = ?`).get(id('c-2', 4)).status, 'skipped');
  assert.equal(raw.prepare(`SELECT status FROM calendly_pushes WHERE id = ?`).get(id('otra', 3)).status, 'skipped');
});

test('recordatorio (§18.CW): solo el corte de hoy, sin respuesta, sin recordar y con llamadas por delante', () => {
  const lote = (p, fecha = '2026-07-01') => `${p}:${fecha}:corte`;
  const corte = (p, uuid, over = {}) => ({
    ...fila({ event_uuid: uuid, posicion: 1, lead_name: 'X', call_start: enHoras(20), tipo: 'corte', lead_phone: '+573000000000' }),
    lote: lote(p),
    closer_phone: p,
    ...over,
  });
  const A = '+573001000001'; // sin respuesta → entra
  const B = '+573001000002'; // contestó una → no
  const C = '+573001000003'; // llamadas ya pasadas → no
  const D = '+573001000004'; // corte de otro día → no
  db.guardarLoteConfirmacion([corte(A, 'r-a1'), corte(A, 'r-a2', { posicion: 2 })]);
  db.guardarLoteConfirmacion([corte(B, 'r-b1'), corte(B, 'r-b2', { posicion: 2 })]);
  db.setConfirmacionEstados(lote(B), { 2: 'confirmada' }, '2');
  db.guardarLoteConfirmacion([corte(C, 'r-c1', { call_start: enHoras(-2) })]);
  db.guardarLoteConfirmacion([corte(D, 'r-d1', { lote: lote(D, '2026-06-30') })]);

  const filas = db.getCortesSinRespuesta('2026-07-01');
  assert.deepEqual(filas.map((f) => [f.event_uuid, f.posicion]), [['r-a1', 1], ['r-a2', 2]]);

  db.markCorteRecordado(lote(A));
  assert.equal(db.getCortesSinRespuesta('2026-07-01').length, 0, 'una sola vez por lote');
  // El lote recordado sigue abierto y trae recordada_at: la captura lo usa como hora de la pregunta.
  assert.ok(db.getLoteConfirmacionAbierto(A)[0].recordada_at);

  // Re-preguntar el MISMO lote conserva la marca; mudar la cita a otro lote la limpia.
  db.guardarLoteConfirmacion([corte(A, 'r-a1')]);
  assert.ok(raw.prepare(`SELECT recordada_at FROM call_confirmaciones WHERE event_uuid = 'r-a1'`).get().recordada_at);
  db.guardarLoteConfirmacion([corte(A, 'r-a1', { lote: lote(A, '2026-07-02') })]);
  assert.equal(raw.prepare(`SELECT recordada_at FROM call_confirmaciones WHERE event_uuid = 'r-a1'`).get().recordada_at, null);
});
