// Push del viernes (2026-10-09): digest adicional con las llamadas del LUNES de Método Comunicarte
// y De Cero a Tactical Investor, viernes 4pm. Lo que fijan estos tests:
//   1. el copy de cada programa es el dictado por el jefe, con fecha, hora, video y brochure;
//   2. solo entran citas de LUNES de esos dos programas (ni martes, ni 30X);
//   3. un disparo fuera de viernes no manda nada;
//   4. es ADICIONAL: no marca `prefired`, el Push 1 del domingo sigue igual;
//   5. el video de Tactical Investor es el de RETIA GROWTH.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { buildPrecallText, MATERIAL_LINKS } from '../src/calendly/index.js';
import { PROGRAMS } from '../src/calendly/programs.js';
import { accountOf } from '../src/calendly/accounts.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const ANDREA_COMUNICARTE = 'info@eventoscomunicarte.com';
const ANDREA_COMUNICARTE_PHONE = '+573171297303';
const ANDREA_RETIA = 'registro@ttrading.co';
const ANDREA_RETIA_PHONE = '+573132484664';

// Viernes 9-oct-2026, 4:00pm Bogotá.
const VIERNES = Date.parse('2026-10-09T21:00:00Z');
const LUNES_10AM = '2026-10-12T15:00:00.000Z';
const MARTES_10AM = '2026-10-13T15:00:00.000Z';

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN_RETIA = 'false';
  process.env.CALENDLY_DRY_RUN_COMUNICARTE = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH4_ENABLED = 'false';
  __resetHealth();
  scheduler.__resetDeps();
});

const leadTexts = (text) =>
  (text.match(/https:\/\/wa\.me\/\S+/g) || []).map((l) => decodeURIComponent(l.split('?text=')[1]));

const cuentas = () => [accountOf('retia'), accountOf('comunicarte')];
const optins = () => [ANDREA_COMUNICARTE_PHONE, ANDREA_RETIA_PHONE];

test('el video de Tactical Investor es el de RETIA GROWTH', () => {
  assert.equal(MATERIAL_LINKS.tactical_investor.video, 'https://youtu.be/SYt-wv6V9Mw');
});

test('copy Comunicarte: fecha, hora, video y brochure', () => {
  const t = buildPrecallText({
    programKey: 'comunicarte', pushN: 'viernes', primerNombre: 'Ana', closer: 'Andrea', hora: '10:00 am', fecha: '12 de octubre',
  });
  assert.match(t, /^¡Hola, Ana! ¿Cómo vas\? Te habla Andrea, del equipo de Comunicarte\./);
  assert.match(t, /el lunes 12 de octubre a las 10:00 am \(hora Colombia\)/);
  assert.ok(t.includes(`👇\n${PROGRAMS.comunicarte.materials.video}\n`));
  assert.ok(t.includes(`darle una mirada antes:\n${PROGRAMS.comunicarte.materials.brochure}\n`));
  assert.match(t, /¡Feliz fin de semana!$/);
});

test('copy Tactical Investor: fecha, hora, video y brochure', () => {
  const t = buildPrecallText({
    programKey: 'tactical_investor', pushN: 'viernes', primerNombre: 'Luis', closer: 'Andrea', hora: '3:00 pm', fecha: '12 de octubre',
  });
  assert.match(t, /^¡Hola, Luis! ¿Como estás\? Te habla Andrea, del equipo de Tactical Investor\./);
  assert.match(t, /el lunes 12 de octubre a las 3:00 pm \(hora Colombia\)/);
  assert.ok(t.includes('👇\nhttps://youtu.be/SYt-wv6V9Mw\n'));
  assert.ok(t.includes(`detalle del programa:\n${PROGRAMS.tactical_investor.materials.brochure}\n`));
  assert.match(t, /¡Buen fin de semana!$/);
});

test('un programa sin copy del viernes devuelve null (mándalo manual)', () => {
  assert.equal(
    buildPrecallText({ programKey: 'second_brain', pushN: 'viernes', primerNombre: 'Ana', closer: 'X', hora: '1 pm', fecha: '12 de octubre' }),
    null
  );
});

test('viernes 4pm: lista solo los lunes de Comunicarte y Tactical Investor, sin marcar prefired', async () => {
  const comET = PROGRAMS.comunicarte.eventType;
  const tiET = PROGRAMS.tactical_investor.eventType;
  const events = [
    makeEvent({ uuid: 'c1', startIso: LUNES_10AM, closerEmail: ANDREA_COMUNICARTE, prospectName: 'Ana Gómez', eventType: comET, account: 'comunicarte', nowMs: VIERNES }),
    makeEvent({ uuid: 't1', startIso: LUNES_10AM, closerEmail: ANDREA_RETIA, prospectName: 'Luis Pérez', eventType: tiET, account: 'retia', nowMs: VIERNES }),
    makeEvent({ uuid: 'c2', startIso: MARTES_10AM, closerEmail: ANDREA_COMUNICARTE, prospectName: 'Martes Ruiz', eventType: comET, account: 'comunicarte', nowMs: VIERNES }),
  ];
  const h = installHarness(scheduler, { events, optins: optins(), nowMs: VIERNES, accounts: cuentas() });
  const marcadas = new Set();
  scheduler.__setDeps({
    ...h.deps,
    getPush1PrefiredKeys: () => new Set(marcadas),
    markPush1Prefired: (keys) => keys.forEach((k) => marcadas.add(k)),
  });

  await scheduler.runPushViernes();

  const leads = h.wa.sent.flatMap((m) => leadTexts(m.text));
  assert.equal(leads.length, 2, 'solo las dos calls del lunes');
  assert.ok(leads.some((l) => /equipo de Comunicarte/.test(l) && /lunes 12 de octubre a las 10:00 am/.test(l)));
  assert.ok(leads.some((l) => /equipo de Tactical Investor/.test(l)));
  assert.ok(h.wa.sent.every((m) => /Push Viernes/.test(m.text)));
  assert.ok(!h.wa.sent.some((m) => /Martes Ruiz/.test(m.text)), 'la call del martes no entra');
  assert.equal(marcadas.size, 0, 'es adicional: no marca prefired');
});

test('fuera de viernes no manda nada', async () => {
  const JUEVES = Date.parse('2026-10-08T21:00:00Z');
  const events = [
    makeEvent({ uuid: 'c1', startIso: '2026-10-11T15:00:00.000Z', closerEmail: ANDREA_COMUNICARTE, eventType: PROGRAMS.comunicarte.eventType, account: 'comunicarte', nowMs: JUEVES }),
  ];
  const h = installHarness(scheduler, { events, optins: optins(), nowMs: JUEVES, accounts: cuentas() });
  await scheduler.runPushViernes();
  assert.equal(h.wa.sent.length, 0);
});
