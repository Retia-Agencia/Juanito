// Tests PUROS del reporte del jefe (src/calendly/boss-report.js): consolida call_outcomes
// de TODOS los programas en un solo scorecard, con número de ventas (no plata) y cobertura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBossScorecard, formatBossScorecard } from '../src/calendly/boss-report.js';

// Fila de call_outcomes mínima para el agregador.
function row({ program, closer, asistencia, resultado = null, status = 'answered', rescheduled_to = null }) {
  return {
    program,
    closer_name: closer,
    closer_email: `${closer}@30x.com`,
    asistencia,
    resultado,
    status,
    lead_name: 'Lead X',
    rescheduled_to,
  };
}

test('boss: consolida varios programas con totales de empresa', () => {
  const rows = [
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'show', resultado: 'venta_cerrada' }),
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'no_show' }),
    row({ program: 'linkedin', closer: 'Marin', asistencia: 'show' }),
  ];
  const { company, programs } = buildBossScorecard(rows);
  assert.equal(company.total, 3);
  assert.equal(company.show, 2);
  assert.equal(company.no_show, 1);
  assert.equal(company.venta_cerrada, 1);
  assert.equal(company.show_rate, 67); // 2/(2+1)
  assert.equal(programs.length, 2);
  assert.equal(programs[0].key, 'second_brain'); // orden fijo: second_brain primero
});

test('boss: reagendada/cancelada NO cuentan en volumen (anti-doble-conteo)', () => {
  const rows = [
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'show' }),
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'reagendado', status: 'auto', rescheduled_to: '2026-07-21 15:30:00' }),
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'cancelado', status: 'auto' }),
  ];
  const { company } = buildBossScorecard(rows);
  assert.equal(company.total, 1, 'solo el show cuenta como call ocurrida');
  assert.equal(company.reagendado, 1);
  assert.equal(company.cancelado, 1);
});

test('boss: cobertura = registrados/total; una call sin registrar la baja', () => {
  const rows = [
    row({ program: 'linkedin', closer: 'Lucas', asistencia: 'show', status: 'auto' }),
    row({ program: 'linkedin', closer: 'Lucas', asistencia: null, status: 'pending' }), // sin registrar
  ];
  const { company } = buildBossScorecard(rows);
  assert.equal(company.total, 2);
  assert.equal(company.registrados, 1);
  assert.equal(company.sin_registrar, 1);
  assert.equal(company.cobertura, 50);
});

test('boss: ventas es CONTEO (venta_cerrada), sin plata', () => {
  const rows = [
    row({ program: 'operaciones', closer: 'Lucas', asistencia: 'show', resultado: 'venta_cerrada' }),
    row({ program: 'operaciones', closer: 'Lucas', asistencia: 'show', resultado: 'venta_cerrada' }),
    row({ program: 'operaciones', closer: 'Lucas', asistencia: 'show', resultado: 'seguimiento' }),
  ];
  const { company } = buildBossScorecard(rows);
  assert.equal(company.venta_cerrada, 2);
  const msg = formatBossScorecard(rows, { dateLabel: 'hoy' });
  assert.match(msg, /🎯 2 ventas/);
  assert.doesNotMatch(msg, /\$|USD|COP/, 'no muestra plata');
});

test('boss: format incluye cobertura y advierte si <100%', () => {
  const rows = [
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'show', status: 'auto' }),
    row({ program: 'second_brain', closer: 'Sebas', asistencia: null, status: 'pending' }),
  ];
  const msg = formatBossScorecard(rows, { dateLabel: '16-jul' });
  assert.match(msg, /cobertura del dato: 50%/);
  assert.match(msg, /1 sin registrar/);
  assert.match(msg, /Cobertura <100%/);
});

test('boss: por closer, ordenado por ventas', () => {
  const rows = [
    row({ program: 'second_brain', closer: 'Ana', asistencia: 'show' }),
    row({ program: 'second_brain', closer: 'Beto', asistencia: 'show', resultado: 'venta_cerrada' }),
  ];
  const { programs } = buildBossScorecard(rows);
  assert.equal(programs[0].closers[0].name, 'Beto', 'el que vendió va primero');
});

test('boss: sin filas → null (no manda reporte vacío)', () => {
  assert.equal(formatBossScorecard([], {}), null);
});
