// test/calendly.sheet-push.test.js
// Push 5 (§18.AP): el recordatorio de llenar los Google Sheets que sale DESPUÉS de la call.
//
// Dos ideas se protegen acá, y las dos son de las que rompen en silencio:
//   1. **Solo lo recibe quien declara `sheets`** (hoy retia y comunicarte). 30X no puede recibirlo nunca,
//      ni siquiera cuando el mismo humano cierra para las dos empresas.
//   2. **El guard de obsolescencia no lo mata.** Ese guard descarta todo push cuya call ya
//      empezó; este vence después de que TERMINÓ. Si el bloque de entrega quedara del lado
//      equivocado del guard, la feature no fallaría ruidosamente: simplemente no enviaría
//      nunca nada. Por eso hay un test dedicado.
//
// Se usan los registros REALES (accountOf('retia'), CLOSERS) en vez de fixtures inventados:
// lo que hay que verificar es el cableado que se despliega, incluidos los links de verdad.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.CALENDLY_REQUIRE_OPTIN = 'true';
process.env.CALENDLY_DRY_RUN = 'false'; // 30x en vivo, como en producción
process.env.CALENDLY_DRY_RUN_ESTADOX = 'false'; // estadox también (Salazar vive ahí desde 2026-08-25)
process.env.CALENDLY_DRY_RUN_RETIA = 'false'; // retia también (así está en el VPS)
process.env.CALENDLY_DRY_RUN_COMUNICARTE = 'false'; // y comunicarte (en vivo desde 2026-08-25)
process.env.ADMIN_LID = '129446371655733@lid';

const scheduler = await import('../src/scheduler/calendly.js');
const { installHarness, makeEvent, realAccount } = await import('./helpers/calendly-harness.js');
const { push5DueUtc, buildPush5Message } = await import('../src/calendly/sheet-push.js');
const { accountOf } = await import('../src/calendly/accounts.js');
const { CLOSERS } = await import('../src/calendly/closers.js');
const { __resetHealth } = await import('../src/calendly/health.js');

const MIN = 60000;
const RETIA = accountOf('retia');
const ET_RETIA = Object.keys(RETIA.eventTypes)[0];
const COMUNICARTE = accountOf('comunicarte');
const ET_COMUNICARTE = Object.keys(COMUNICARTE.eventTypes)[0];
// Maru Marquez es el caso filoso del roster desde el 2026-09-02: UNA persona, UNA línea de
// WhatsApp y DOS identidades (comunicarte + retia), cada una con SU sheet. La cuenta se resuelve
// por EMAIL, así que sus dos calls tienen que caer en lados distintos aunque compartan teléfono,
// opt-in e hilo. Su identidad de retia es el BUZÓN-ROL `equipo@ttrading.co`, no un correo personal
// (lo tuvo Sebastian Salazar hasta esa fecha; corrección original del 2026-07-29).
const MARU = 'soymarumarquez@gmail.com';
const MARU_RETIA = 'equipo@ttrading.co';
const PHONE_MARU = CLOSERS[MARU].phone;

// Salazar quedó con una sola identidad (estadox). Sigue acá porque su conexión NO declara
// `sheets`: es el lado negativo del test de alcance.
const SALAZAR_30X = 'sebastian.salazar@30x.com';
const PHONE_SALAZAR = CLOSERS[SALAZAR_30X].phone;

// El evento de Calendly trae `end_time`; el fixture del harness no lo emite (ningún push lo
// necesitaba hasta ahora), así que se lo agregamos acá en vez de tocar el harness compartido.
function eventoCon(durationMin, opts) {
  const ev = makeEvent(opts);
  return { ...ev, end_time: new Date(new Date(ev.start_time).getTime() + durationMin * MIN).toISOString() };
}

const optinDeMaru = () => [{ phone: PHONE_MARU, source: 'self', contactJid: '999@lid' }];
const optinDeSalazar = () => [{ phone: PHONE_SALAZAR, source: 'self', contactJid: '998@lid' }];

// ─── El vencimiento ───────────────────────────────────────────────────────────

test('push5DueUtc usa el fin REAL de la call: una de 45 min no se avisa mientras sigue en curso', () => {
  const start = '2026-07-28T15:00:00Z';
  const end = '2026-07-28T15:45:00Z';
  const due = push5DueUtc(start, end, { durationMin: 30, delayMin: 10 });
  assert.equal(due.toISOString(), '2026-07-28T15:55:00.000Z');
  // Lo que NO debe pasar: 15:40, que con la duración asumida caería con el closer hablando.
  assert.notEqual(due.toISOString(), '2026-07-28T15:40:00.000Z');
});

test('push5DueUtc sin end_time cae a la duración asumida (uuid sintético, payload viejo)', () => {
  const due = push5DueUtc('2026-07-28T15:00:00Z', undefined, { durationMin: 30, delayMin: 10 });
  assert.equal(due.toISOString(), '2026-07-28T15:40:00.000Z');
  // Una fecha basura se trata igual que la ausencia, no produce Invalid Date.
  const dueMala = push5DueUtc('2026-07-28T15:00:00Z', 'no-es-fecha', { durationMin: 30, delayMin: 10 });
  assert.equal(dueMala.toISOString(), '2026-07-28T15:40:00.000Z');
});

// ─── El mensaje ───────────────────────────────────────────────────────────────

test('el mensaje lleva los links de Retia, cada uno con su rótulo', () => {
  const msg = buildPush5Message({
    name: 'Juan Pérez',
    firstName: 'Juan',
    startIso: '2026-07-28T20:00:00Z',
    sheets: RETIA.sheets,
  });
  assert.match(msg, /Juan Pérez/);
  assert.match(msg, /03:00 p\. ?m\./i, 'la hora va en horario de Bogotá');
  for (const s of RETIA.sheets) {
    assert.ok(msg.includes(s.label), `falta el rótulo "${s.label}"`);
    assert.ok(msg.includes(s.url), `falta el link de "${s.label}"`);
  }
});

// Cada conexión pide SUS sheets, y esta es la aserción que lo fija. Hasta el 2026-08-26 el
// sheet de Comunicarte colgaba de la conexión `retia`, así que a Andrea —que cierra en las
// dos— se le pedía después de una call de Tactical Investor, cuando no le tocaba.
test('el Push 5 de Retia NO menciona el sheet de otra conexión', () => {
  const msg = buildPush5Message({
    name: 'Juan Pérez',
    firstName: 'Juan',
    startIso: '2026-07-28T20:00:00Z',
    sheets: RETIA.sheets,
  });
  for (const s of COMUNICARTE.sheets) {
    assert.ok(!msg.includes(s.url), `el push de Retia no debe traer el sheet de "${s.label}"`);
  }
});

// ─── Alcance: solo la conexión que declara sheets ─────────────────────────────

test('30X no declara `sheets` → jamás se le agenda un Push 5', async () => {
  __resetHealth();
  const now = Date.parse('2026-07-28T14:00:00Z');
  const { store } = installHarness(scheduler, {
    nowMs: now,
    accounts: [realAccount()],
    optins: optinDeSalazar(),
    events: [
      eventoCon(30, { uuid: 'e-30x', startInMin: 40, closerEmail: SALAZAR_30X, nowMs: now, account: '30x' }),
    ],
  });

  await scheduler.runCalendlyPoll();

  assert.equal(store._rows.filter((p) => p.push_n === 5).length, 0, '30X no puede recibir Push 5');
  assert.equal(store._rows.filter((p) => p.push_n === 3).length, 1, 'pero su Push 3 sigue igual');
  scheduler.__resetDeps();
});

// ComunicArte declara sus `sheets` desde el 2026-08-26. Antes, Maru —que cierra solo esa
// conexión— no recibía NINGÚN push post-call: la conexión no declaraba la lista y el Push 4
// está apagado en las dos cuentas de Retia. Cero recordatorios de registrar sus calls.
test('ComunicArte declara `sheets` → su closer recibe el Push 5, con SU sheet', async () => {
  __resetHealth();
  const now = Date.parse('2026-07-28T14:00:00Z');
  const { store, wa, clock } = installHarness(scheduler, {
    nowMs: now,
    accounts: [accountOf('comunicarte')],
    optins: [{ phone: PHONE_MARU, source: 'self', contactJid: '888@lid' }],
    events: [
      eventoCon(30, {
        uuid: 'e-comunicarte',
        startInMin: 40,
        closerEmail: MARU,
        eventType: ET_COMUNICARTE,
        nowMs: now,
        account: 'comunicarte',
      }),
    ],
  });

  await scheduler.runCalendlyPoll();
  const p5 = store._rows.find((p) => p.push_n === 5);
  assert.ok(p5, 'se agendó el Push 5 de ComunicArte');

  clock.ms = now + 95 * MIN; // start (+40) + 30 de call + 10 de delay, con margen
  await scheduler.runCalendlyDelivery();

  const enviados = wa.sent.filter((m) => m.text.includes('Registra la call'));
  assert.equal(enviados.length, 1, 'un solo recordatorio');
  assert.ok(enviados[0].text.includes(COMUNICARTE.sheets[0].url), 'con el sheet de Comunicarte');
  for (const s of RETIA.sheets)
    assert.ok(!enviados[0].text.includes(s.url), `y sin el sheet de "${s.label}", que es de otra conexión`);
  scheduler.__resetDeps();
});

test('la MISMA persona con dos identidades: cada call pide SU sheet, por el mismo hilo', async () => {
  // Maru cierra ComunicArte y Tactical Investor desde una sola línea (rotación del 2026-09-02:
  // heredó el buzón-rol de Salazar). Es el caso que el Push 5 tiene que resolver por CONEXIÓN de
  // la call y no por persona: el bug del 2026-08-26 fue exactamente este, con Andrea recibiendo
  // el sheet de Comunicarte pegado a una call de Tactical Investor. Un recordatorio que pide el
  // link equivocado enseña a ignorar el recordatorio.
  __resetHealth();
  const now = Date.parse('2026-07-28T14:00:00Z');
  const { store, wa, clock } = installHarness(scheduler, {
    nowMs: now,
    accounts: [COMUNICARTE, RETIA],
    optins: optinDeMaru(), // UN solo opt-in: las dos identidades comparten teléfono e hilo
    events: [
      eventoCon(30, {
        uuid: 'e-comunicarte',
        startInMin: 40, // 14:40 → 15:10, Push 5 a las 15:20
        closerEmail: MARU,
        eventType: ET_COMUNICARTE,
        nowMs: now,
        account: 'comunicarte',
      }),
      eventoCon(30, {
        uuid: 'e-retia',
        startInMin: 50, // 14:50 → 15:20, Push 5 a las 15:30
        closerEmail: MARU_RETIA,
        eventType: ET_RETIA,
        nowMs: now,
        account: 'retia',
      }),
    ],
  });

  await scheduler.runCalendlyPoll();

  const push5 = store._rows.filter((p) => p.push_n === 5);
  assert.equal(push5.length, 2, 'un Push 5 por call: las dos conexiones declaran sheets');
  assert.deepEqual(
    push5.map((p) => p.closer_email).sort(),
    [MARU_RETIA, MARU].sort(),
    'cada fila queda con el EMAIL de su identidad, no con el de la persona'
  );
  // Ninguna de las dos conexiones de Retia tiene Push 4: el 5 no lo reemplaza, es que el 4 nunca
  // existió acá. Si alguna vez aparece un push 4 en este test, alguien lo prendió sin querer.
  assert.equal(store._rows.filter((p) => p.push_n === 4).length, 0);

  clock.ms = Date.parse('2026-07-28T15:31:00Z'); // después de los dos vencimientos
  await scheduler.runCalendlyDelivery();

  const enviados = wa.sent.filter((m) => m.text.includes('Registra la call'));
  assert.equal(enviados.length, 2, 'los dos recordatorios salen');
  assert.equal(new Set(enviados.map((m) => m.to)).size, 1, 'y los dos al MISMO hilo: una sola línea');

  const urlCom = COMUNICARTE.sheets[0].url;
  const deCom = enviados.find((m) => m.text.includes(urlCom));
  assert.ok(deCom, 'el de ComunicArte trae su sheet');
  for (const sh of RETIA.sheets)
    assert.ok(!deCom.text.includes(sh.url), `y NO el de "${sh.label}", que es de la otra conexión`);

  const deRetia = enviados.find((m) => m !== deCom);
  for (const sh of RETIA.sheets)
    assert.ok(deRetia.text.includes(sh.url), `el de Tactical Investor trae el sheet de "${sh.label}"`);
  assert.ok(!deRetia.text.includes(urlCom), 'y NO el de ComunicArte');
  scheduler.__resetDeps();
});

test('CALENDLY_SHEET_PUSH=false apaga el Push 5 sin tocar los pushes precall', async () => {
  __resetHealth();
  process.env.CALENDLY_SHEET_PUSH = 'false';
  try {
    const now = Date.parse('2026-07-28T14:00:00Z');
    const { store } = installHarness(scheduler, {
      nowMs: now,
      accounts: [RETIA],
      optins: optinDeMaru(),
      events: [
        eventoCon(30, {
          uuid: 'e-retia',
          startInMin: 40,
          closerEmail: MARU_RETIA,
          eventType: ET_RETIA,
          nowMs: now,
          account: 'retia',
        }),
      ],
    });

    await scheduler.runCalendlyPoll();

    assert.equal(store._rows.filter((p) => p.push_n === 5).length, 0);
    assert.equal(store._rows.filter((p) => p.push_n === 3).length, 1, 'el precall no se ve afectado');
  } finally {
    delete process.env.CALENDLY_SHEET_PUSH;
    scheduler.__resetDeps();
  }
});

// ─── Entrega ──────────────────────────────────────────────────────────────────

test('el guard de obsolescencia NO mata el Push 5: se entrega con la call ya terminada', async () => {
  __resetHealth();
  const now = Date.parse('2026-07-28T14:00:00Z');
  const { store, wa, clock } = installHarness(scheduler, {
    nowMs: now,
    accounts: [RETIA],
    optins: optinDeMaru(),
    events: [
      eventoCon(30, {
        uuid: 'e-retia',
        startInMin: 40, // call 14:40 → 15:10, Push 5 a las 15:20
        closerEmail: MARU_RETIA,
        eventType: ET_RETIA,
        nowMs: now,
        account: 'retia',
      }),
    ],
  });

  await scheduler.runCalendlyPoll();
  const p5 = store._rows.find((p) => p.push_n === 5);
  assert.equal(p5.due_at, '2026-07-28 15:20:00', 'fin real (15:10) + 10 min');

  // Se adelanta el reloj hasta después de que la call terminó: es justo el estado en el que
  // el guard descartaría cualquier otro push.
  clock.ms = Date.parse('2026-07-28T15:21:00Z');
  await scheduler.runCalendlyDelivery();

  assert.equal(store._rows.find((p) => p.push_n === 5).status, 'sent');
  const enviados = wa.sent.filter((m) => m.text.includes('Registra la call'));
  assert.equal(enviados.length, 1, 'se envía exactamente un recordatorio');
  // Recorre la lista en vez de indexar posiciones: cuántos sheets tiene Retia es una decisión
  // de operación que ya cambió una vez (el de Comunicarte se mudó a su conexión el 2026-08-26)
  // y este test es sobre el guard de obsolescencia, no sobre el tamaño de la lista.
  for (const s of RETIA.sheets)
    assert.ok(enviados[0].text.includes(s.url), `con el sheet de "${s.label}"`);
  scheduler.__resetDeps();
});

test('cita cancelada antes de la hora → no se le pide registrar una call que no pasó', async () => {
  __resetHealth();
  const now = Date.parse('2026-07-28T14:00:00Z');
  const { store, wa, clock, api } = installHarness(scheduler, {
    nowMs: now,
    accounts: [RETIA],
    optins: optinDeMaru(),
    events: [
      eventoCon(30, {
        uuid: 'e-retia',
        startInMin: 40,
        closerEmail: MARU_RETIA,
        eventType: ET_RETIA,
        nowMs: now,
        account: 'retia',
      }),
    ],
  });

  await scheduler.runCalendlyPoll();
  api.cancel('e-retia');
  clock.ms = Date.parse('2026-07-28T15:21:00Z');
  await scheduler.runCalendlyDelivery();

  assert.equal(store._rows.find((p) => p.push_n === 5).status, 'skipped');
  assert.equal(wa.sent.filter((m) => m.text.includes('Registra la call')).length, 0);
  scheduler.__resetDeps();
});

test('cuenta en dry-run: se consume la fila pero no sale ningún mensaje', async () => {
  __resetHealth();
  process.env.CALENDLY_DRY_RUN_RETIA = 'true';
  try {
    const now = Date.parse('2026-07-28T14:00:00Z');
    const { store, wa, clock } = installHarness(scheduler, {
      nowMs: now,
      accounts: [RETIA],
      optins: optinDeMaru(),
      events: [
        eventoCon(30, {
          uuid: 'e-retia',
          startInMin: 40,
          closerEmail: MARU_RETIA,
          eventType: ET_RETIA,
          nowMs: now,
          account: 'retia',
        }),
      ],
    });

    await scheduler.runCalendlyPoll();
    clock.ms = Date.parse('2026-07-28T15:21:00Z');
    await scheduler.runCalendlyDelivery();

    assert.equal(store._rows.find((p) => p.push_n === 5).status, 'sent');
    assert.equal(wa.sent.filter((m) => m.text.includes('Registra la call')).length, 0);
  } finally {
    process.env.CALENDLY_DRY_RUN_RETIA = 'false';
    scheduler.__resetDeps();
  }
});
