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

// §18.AC: una cancelada NO ocurrió → sale del volumen (ni total, ni registrados, ni sin
// registrar) y se reporta como "movida". Antes contaba en el total, y como Calendly cancela
// el evento viejo al reagendar, el mismo lead se contaba dos veces.
test('cancelada sale del volumen y cuenta como movida', () => {
  const sebas = aggregateOutcomes(rows).abogados['Sebas Rodriguez'];
  assert.equal(sebas.total, 0);
  assert.equal(sebas.registrados, 0);
  assert.equal(sebas.sin_registrar, 0);
  assert.equal(sebas.cancelado, 1);
  assert.equal(sebas.movidas, 1);
  assert.equal(PROGRAM_TO_COMPANY.abogados, 'ESTADOX');
});

// EL test del bug: el mismo lead reagendado y luego atendido cuenta UNA vez.
test('reagendada + su call nueva = 1 sola call en el volumen (sin doble conteo)', () => {
  const mismoLead = [
    // La call original de las 9am: el closer dijo "reagendó" y dio la fecha.
    {
      program: 'abogados', closer_name: 'Pablo Lozano', lead_name: 'Ana Pérez',
      asistencia: 'reagendado', resultado: null, status: 'answered',
      call_start: '2026-07-14 14:00:00', rescheduled_to: '2026-07-14 20:00:00',
    },
    // La call reagendada de las 3pm (fila propia, uuid sintético): esta SÍ ocurrió.
    {
      program: 'abogados', closer_name: 'Pablo Lozano', lead_name: 'Ana Pérez',
      asistencia: 'show', resultado: 'venta_cerrada', status: 'answered',
      call_start: '2026-07-14 20:00:00', rescheduled_to: null,
    },
  ];
  const pablo = aggregateOutcomes(mismoLead).abogados['Pablo Lozano'];
  assert.equal(pablo.total, 1); // ← el lead cuenta UNA vez, no dos
  assert.equal(pablo.movidas, 1);
  assert.equal(pablo.reagendado, 1);
  assert.equal(pablo.show, 1);
  assert.equal(pablo.venta_cerrada, 1);
  assert.equal(pablo.cumplimiento, 100); // 1/1, la reagendada no diluye
  assert.equal(pablo.show_rate, 100);
});

test('formatOutcomeSection muestra las movidas aparte y a dónde se movieron', () => {
  const agg = aggregateOutcomes([
    {
      program: 'abogados', closer_name: 'Pablo Lozano', lead_name: 'Ana Pérez',
      asistencia: 'reagendado', status: 'answered',
      call_start: '2026-07-14 14:00:00', rescheduled_to: '2026-07-14 20:00:00',
    },
    {
      program: 'abogados', closer_name: 'Pablo Lozano', lead_name: 'Luis Gómez',
      asistencia: 'show', resultado: 'no_cerro', status: 'answered',
      call_start: '2026-07-14 16:00:00',
    },
  ]);
  const msg = formatOutcomeSection('abogados', agg.abogados, {
    dateLabel: 'mar 14 jul',
    tz: 'America/Bogota',
  });
  assert.match(msg, /^📋 \*Registro de calls — ESTADOX\* \(mar 14 jul\)\n1 call /);
  assert.match(msg, /🔁 movidas: 1 reagendada/);
  assert.match(msg, /Ana P\. → /); // el destino de la reagenda, con su fecha
  assert.match(msg, /3:00 pm/); // 20:00 UTC = 3pm Bogotá
});
