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

test('boss: rotula con el label de PROGRAMS, no con la key cruda ni el mapa de enrutamiento', () => {
  // Regresión: PROGRAM_TO_COMPANY (mapa de enrutamiento a grupos) no lista instagram ni
  // tactical_investor, así que ambos salían con su key técnica en el DM del jefe, mientras la
  // agenda del mismo día ya decía "Instagram & TikTok". Ahora las dos superficies coinciden.
  const rows = [
    row({ program: 'instagram', closer: 'Marin', asistencia: 'show' }),
    row({ program: 'tactical_investor', closer: 'JP', asistencia: 'show' }),
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'show' }),
  ];
  const { programs } = buildBossScorecard(rows);
  const labelByKey = Object.fromEntries(programs.map((p) => [p.key, p.company]));
  assert.equal(labelByKey.instagram, 'Instagram & TikTok');
  assert.equal(labelByKey.tactical_investor, 'De Cero a Tactical Investor');
  assert.equal(labelByKey.second_brain, 'AI Second Brain');

  const msg = formatBossScorecard(rows, { dateLabel: 'hoy' });
  assert.match(msg, /\*Instagram & TikTok\*/);
  assert.match(msg, /\*De Cero a Tactical Investor\*/);
  assert.doesNotMatch(msg, /\*instagram\*/); // nunca la key cruda
  assert.doesNotMatch(msg, /\*tactical_investor\*/);
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

// ─── Denominador del día (`agendadas`) ────────────────────────────────────────
// Sin este dato el reporte de mediodía decía "19 calls · cobertura 100%" habiendo 46 calls
// agendadas: cierto sobre lo registrado, engañoso sobre el día. Pasando las agendadas, el
// encabezado dice "de cuántas" y descuenta las que todavía no ocurrieron.

test('boss: con `agendadas` la cobertura se mide contra el día completo', () => {
  const rows = [
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'show' }),
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'no_show' }),
  ];
  const msg = formatBossScorecard(rows, { dateLabel: '24-jul', agendadas: 8 });
  assert.match(msg, /2 de 8 calls/);
  assert.match(msg, /cobertura del dato: 25%/); // 2 registradas de 8 del día
  assert.match(msg, /6 calls sin ocurrir aún/);
  assert.match(msg, /Cobertura <100%/);
});

test('boss: sin `agendadas` el encabezado y la cobertura no cambian (compat /reportejefe)', () => {
  const rows = [
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'show' }),
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'no_show' }),
  ];
  const msg = formatBossScorecard(rows, { dateLabel: '24-jul' });
  assert.match(msg, /^📊 \*Reporte Juanito — 24-jul\*\n2 calls · /);
  assert.match(msg, /cobertura del dato: 100%/);
  assert.doesNotMatch(msg, /sin ocurrir aún/);
});

test('boss: `agendadas` incoherente (≤ registradas) se ignora — no inventa denominador', () => {
  // Al cierre del día una call cancelada sale de la agenda pero conserva su fila: las
  // agendadas pueden quedar por debajo del total registrado. Ahí manda el denominador viejo.
  const rows = [
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'show' }),
    row({ program: 'second_brain', closer: 'Sebas', asistencia: 'no_show' }),
  ];
  const msg = formatBossScorecard(rows, { agendadas: 1 });
  assert.match(msg, /\n2 calls · /);
  assert.match(msg, /cobertura del dato: 100%/);
});
