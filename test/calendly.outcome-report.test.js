// test/calendly.outcome-report.test.js
// Tests PUROS de la agregación + formato del reporte de outcomes (§18.AB). Sin DB → Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { aggregateOutcomes, formatOutcomeSection, PROGRAM_TO_COMPANY } = await import(
  '../src/calendly/outcome-report.js'
);

const rows = [
  // second_brain — Maca: 3 calls, 2 registradas (1 show+venta, 1 no_show), 1 sin registrar
  { program: 'second_brain', closer_name: 'Maca Celis', asistencia: 'show', resultado: 'venta_cerrada', status: 'answered', call_start: '2026-06-30 15:00:00' },
  { program: 'second_brain', closer_name: 'Maca Celis', asistencia: 'no_show', resultado: null, status: 'answered', call_start: '2026-06-30 16:00:00' },
  { program: 'second_brain', closer_name: 'Maca Celis', asistencia: null, resultado: null, status: 'no_answer', call_start: '2026-06-30 17:00:00' },
  // second_brain — Pablo: 1 call, show sin venta
  { program: 'second_brain', closer_name: 'Pablo Lozano', asistencia: 'show', resultado: 'seguimiento', status: 'answered', call_start: '2026-06-30 18:00:00' },
  // abogados — Sebas: 1 call, cancelada (auto)
  { program: 'abogados', closer_name: 'Sebas Rodriguez', asistencia: 'cancelado', resultado: null, status: 'auto', call_start: '2026-06-30 19:00:00' },
];

test('aggregateOutcomes separa por programa y por closer', () => {
  const agg = aggregateOutcomes(rows);
  assert.deepEqual(Object.keys(agg).sort(), ['abogados', 'second_brain']);
  assert.deepEqual(Object.keys(agg.second_brain).sort(), ['Maca Celis', 'Pablo Lozano']);
});

test('aggregateOutcomes cuenta estados, cumplimiento, show rate y close rate', () => {
  const maca = aggregateOutcomes(rows).second_brain['Maca Celis'];
  assert.equal(maca.total, 3);
  assert.equal(maca.registrados, 2);
  assert.equal(maca.sin_registrar, 1);
  assert.equal(maca.show, 1);
  assert.equal(maca.no_show, 1);
  assert.equal(maca.venta_cerrada, 1);
  assert.equal(maca.cumplimiento, 67); // 2/3
  assert.equal(maca.show_rate, 50); // show / (show+no_show) = 1/2
  assert.equal(maca.close_rate, 100); // venta / show = 1/1
});

test('formatOutcomeSection rankea por cumplimiento y nombra el programa', () => {
  const agg = aggregateOutcomes(rows);
  const msg = formatOutcomeSection('second_brain', agg.second_brain, { dateLabel: 'lun 30 jun' });
  assert.match(msg, /AI SECOND BRAIN/);
  assert.match(msg, /lun 30 jun/);
  assert.match(msg, /Maca Celis/);
  assert.match(msg, /Pablo Lozano/);
  // Pablo (100% registrado) va antes que Maca (67%).
  assert.ok(msg.indexOf('Pablo Lozano') < msg.indexOf('Maca Celis'));
  // Avisa de las sin registrar.
  assert.match(msg, /sin registrar/);
});

test('formatOutcomeSection devuelve null si no hay closers', () => {
  assert.equal(formatOutcomeSection('linkedin', {}, {}), null);
});

test('cancelada cuenta como registrada (auto), no como sin registrar', () => {
  const sebas = aggregateOutcomes(rows).abogados['Sebas Rodriguez'];
  assert.equal(sebas.registrados, 1);
  assert.equal(sebas.sin_registrar, 0);
  assert.equal(sebas.cancelado, 1);
  assert.equal(PROGRAM_TO_COMPANY.abogados, 'ESTADOX');
});
