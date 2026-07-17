// test/calendly.multi-account.test.js
// Escenarios de DOS agencias con cuentas de Calendly distintas conviviendo en el mismo
// Juanito. Todo lo de acá protege una idea: **lo que pasa en una cuenta no puede tocar a
// la otra** — ni sus envíos, ni sus errores, ni sus datos.
//
// La cuenta se resuelve por el CLOSER (accountOfCloser), así que los escenarios registran
// un closer de mentira en el roster real y lo quitan al terminar.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.CALENDLY_REQUIRE_OPTIN = 'true';
process.env.CALENDLY_DRY_RUN = 'false'; // la cuenta 30x va EN VIVO, como en producción
process.env.ADMIN_LID = '129446371655733@lid'; // sin admins, notifyAdmins solo loguea

const scheduler = await import('../src/scheduler/calendly.js');
const { installHarness, makeEvent, makeAccount, realAccount } = await import(
  './helpers/calendly-harness.js'
);
const { CLOSERS } = await import('../src/calendly/closers.js');
const { ACCOUNTS } = await import('../src/calendly/accounts.js');
const { __resetHealth } = await import('../src/calendly/health.js');

const MIN = 60000;

// ─── Fixtures de la "agencia #2" ──────────────────────────────────────────────

const ACCT2 = 'agencia2';
const ET2 = 'https://api.calendly.com/event_types/aaaa1111-2222-3333-4444-555566667777';

const CLOSER_30X = { email: 'pablo.lozano@30x.com', phone: CLOSERS['pablo.lozano@30x.com'].phone };
const CLOSER_A2 = { email: 'closer@agencia2.com', name: 'Ana Prueba', phone: '+573001234567' };

// Registra la cuenta #2 y su closer en los registros REALES, y los quita al terminar.
// Se toca el objeto exportado (que ES el registro) en vez de inventar un seam solo-tests.
// `await fn()` va adentro del try a propósito: con `return fn()` el finally desmontaría los
// fixtures antes de que el cuerpo async llegara a correr.
async function withAgencia2(fn) {
  ACCOUNTS[ACCT2] = makeAccount({
    key: ACCT2,
    label: 'Agencia 2',
    eventTypes: { [ET2]: 'programa_a2' },
    dryRun: true, // arranca MUDA, como en el rollout real
    push4: false, // v1: solo pushes precall
    hubspot: false, // su CRM no es el que Juanito tiene conectado
  });
  CLOSERS[CLOSER_A2.email] = { name: CLOSER_A2.name, phone: CLOSER_A2.phone, account: ACCT2 };
  __resetHealth(); // el dedup de alertas (6h) es global: sin esto un test tapa al siguiente
  try {
    return await fn();
  } finally {
    delete ACCOUNTS[ACCT2];
    delete CLOSERS[CLOSER_A2.email];
    scheduler.__resetDeps();
  }
}

// Ambos closers con opt-in GANADO y su hilo abierto: así el único gate que queda en juego
// es el dry-run de su cuenta, que es lo que estos escenarios miden.
const JID_30X = '111@lid';
const JID_A2 = '222@lid';
const optinsDeAmbos = () => [
  { phone: CLOSER_30X.phone, source: 'self', contactJid: JID_30X },
  { phone: CLOSER_A2.phone, source: 'self', contactJid: JID_A2 },
];

// ─── Dry-run por cuenta ───────────────────────────────────────────────────────

test('dry-run por cuenta: 30x envía de verdad y la agencia #2 solo loguea', async () => {
  await withAgencia2(async () => {
    const now = Date.parse('2026-07-16T14:00:00Z');
    const { wa, store } = installHarness(scheduler, {
      nowMs: now,
      accounts: [realAccount(), ACCOUNTS[ACCT2]],
      optins: optinsDeAmbos(),
      events: [
        makeEvent({ uuid: 'e-30x', startInMin: 20, closerEmail: CLOSER_30X.email, nowMs: now, account: '30x' }),
        makeEvent({
          uuid: 'e-a2',
          startInMin: 20,
          closerEmail: CLOSER_A2.email,
          eventType: ET2,
          nowMs: now,
          account: ACCT2,
        }),
      ],
    });

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    // Ambos pushes se AGENDAN y se consumen (la #2 en dry-run también marca 'sent').
    assert.equal(store._rows.filter((p) => p.push_n === 3).length, 2, 'se agendan los dos Push 3');

    // Pero solo sale al aire el de 30X.
    assert.equal(wa.sent.length, 1, 'solo debería salir UN mensaje real');
    assert.equal(wa.sent[0].to, JID_30X, 'el mensaje real es el del closer de 30X');
    assert.ok(
      !wa.sent.some((m) => m.to === JID_A2),
      'la agencia #2 está en dry-run: no puede salir NADA a su closer'
    );

    scheduler.__resetDeps();
  });
});

test('dry-run por cuenta al revés: la #2 en vivo y 30x muda', async () => {
  await withAgencia2(async () => {
    // Prueba que el gate es de verdad por cuenta y no "30x siempre gana".
    ACCOUNTS[ACCT2].dryRun = () => false;
    const saved = process.env.CALENDLY_DRY_RUN;
    process.env.CALENDLY_DRY_RUN = 'true'; // 30x muda

    const now = Date.parse('2026-07-16T14:00:00Z');
    const { wa } = installHarness(scheduler, {
      nowMs: now,
      accounts: [realAccount(), ACCOUNTS[ACCT2]],
      optins: optinsDeAmbos(),
      events: [
        makeEvent({ uuid: 'e-30x', startInMin: 20, closerEmail: CLOSER_30X.email, nowMs: now, account: '30x' }),
        makeEvent({
          uuid: 'e-a2',
          startInMin: 20,
          closerEmail: CLOSER_A2.email,
          eventType: ET2,
          nowMs: now,
          account: ACCT2,
        }),
      ],
    });

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0].to, JID_A2, 'ahora el único envío real es el de la agencia #2');

    process.env.CALENDLY_DRY_RUN = saved;
    scheduler.__resetDeps();
  });
});

// ─── Aislamiento de errores ───────────────────────────────────────────────────

test('token muerto en la agencia #2 NO tumba el poll de 30x', async () => {
  await withAgencia2(async () => {
    // Antes, con una sola cuenta, un throw al listar abortaba el ciclo entero (return 0).
    // Con dos agencias eso sería: se cae una y la otra deja de recibir pushes en silencio.
    const now = Date.parse('2026-07-16T14:00:00Z');
    const { store, wa } = installHarness(scheduler, {
      nowMs: now,
      accounts: [realAccount(), ACCOUNTS[ACCT2]],
      optins: optinsDeAmbos(),
      api: { throwErrorFor: { [ACCT2]: 'Calendly 401: invalid token' } },
      events: [
        makeEvent({ uuid: 'e-30x', startInMin: 20, closerEmail: CLOSER_30X.email, nowMs: now, account: '30x' }),
      ],
    });

    const nuevos = await scheduler.runCalendlyPoll();

    assert.equal(nuevos, 1, 'la cita de 30X se agenda igual pese al 401 de la otra cuenta');
    assert.equal(store._rows.filter((p) => p.push_n === 3).length, 1);

    // Y al admin le llega el aviso diciendo QUÉ cuenta se cayó (no un 401 anónimo).
    const alerta = wa.sent.find((m) => m.text.includes('rechazó el token'));
    assert.ok(alerta, 'debería alertarse el token muerto');
    assert.ok(alerta.text.includes('Agencia 2'), `la alerta debe nombrar la cuenta: ${alerta.text}`);

    scheduler.__resetDeps();
  });
});

// ─── Aislamiento del CRM (HubSpot) ────────────────────────────────────────────

test('FUGA: un lead de la agencia #2 sin teléfono NUNCA se busca en el HubSpot de 30x', async () => {
  await withAgencia2(async () => {
    // El HubSpot conectado es el de 30X. Si se consultara con el email de un lead ajeno y
    // hubiera match, le meteríamos al closer de la agencia #2 el teléfono de un contacto de
    // 30X → le escribiría a la persona equivocada, y cruzaríamos datos entre clientes.
    const now = Date.parse('2026-07-16T14:00:00Z');
    const consultados = [];
    const { deps } = installHarness(scheduler, {
      nowMs: now,
      accounts: [realAccount(), ACCOUNTS[ACCT2]],
      optins: optinsDeAmbos(),
      events: [
        makeEvent({
          uuid: 'e-30x',
          startInMin: 20,
          closerEmail: CLOSER_30X.email,
          prospectPhone: null, // sin teléfono → dispara el fallback de HubSpot
          prospectEmail: 'lead30x@ejemplo.com',
          nowMs: now,
          account: '30x',
        }),
        makeEvent({
          uuid: 'e-a2',
          startInMin: 20,
          closerEmail: CLOSER_A2.email,
          eventType: ET2,
          prospectPhone: null, // idem, pero de la agencia #2
          prospectEmail: 'lead-agencia2@ejemplo.com',
          nowMs: now,
          account: ACCT2,
        }),
      ],
    });

    deps.hubspotEnabled = () => true;
    deps.getContactPhone = async (email) => {
      consultados.push(email);
      return '+573009999999';
    };
    scheduler.__setDeps(deps);

    await scheduler.runCalendlyPoll();

    assert.deepEqual(
      consultados,
      ['lead30x@ejemplo.com'],
      'solo el lead de 30X puede consultarse en el HubSpot de 30X'
    );
    assert.ok(
      !consultados.includes('lead-agencia2@ejemplo.com'),
      'FUGA CROSS-TENANT: se buscó un lead de otra agencia en el CRM de 30X'
    );

    scheduler.__resetDeps();
  });
});

// ─── Push 4 acotado por cuenta ────────────────────────────────────────────────

test('la agencia #2 no agenda Push 4 (alcance v1: solo pushes precall)', async () => {
  await withAgencia2(async () => {
    // PUSH4_ENABLED default true + allowlist vacía = TODOS. Sin el gate por cuenta, los
    // closers nuevos empezarían a recibir preguntas de outcome apenas hicieran opt-in.
    const now = Date.parse('2026-07-16T14:00:00Z');
    const { store } = installHarness(scheduler, {
      nowMs: now,
      accounts: [realAccount(), ACCOUNTS[ACCT2]],
      optins: optinsDeAmbos(),
      events: [
        makeEvent({ uuid: 'e-30x', startInMin: 20, closerEmail: CLOSER_30X.email, nowMs: now, account: '30x' }),
        makeEvent({
          uuid: 'e-a2',
          startInMin: 20,
          closerEmail: CLOSER_A2.email,
          eventType: ET2,
          nowMs: now,
          account: ACCT2,
        }),
      ],
    });

    await scheduler.runCalendlyPoll();

    const push4 = store._rows.filter((p) => p.push_n === 4);
    assert.equal(push4.length, 1, 'solo 30X agenda Push 4');
    assert.equal(push4[0].closer_email, CLOSER_30X.email);
    assert.ok(
      !push4.some((p) => p.closer_email === CLOSER_A2.email),
      'la agencia #2 no debe registrar outcomes en v1'
    );

    scheduler.__resetDeps();
  });
});
