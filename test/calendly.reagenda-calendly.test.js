// test/calendly.reagenda-calendly.test.js
// §18.BW — la reagenda hecha DENTRO de Calendly.
//
// El incidente que originó esto: un lead movió su call, Juanito entregó igual el push de la
// cita vieja con su link muerto, y lead y closer terminaron en dos meets distintos. La causa
// era que `getEvent` se llamaba SIN token → caía al de 30X → 403 contra las otras tres
// conexiones → la guardia de cancelación no corría. Los tests de este archivo fijan las tres
// mitades del arreglo: la guardia por conexión, la detección por `old_invitee`, y el aviso.
//
// Tier 1: puro + harness (sin DB nativa, sin red, sin WhatsApp real).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

import * as scheduler from '../src/scheduler/calendly.js';
import { __resetHealth } from '../src/calendly/health.js';
import { oldEventUuidFrom, decideRescheduleNotice } from '../src/calendly/push-logic.js';
import { buildRescheduleMessage, buildPrecallText, formatLeadWhen } from '../src/calendly/index.js';
import { PROGRAMS } from '../src/calendly/programs.js';
import { ACCOUNTS, accountOf } from '../src/calendly/accounts.js';
import { CLOSERS, accountOfCloser } from '../src/calendly/closers.js';
import { installHarness, makeEvent } from './helpers/calendly-harness.js';

const TZ = 'America/Bogota';
const API = 'https://api.calendly.com';

// El caso real, con sus horas de Bogotá (UTC-5, sin DST).
const AHORA = Date.parse('2026-09-04T14:00:00.000Z'); // 09:00 a. m.
const CALL_VIEJA = '2026-09-04T15:30:00.000Z'; // 10:30 a. m.
const CALL_NUEVA = '2026-09-04T17:00:00.000Z'; // 12:00 p. m.
// Para los tests de ENTREGA: una call cuyo push ya venció respecto de AHORA.
const CALL_VENCE = '2026-09-04T14:30:00.000Z'; // 09:30 a. m.

// Un closer por conexión, DERIVADO del registro y no escrito a mano: si mañana se agrega una
// conexión, entra sola a los tests que iteran esta tabla.
const CLOSER_POR_CUENTA = {};
for (const email of Object.keys(CLOSERS)) {
  const k = accountOfCloser(email);
  if (k && !CLOSER_POR_CUENTA[k]) CLOSER_POR_CUENTA[k] = email;
}
const CUENTAS = Object.keys(ACCOUNTS);
// Token de fixture por cuenta: lo que el mock de la API va a exigir para dejar leer el evento.
const TOKENS = Object.fromEntries(CUENTAS.map((k) => [k, `tok-${k}`]));

beforeEach(() => {
  process.env.CALENDLY_DRY_RUN = 'false';
  process.env.CALENDLY_DRY_RUN_ESTADOX = 'false';
  process.env.CALENDLY_DRY_RUN_RETIA = 'false';
  process.env.CALENDLY_DRY_RUN_COMUNICARTE = 'false';
  process.env.CALENDLY_REQUIRE_OPTIN = 'true';
  process.env.CALENDLY_PUSH3_LEAD_MIN = '25';
  process.env.ADMIN_LID = '129446371655733@lid';
  // Cada conexión con SU token, que es justo lo que el bug ignoraba.
  process.env.CALENDLY_TOKEN = TOKENS['30x'];
  process.env.CALENDLY_TOKEN_ESTADOX = TOKENS.estadox;
  process.env.CALENDLY_TOKEN_RETIA = TOKENS.retia;
  process.env.CALENDLY_TOKEN_COMUNICARTE = TOKENS.comunicarte;
  delete process.env.CALENDLY_RESCHEDULE_ALERT; // default: apagado
  delete process.env.CALENDLY_PUSH0_ENABLED;
  __resetHealth();
  scheduler.__resetDeps();
});

// ─── 1. La regresión: la guardia de cancelación, en TODAS las conexiones ──────
// Este es EL test del incidente. Se itera sobre el registro de cuentas, no sobre una lista
// escrita a mano, para que la próxima conexión que se agregue no pueda nacer con el agujero.
//
// Matiz para el que lea esto dentro de un año: el mock exige el token de la cuenta dueña
// SIEMPRE, también para '30x'. En producción '30x' nunca estuvo roto, porque `request()` cae a
// `CALENDLY_TOKEN` cuando no recibe token y ese es justamente el suyo — funcionaba de casualidad.
// El test fija el invariante que queremos ("cada cita se revalida con el token de SU conexión"),
// no la casualidad, así que las cuatro filas se exigen igual.

for (const cuenta of CUENTAS) {
  test(`guardia de cancelación viva en la conexión "${cuenta}" (403 si va con el token equivocado)`, async () => {
    const closerEmail = CLOSER_POR_CUENTA[cuenta];
    assert.ok(closerEmail, `la cuenta ${cuenta} tiene al menos un closer en el registro`);

    const ev = makeEvent({
      uuid: `cancelada-${cuenta}`,
      startIso: CALL_VENCE,
      closerEmail,
      nowMs: AHORA,
      account: cuenta, // el mock solo la deja leer con el token de ESTA cuenta
    });
    ev.status = 'canceled'; // el lead la movió: en Calendly quedó cancelada

    const { store } = installHarness(scheduler, {
      events: [ev],
      optins: [CLOSERS[closerEmail].phone],
      nowMs: AHORA,
      api: { tokensPorCuenta: TOKENS },
      accounts: CUENTAS.map((k) => accountOf(k)),
    });

    // El push ya estaba agendado de antes (el poll lo vio cuando la cita seguía viva).
    store.scheduleCalendlyPush({
      event_uuid: ev.uuid,
      push_n: 3,
      program: 'tactical_investor',
      closer_email: closerEmail,
      closer_phone: CLOSERS[closerEmail].phone,
      prospect_name: 'Juan Ferrujo',
      prospect_phone: '+573142653368',
      call_start: '2026-09-04 14:30:00',
      due_at: '2026-09-04 13:55:00', // ya venció: la entrega la toma en esta corrida
      message: 'push viejo con el link muerto',
    });

    await scheduler.runCalendlyDelivery();

    const fila = store._rows.find((r) => r.event_uuid === ev.uuid && r.push_n === 3);
    assert.equal(fila.status, 'skipped', `el push de una cita cancelada NO sale (conexión ${cuenta})`);
    assert.equal(fila.skip_reason, 'cancelada');
  });
}

// ─── 2. El parser puro ────────────────────────────────────────────────────────

test('oldEventUuidFrom: saca el uuid viejo del old_invitee, y no inventa nada', () => {
  const uuid = '5dfbeed1-920a-43c7-8672-f798e8bde715';
  const inv = { old_invitee: `${API}/scheduled_events/${uuid}/invitees/97029655-7614-43e2-95db-61df8bc9e377` };
  assert.equal(oldEventUuidFrom(inv), uuid);

  // No es reagenda, o no hay con qué: null. Nunca un uuid a medias — se usa para CANCELAR.
  assert.equal(oldEventUuidFrom({ old_invitee: null }), null);
  assert.equal(oldEventUuidFrom({}), null);
  assert.equal(oldEventUuidFrom(null), null);
  assert.equal(oldEventUuidFrom(undefined), null);
  assert.equal(oldEventUuidFrom({ old_invitee: 'https://calendly.com/reschedulings/abc' }), null);
  assert.equal(oldEventUuidFrom({ old_invitee: `${API}/scheduled_events/no-es-uuid/invitees/x` }), null);
});

// ─── 3. Qué forma toma el aviso ───────────────────────────────────────────────

test('decideRescheduleNotice: SIEMPRE avisa; correctivo solo si el Push 3 viejo ya salió', () => {
  const p = (push_n, status) => ({ push_n, status });

  // El lead ya tiene el link muerto en la mano → hay que corregirlo.
  assert.deepEqual(decideRescheduleNotice({ pushesViejos: [p(3, 'sent')] }), {
    notify: true,
    forma: 'correctivo',
  });

  // Todavía no salió → no hay nada que corregir, pero el closer igual se entera.
  assert.deepEqual(decideRescheduleNotice({ pushesViejos: [p(3, 'scheduled')] }), {
    notify: true,
    forma: 'informativo',
  });
  assert.deepEqual(decideRescheduleNotice({ pushesViejos: [p(3, 'skipped')] }), {
    notify: true,
    forma: 'informativo',
  });
  // Un Push 0 enviado no cuenta: ese no lleva link, no hay nada muerto que reemplazar.
  assert.equal(decideRescheduleNotice({ pushesViejos: [p(0, 'sent'), p(3, 'scheduled')] }).forma, 'informativo');
  assert.equal(decideRescheduleNotice({ pushesViejos: [] }).forma, 'informativo');
});

// ─── 4. El copy ───────────────────────────────────────────────────────────────

const COPY_BASE = {
  name: 'Juan Ferrujo',
  firstName: 'Juan',
  phone: '+573142653368',
  programKey: 'tactical_investor',
  closer: 'Andrea',
  deIso: CALL_VIEJA,
  aIso: CALL_NUEVA,
  linkLlamada: 'https://calendly.com/events/9164800c/google_meet',
  tz: TZ,
  ahora: new Date(AHORA),
};

test('aviso informativo: dice de dónde a dónde y que no hay que hacer nada, sin wa.me', () => {
  const msg = buildRescheduleMessage(COPY_BASE);
  assert.match(msg, /REAGENDA/);
  assert.match(msg, /Juan Ferrujo/);
  assert.match(msg, /10:30 am → \*.*12:00 pm\*/, 'muestra el salto de hora');
  assert.doesNotMatch(msg, /wa\.me/, 'informativo no le pide nada al closer');
});

test('aviso correctivo: lleva el wa.me y el texto al lead avisa que el link cambió', () => {
  const msg = buildRescheduleMessage({ ...COPY_BASE, forma: 'correctivo' });
  assert.match(msg, /ya no sirve/);
  assert.match(msg, /wa\.me\/573142653368/);

  const alLead = decodeURIComponent(msg.split('?text=')[1]);
  assert.match(alLead, /cambiamos la hora/);
  assert.match(alLead, /el link también cambió/);
  assert.match(alLead, /hoy a las 12:00 pm/);
  assert.ok(alLead.includes(COPY_BASE.linkLlamada), 'lleva el link NUEVO');
  assert.doesNotMatch(alLead, /el link que ya te compartí/, 'jamás apunta al link viejo');
});

test('correctivo SIN link: no inventa nada, manda al closer a hacerlo a mano', () => {
  const msg = buildRescheduleMessage({ ...COPY_BASE, forma: 'correctivo', linkLlamada: '' });
  assert.match(msg, /a mano/);
  assert.doesNotMatch(msg, /wa\.me/);
});

test('formatLeadWhen: hoy / mañana / fecha, y sin la coma que mete es-CO', () => {
  const base = new Date(AHORA);
  assert.equal(formatLeadWhen(CALL_NUEVA, TZ, base), 'hoy a las 12:00 pm');
  assert.equal(formatLeadWhen('2026-09-05T17:00:00.000Z', TZ, base), 'mañana a las 12:00 pm');
  assert.equal(formatLeadWhen('2026-09-12T14:30:00.000Z', TZ, base), 'el sábado 12 de septiembre a las 9:30 am');
});

// ─── 5. Cobertura por PROGRAMA (derivada del registro) ────────────────────────

test('el aviso de reagenda se renderiza para TODOS los programas del registro', () => {
  for (const key of Object.keys(PROGRAMS)) {
    const msg = buildRescheduleMessage({ ...COPY_BASE, programKey: key, forma: 'correctivo' });
    assert.match(msg, /wa\.me/, `${key}: el aviso correctivo tiene que traer el wa.me`);
    const alLead = decodeURIComponent(msg.split('?text=')[1]);
    assert.match(alLead, /el link también cambió/, `${key}: el lead tiene que saber que el link cambió`);
  }
});

test('un programa DESCONOCIDO igual recibe su aviso (no pasa por el portón de PROGRAM_PITCH)', () => {
  // Es el caso de una fila con `program` NULL. Antes, cualquier copy al lead moría en el
  // portón del pitch; el aviso de reagenda no puede depender de eso, porque una call cuyo
  // programa no se pudo identificar es justo la que MÁS necesita que avisen que se movió.
  const texto = buildPrecallText({
    programKey: null,
    pushN: 'reagenda',
    primerNombre: 'Juan',
    cuando: 'hoy a las 12:00 pm',
    linkLlamada: 'https://x/meet',
  });
  assert.ok(texto, 'sin pitch, igual hay texto');
  assert.match(texto, /el link también cambió/);

  // Y el Push 3 sigue comportándose como siempre (esto NO se tocó).
  assert.equal(buildPrecallText({ programKey: null, pushN: 3, primerNombre: 'Juan' }), null);
});

// ─── 6. Escenario end-to-end: el caso de Andre, tal cual pasó ────────────────

// Fixture del caso real: la cita vieja con su push ya agendado, y la nueva que la reemplaza.
function escenarioFerrujo({ closerEmail, cuenta = 'retia', push3ViejoEnviado = false } = {}) {
  const viejo = makeEvent({
    uuid: '5dfbeed1-920a-43c7-8672-f798e8bde715',
    startIso: CALL_VIEJA,
    closerEmail,
    prospectName: 'Juan Ferrujo',
    prospectPhone: '+573142653368',
    nowMs: AHORA,
    account: cuenta,
  });
  viejo.status = 'canceled'; // Calendly la cancela al reagendar
  const nuevo = makeEvent({
    uuid: '9164800c-9606-49a3-ae77-98800cfee921',
    startIso: CALL_NUEVA,
    closerEmail,
    prospectName: 'Juan Ferrujo',
    prospectPhone: '+573142653368',
    createdInMin: -3,
    nowMs: AHORA,
    account: cuenta,
    joinUrl: 'https://calendly.com/events/9164800c/google_meet',
    oldEventUuid: viejo.uuid, // ← el único hilo entre las dos
  });

  const h = installHarness(scheduler, {
    events: [viejo, nuevo],
    optins: [CLOSERS[closerEmail].phone],
    nowMs: AHORA,
    api: { tokensPorCuenta: TOKENS },
    // Las cuatro conexiones, como en producción: el poll hace fan-out por cuenta y cada una
    // consulta con SU token.
    accounts: CUENTAS.map((k) => accountOf(k)),
  });

  h.store.scheduleCalendlyPush({
    event_uuid: viejo.uuid,
    push_n: 3,
    program: 'tactical_investor',
    closer_email: closerEmail,
    closer_phone: CLOSERS[closerEmail].phone,
    prospect_name: 'Juan Ferrujo',
    prospect_phone: '+573142653368',
    call_start: '2026-09-04 15:30:00',
    due_at: '2026-09-04 15:05:00',
    message: 'Push 3 con el link VIEJO',
  });
  if (push3ViejoEnviado) {
    const f = h.store._rows.find((r) => r.event_uuid === viejo.uuid && r.push_n === 3);
    f.status = 'sent';
  }
  return h;
}

test('caso Andre: el push de la cita vieja se mata y el de la nueva queda con el link nuevo', async () => {
  const closerEmail = CLOSER_POR_CUENTA.retia;
  const { store } = escenarioFerrujo({ closerEmail });

  await scheduler.runCalendlyPoll();

  const viejo = store._rows.find((r) => r.event_uuid.startsWith('5dfbeed1') && r.push_n === 3);
  assert.equal(viejo.status, 'skipped', 'el push de la cita muerta ya no sale');
  assert.equal(viejo.skip_reason, 'reagendada');

  const nuevo = store._rows.find((r) => r.event_uuid.startsWith('9164800c') && r.push_n === 3);
  assert.ok(nuevo, 'la cita nueva tiene su Push 3');
  assert.equal(nuevo.call_start, '2026-09-04 17:00:00', 'a la hora NUEVA');
  assert.ok(
    decodeURIComponent(nuevo.message).includes('https://calendly.com/events/9164800c/google_meet'),
    'con el link NUEVO'
  );
});

test('una reagenda NO dispara el Push 0 de "te reservaron un espacio"', async () => {
  const { store } = escenarioFerrujo({ closerEmail: CLOSER_POR_CUENTA.retia });
  await scheduler.runCalendlyPoll();
  assert.equal(store._rows.filter((r) => r.push_n === 0).length, 0, 'no fue una reserva, fue una mudanza');
});

test('el aviso sale UNA sola vez, aunque el poll vuelva a ver la cita', async () => {
  process.env.CALENDLY_RESCHEDULE_ALERT = 'true';
  const { store } = escenarioFerrujo({ closerEmail: CLOSER_POR_CUENTA.retia });

  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyPoll(); // el poll corre cada 5 min y ve lo mismo

  const avisos = store._rows.filter((r) => r.push_n === 6);
  assert.equal(avisos.length, 1, 'UNIQUE(event_uuid, push_n) → un aviso por reagenda');
  assert.match(avisos[0].message, /REAGENDA/);
});

test('con el Push 3 viejo YA enviado, el aviso es correctivo y trae el link nuevo', async () => {
  process.env.CALENDLY_RESCHEDULE_ALERT = 'true';
  const { store, wa } = escenarioFerrujo({
    closerEmail: CLOSER_POR_CUENTA.retia,
    push3ViejoEnviado: true,
  });

  await scheduler.runCalendlyPoll();
  const aviso = store._rows.find((r) => r.push_n === 6);
  assert.match(aviso.message, /ya no sirve/, 'el lead tiene un link muerto: hay que corregirlo');
  assert.match(aviso.message, /wa\.me/);

  // Y se entrega tal cual: NO se reconstruye como si fuera un Push 3.
  await scheduler.runCalendlyDelivery();
  assert.equal(store._rows.find((r) => r.push_n === 6).status, 'sent');
  const salido = wa.sent.find((m) => /REAGENDA/.test(m.text));
  assert.ok(salido, 'el aviso salió por la cola, con sus gates anti-ban');
  assert.doesNotMatch(salido.text, /Push 3/, 'el aviso no se degrada a Push 3 al entregarse');
});

test('el aviso está apagado por default (flag off = nada nuevo sale)', async () => {
  const { store } = escenarioFerrujo({ closerEmail: CLOSER_POR_CUENTA.retia });
  await scheduler.runCalendlyPoll();
  assert.equal(store._rows.filter((r) => r.push_n === 6).length, 0, 'sin el flag no hay aviso…');
  const viejo = store._rows.find((r) => r.event_uuid.startsWith('5dfbeed1') && r.push_n === 3);
  assert.equal(viejo.status, 'skipped', '…pero matar el push muerto NO depende del flag: es el bug');
});

test('reagenda cuya cita vieja ya no está en la DB: no anuncia reserva nueva ni inventa el aviso', async () => {
  // El cleanup de las 3am purga a los 30 días, así que una cita puede venir de otra que ya no
  // tenemos. Sigue sin ser una reserva nueva (nada de "te reservaron un espacio"), pero sin las
  // filas viejas no se sabe de qué hora venía: el aviso se abstiene en vez de media frase.
  process.env.CALENDLY_RESCHEDULE_ALERT = 'true';
  const closerEmail = CLOSER_POR_CUENTA.retia;
  const nuevo = makeEvent({
    uuid: 'huerfana',
    startIso: CALL_NUEVA,
    closerEmail,
    createdInMin: -3,
    nowMs: AHORA,
    account: 'retia',
    joinUrl: 'https://calendly.com/events/huerfana/google_meet',
    oldEventUuid: '00000000-0000-0000-0000-000000000000', // sin filas en la DB
  });

  const { store } = installHarness(scheduler, {
    events: [nuevo],
    optins: [CLOSERS[closerEmail].phone],
    nowMs: AHORA,
    api: { tokensPorCuenta: TOKENS },
    accounts: CUENTAS.map((k) => accountOf(k)),
  });

  await scheduler.runCalendlyPoll();

  assert.equal(store._rows.filter((r) => r.push_n === 0).length, 0, 'no fue una reserva nueva');
  assert.equal(store._rows.filter((r) => r.push_n === 6).length, 0, 'sin la hora vieja, no se avisa a medias');
  assert.ok(store._rows.find((r) => r.push_n === 3), 'la cita nueva igual recibe su Push 3');
});
