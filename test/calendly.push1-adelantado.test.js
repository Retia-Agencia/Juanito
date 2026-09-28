// Push 1 adelantado (2026-09-21): el Push 1 de varios días se manda de una vez, en tandas, y el
// digest de cada noche se salta esas citas. Lo que estos tests fijan:
//   1. el lead lee el DÍA de su llamada ("del miércoles 23"), no un "mañana" falso;
//   2. la tanda marca solo lo que de verdad salió ('sent'), y solo si se lo piden (--send);
//   3. el Push 1 de la noche se salta lo marcado y sigue listando lo nuevo;
//   4. `conexion` deja fuera a los closers de otras conexiones.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { formatLeadDay, buildPrecallText } from '../src/calendly/index.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const LUCAS = 'lucas.mendoza@30x.com';
const LUCAS_PHONE = '+573014477044';
const SALAZAR = 'sebastian.salazar@30x.com'; // conexión estadox
const SALAZAR_PHONE = '+573054312905';

// Lunes 21-sep-2026, 12:00 Bogotá.
const LUNES = Date.parse('2026-09-21T17:00:00Z');
const MIERCOLES_10AM = '2026-09-23T15:00:00.000Z';
const MIERCOLES_3PM = '2026-09-23T20:00:00.000Z';

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH4_ENABLED = 'false';
  __resetHealth();
  scheduler.__resetDeps();
});

function withPrefired(h, inicial = []) {
  const marcadas = new Set(inicial);
  scheduler.__setDeps({
    ...h.deps,
    getPush1PrefiredKeys: () => new Set(marcadas),
    markPush1Prefired: (keys) => keys.forEach((k) => marcadas.add(k)),
  });
  return marcadas;
}

const leadTexts = (text) =>
  (text.match(/https:\/\/wa\.me\/\S+/g) || []).map((l) => decodeURIComponent(l.split('?text=')[1]));

test('formatLeadDay dice el día de la semana en los tres casos', () => {
  assert.equal(formatLeadDay('2026-09-21T20:00:00Z', 'America/Bogota', new Date(LUNES)), 'de hoy lunes');
  assert.equal(formatLeadDay('2026-09-22T15:00:00Z', 'America/Bogota', new Date(LUNES)), 'de mañana martes');
  assert.equal(formatLeadDay(MIERCOLES_10AM, 'America/Bogota', new Date(LUNES)), 'del miércoles 23');
});

test('buildPrecallText Push 1 sin `dia` conserva el "de mañana" de siempre', () => {
  const t = buildPrecallText({ programKey: 'second_brain', pushN: 1, primerNombre: 'Ana', closer: 'Lucas', hora: '10:00 am' });
  assert.match(t, /tu llamada de mañana a las 10:00 am/);
});

test('tanda adelantada: el lead lee "del miércoles 23" y se marcan las citas enviadas', async () => {
  const events = [
    makeEvent({ uuid: 'w1', startIso: MIERCOLES_10AM, closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs: LUNES }),
    makeEvent({ uuid: 'w2', startIso: MIERCOLES_3PM, closerEmail: LUCAS, prospectName: 'Beto Ruiz', nowMs: LUNES }),
  ];
  const h = installHarness(scheduler, { events, optins: [LUCAS_PHONE], nowMs: LUNES });
  const marcadas = withPrefired(h);

  await scheduler.runPush1Adelantado({ offsetDays: 2, conexion: '30x', marcar: true });

  assert.equal(h.wa.sent.length, 1, 'un digest por closer');
  const texto = h.wa.sent[0].text;
  assert.match(texto, /Push 1 \(adelantado\)/);
  assert.match(texto, /tienes 2 llamadas el mié/);
  assert.match(texto, /con calma/);
  const leads = leadTexts(texto);
  assert.equal(leads.length, 2);
  for (const l of leads) {
    assert.match(l, /tu llamada del miércoles 23 a las/);
    assert.doesNotMatch(l, /de mañana/);
  }
  assert.equal(marcadas.size, 2, 'las dos citas quedan marcadas');
});

test('tanda adelantada en dry-run (marcar:false) no marca nada', async () => {
  const events = [makeEvent({ uuid: 'w1', startIso: MIERCOLES_10AM, closerEmail: LUCAS, nowMs: LUNES })];
  const h = installHarness(scheduler, { events, optins: [LUCAS_PHONE], nowMs: LUNES });
  const marcadas = withPrefired(h);
  await scheduler.runPush1Adelantado({ offsetDays: 2, conexion: '30x', marcar: false });
  assert.equal(h.wa.sent.length, 1);
  assert.equal(marcadas.size, 0);
});

test('closer sin opt-in: no se marca, así su noche normal lo sigue cubriendo', async () => {
  const events = [makeEvent({ uuid: 'w1', startIso: MIERCOLES_10AM, closerEmail: LUCAS, nowMs: LUNES })];
  const h = installHarness(scheduler, { events, optins: [], nowMs: LUNES });
  const marcadas = withPrefired(h);
  await scheduler.runPush1Adelantado({ offsetDays: 2, conexion: '30x', marcar: true });
  assert.equal(h.wa.sent.length, 0);
  assert.equal(marcadas.size, 0);
});

test('Push 1 de la noche se salta lo que ya salió adelantado y lista lo nuevo', async () => {
  // Martes 22, 7pm Bogotá: el Push 1 normal lista las citas del miércoles.
  const MARTES_7PM = Date.parse('2026-09-23T00:00:00Z');
  const vieja = makeEvent({ uuid: 'w1', startIso: MIERCOLES_10AM, closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs: MARTES_7PM });
  const nueva = makeEvent({ uuid: 'w2', startIso: MIERCOLES_3PM, closerEmail: LUCAS, prospectName: 'Beto Ruiz', nowMs: MARTES_7PM });
  const h = installHarness(scheduler, { events: [vieja, nueva], optins: [LUCAS_PHONE], nowMs: MARTES_7PM });
  withPrefired(h, [vieja.uri]);

  await scheduler.runPush1Early(); // second_brain (30X) → turno de las 5:30pm

  assert.equal(h.wa.sent.length, 1);
  const texto = h.wa.sent[0].text;
  assert.doesNotMatch(texto, /Ana Gómez/, 'la que ya salió no se repite');
  assert.match(texto, /Beto Ruiz/, 'la nueva sí recibe su Push 1');
  assert.match(leadTexts(texto)[0], /tu llamada de mañana miércoles a las/);
});

test('conexion: 30x deja fuera a los closers de otras conexiones', async () => {
  const events = [
    makeEvent({ uuid: 'w1', startIso: MIERCOLES_10AM, closerEmail: LUCAS, nowMs: LUNES }),
    makeEvent({ uuid: 'w2', startIso: MIERCOLES_3PM, closerEmail: SALAZAR, nowMs: LUNES }),
  ];
  const h = installHarness(scheduler, { events, optins: [LUCAS_PHONE, SALAZAR_PHONE], nowMs: LUNES });
  withPrefired(h);
  // El harness lista todo por la cuenta 30x; el filtro de closers por conexión es el que decide.
  await scheduler.runPush1Adelantado({ offsetDays: 2, conexion: '30x', marcar: true });
  const destinos = h.wa.sent.map((m) => m.to).join(' ');
  assert.doesNotMatch(destinos, /3054312905/, 'Salazar (estadox) no recibe la tanda de 30x');
});

// ─── Tandas fijas del Push 1 de 30X (2026-09-28) ─────────────────────────────────────────────
// Domingo → lunes y martes; martes → miércoles y jueves; jueves → viernes y sábado. Todo a las
// 5:30pm, dentro del job del turno temprano. Lo que fijan estos tests:
//   1. cada día de tanda cubre EXACTAMENTE sus dos días (ni el tercero, ni otra conexión);
//   2. el digest diario que corre detrás no repite nada de lo que la tanda acaba de mandar;
//   3. en un día sin tanda, el digest solo lista lo reservado DESPUÉS de la tanda;
//   4. las calls de domingo, que ninguna tanda cubre, salen el sábado por el digest diario.
const ABOGADOS_ET = 'https://api.calendly.com/event_types/83bb87b3-0c73-43ea-a618-196a74512eab';
const at530 = (fecha) => Date.parse(`${fecha}T22:30:00Z`); // 5:30pm Bogotá
const a10am = (fecha) => `${fecha}T15:00:00.000Z`; // 10:00am Bogotá

const TANDAS = [
  { envio: '2026-09-27', nombre: 'domingo', cubre: ['2026-09-28', '2026-09-29'], fuera: '2026-09-30' },
  { envio: '2026-09-29', nombre: 'martes', cubre: ['2026-09-30', '2026-10-01'], fuera: '2026-10-02' },
  { envio: '2026-10-01', nombre: 'jueves', cubre: ['2026-10-02', '2026-10-03'], fuera: '2026-10-04' },
];

for (const { envio, nombre, cubre, fuera } of TANDAS) {
  test(`tanda del ${nombre}: manda los dos días que le tocan, marca y no repite`, async () => {
    const nowMs = at530(envio);
    const events = [
      makeEvent({ uuid: 'd1', startIso: a10am(cubre[0]), closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs }),
      makeEvent({ uuid: 'd2', startIso: a10am(cubre[1]), closerEmail: LUCAS, prospectName: 'Beto Ruiz', nowMs }),
      makeEvent({ uuid: 'd3', startIso: a10am(fuera), closerEmail: LUCAS, prospectName: 'Caro Díaz', nowMs }),
      // EstadoX: ni tanda (otra conexión) ni turno temprano (otra empresa). Sale a las 7pm.
      makeEvent({ uuid: 'd4', startIso: a10am(cubre[0]), closerEmail: SALAZAR, eventType: ABOGADOS_ET, prospectName: 'Dani Soto', nowMs }),
    ];
    const h = installHarness(scheduler, { events, optins: [LUCAS_PHONE, SALAZAR_PHONE], nowMs });
    const marcadas = withPrefired(h);

    await scheduler.runPush1TurnoTemprano();

    assert.equal(h.wa.sent.length, 2, 'un digest por día cubierto, y el diario no manda nada más');
    const [primero, segundo] = h.wa.sent.map((m) => m.text);
    assert.match(primero, /Ana Gómez/);
    assert.match(primero, /Push 1 \(la noche anterior\)/);
    assert.match(segundo, /Beto Ruiz/);
    assert.match(segundo, /Push 1 \(adelantado\)/);
    const todo = `${primero}\n${segundo}`;
    assert.doesNotMatch(todo, /Caro Díaz/, 'el tercer día espera a su propia tanda');
    assert.doesNotMatch(todo, /Dani Soto/, 'EstadoX no entra en la tanda de 30x');
    assert.deepEqual([...marcadas].sort(), [events[0].uri, events[1].uri].sort());
  });
}

test('día sin tanda (lunes): el digest de las 5:30pm solo lista lo reservado después de la tanda', async () => {
  const nowMs = at530('2026-09-28');
  const vieja = makeEvent({ uuid: 'l1', startIso: a10am('2026-09-29'), closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs });
  const nueva = makeEvent({ uuid: 'l2', startIso: a10am('2026-09-29'), closerEmail: LUCAS, prospectName: 'Beto Ruiz', nowMs });
  const pasado = makeEvent({ uuid: 'l3', startIso: a10am('2026-09-30'), closerEmail: LUCAS, prospectName: 'Caro Díaz', nowMs });
  const h = installHarness(scheduler, { events: [vieja, nueva, pasado], optins: [LUCAS_PHONE], nowMs });
  withPrefired(h, [vieja.uri]); // salió en la tanda del domingo

  await scheduler.runPush1TurnoTemprano();

  assert.equal(h.wa.sent.length, 1);
  const texto = h.wa.sent[0].text;
  assert.match(texto, /Beto Ruiz/, 'la reservada después de la tanda sí recibe su Push 1');
  assert.doesNotMatch(texto, /Ana Gómez/, 'la de la tanda no se repite');
  assert.doesNotMatch(texto, /Caro Díaz/, 'el lunes no se adelanta nada: lo del miércoles sale el martes');
});

test('las calls de domingo salen el sábado por el digest diario', async () => {
  const nowMs = at530('2026-10-03');
  const events = [makeEvent({ uuid: 's1', startIso: a10am('2026-10-04'), closerEmail: LUCAS, prospectName: 'Ana Gómez', nowMs })];
  const h = installHarness(scheduler, { events, optins: [LUCAS_PHONE], nowMs });
  withPrefired(h);

  await scheduler.runPush1TurnoTemprano();

  assert.equal(h.wa.sent.length, 1);
  assert.match(h.wa.sent[0].text, /Ana Gómez/);
});
