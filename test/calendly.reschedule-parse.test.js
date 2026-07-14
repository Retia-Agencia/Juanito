// test/calendly.reschedule-parse.test.js
// Tests PUROS del parser de fechas de reagenda (§18.AC). Sin DB, sin red → Windows.
//
// Reloj congelado: martes 14 de julio de 2026, 9:40am en Bogotá (UTC-5) = 14:40 UTC.
// Es el escenario real: la call de las 9am se reagendó y el closer está contestando.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseRescheduleReply } = await import('../src/calendly/reschedule-parse.js');

const TZ = 'America/Bogota';
const NOW = Date.parse('2026-07-14T14:40:00Z'); // mar 14 jul, 9:40am Bogotá
const parse = (t) => parseRescheduleReply(t, { nowMs: NOW, tz: TZ });

// Helper: la fecha resuelta, en hora de pared de Bogotá, para asertar sin hacer mates UTC.
// Explota si el parse NO devolvió fecha — si no, Intl formatearía la hora REAL de la
// máquina y el test fallaría con un valor engañoso en vez de decir "no parseó".
const local = (r) => {
  assert.equal(r.kind, 'datetime', `esperaba una fecha, salió ${r.kind}/${r.reason || ''}`);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  }).format(r.startUtc);
};

test('el caso del jefe: la call de las 9am se movió a las 3pm de HOY', () => {
  const r = parse('hoy 3pm');
  assert.equal(r.kind, 'datetime');
  assert.equal(local(r), '2026-07-14 15:00');
  // Y en UTC es lo que se guarda en call_outcomes.rescheduled_to.
  assert.equal(r.startUtc.toISOString(), '2026-07-14T20:00:00.000Z');
});

test('hora ambigua sin am/pm: horario laboral (1-6 → pm, 7-11 → am)', () => {
  assert.equal(local(parse('hoy a las 3')), '2026-07-14 15:00');
  assert.equal(local(parse('hoy a las 11')), '2026-07-14 11:00');
  assert.equal(local(parse('mañana a las 10')), '2026-07-15 10:00');
});

test('mañana, pasado mañana y minutos', () => {
  assert.equal(local(parse('mañana 10:30am')), '2026-07-15 10:30');
  assert.equal(local(parse('pasado mañana 4pm')), '2026-07-16 16:00');
  assert.equal(local(parse('mañana a las 3 y media')), '2026-07-15 15:30');
});

test('"de la mañana"/"de la tarde" son el meridiano, no el día', () => {
  // Trampa clásica: "9 de la mañana" NO significa el día de mañana.
  assert.equal(local(parse('mañana a las 9 de la mañana')), '2026-07-15 09:00');
  assert.equal(local(parse('a las 2 de la tarde')), '2026-07-14 14:00');
});

test('nombre de día → próxima ocurrencia', () => {
  assert.equal(local(parse('viernes 2pm')), '2026-07-17 14:00'); // hoy es martes
  assert.equal(local(parse('el lunes a las 9')), '2026-07-20 09:00');
  // Mismo día de la semana que hoy = el de la semana que viene (si fuera hoy dirían "hoy").
  assert.equal(local(parse('martes 4pm')), '2026-07-21 16:00');
});

test('fechas explícitas: 22/07, 22-07, "22 de julio", "el 22 a las 9"', () => {
  assert.equal(local(parse('22/07 9am')), '2026-07-22 09:00');
  assert.equal(local(parse('22-07 15:00')), '2026-07-22 15:00');
  assert.equal(local(parse('22 de julio a las 4pm')), '2026-07-22 16:00');
  assert.equal(local(parse('el 22 a las 9')), '2026-07-22 09:00');
});

test('formato 24h se respeta tal cual', () => {
  assert.equal(local(parse('mañana 15:30')), '2026-07-15 15:30');
});

test('"aún no sé" → unknown_date (se registra la reagenda, se pregunta mañana)', () => {
  for (const t of ['aún no sé', 'todavía no sabemos', 'no hay fecha aún', 'queda pendiente', 'sin fecha']) {
    assert.equal(parse(t).kind, 'unknown_date', t);
  }
});

test('fecha pasada → invalid/past (no se agenda una call que ya pasó)', () => {
  const r = parse('hoy 8am'); // ya son las 9:40
  assert.equal(r.kind, 'invalid');
  assert.equal(r.reason, 'past');
});

test('fecha delirante (>90 días) → invalid/far', () => {
  const r = parse('22/12 9am');
  assert.equal(r.kind, 'invalid');
  assert.equal(r.reason, 'far');
});

test('basura o sin hora → none (→ fallback IA → repregunta)', () => {
  assert.equal(parse('dale gracias').kind, 'none');
  assert.equal(parse('').kind, 'none');
  assert.equal(parse('mañana').kind, 'none'); // sin hora no se puede agendar
});
