// test/calendly.dev-mirror.test.js
// Espejo de dev (§18.BM): copia a un JID de dev de todo lo que `deliver()` resuelve para los
// closers de ciertas Conexiones, CON el resultado en el encabezado.
//
// Lo que protege este archivo es una idea sola: el espejo existe para ver los pushes que NO
// SALEN. Un espejo que se callara junto con el dry-run, con el skip de opt-in o con la pausa
// por-closer mostraría exactamente los casos que ya se ven en el log y ninguno de los que
// costaron un mes (EstadoX) o una semana (Salazar) de silencio. Por eso los tests de abajo
// miden sobre todo los caminos donde el closer no recibe nada.
//
// La ÚNICA excepción es la pausa GLOBAL: el botón de pánico significa silencio total.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.CALENDLY_REQUIRE_OPTIN = 'true';
process.env.CALENDLY_DRY_RUN = 'false'; // la cuenta 30x va EN VIVO, como en producción
process.env.ADMIN_LID = '129446371655733@lid';

const scheduler = await import('../src/scheduler/calendly.js');
const { installHarness, makeEvent, makeAccount, realAccount } = await import(
  './helpers/calendly-harness.js'
);
const { CLOSERS, resolveCloserByLid } = await import('../src/calendly/closers.js');
const { ACCOUNTS } = await import('../src/calendly/accounts.js');
const { __resetHealth } = await import('../src/calendly/health.js');

const ACCT2 = 'agencia_espejo';
const ET2 = 'https://api.calendly.com/event_types/bbbb2222-3333-4444-5555-666677778888';
const CLOSER_30X = { email: 'pablo.lozano@30x.com', phone: CLOSERS['pablo.lozano@30x.com'].phone };
const CLOSER_A2 = { email: 'closer@agencia-espejo.com', name: 'Ana Espejo', phone: '+573001234567' };

const JID_30X = '111@lid';
const JID_A2 = '222@lid';
const JID_DEV = '999@lid';

// Registra la conexión #2 y su closer en los registros REALES, y los quita al terminar
// (mismo patrón que calendly.multi-account.test.js). `dryRun` se pasa por parámetro porque
// justamente el caso interesante es la conexión MUDA.
async function withAgencia({ dryRun = false } = {}, fn) {
  ACCOUNTS[ACCT2] = makeAccount({
    key: ACCT2,
    label: 'Agencia Espejo',
    eventTypes: { [ET2]: 'programa_espejo' },
    dryRun,
    push4: false,
    hubspot: false,
  });
  CLOSERS[CLOSER_A2.email] = { name: CLOSER_A2.name, phone: CLOSER_A2.phone, account: ACCT2 };
  __resetHealth();
  const savedJid = process.env.CALENDLY_DEV_MIRROR_JID;
  const savedConns = process.env.CALENDLY_DEV_MIRROR_CONNECTIONS;
  try {
    return await fn();
  } finally {
    delete ACCOUNTS[ACCT2];
    delete CLOSERS[CLOSER_A2.email];
    if (savedJid === undefined) delete process.env.CALENDLY_DEV_MIRROR_JID;
    else process.env.CALENDLY_DEV_MIRROR_JID = savedJid;
    if (savedConns === undefined) delete process.env.CALENDLY_DEV_MIRROR_CONNECTIONS;
    else process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = savedConns;
    scheduler.__resetDeps();
  }
}

// Un Push 3 de la conexión #2, listo para entregar.
function escenario({ nowMs, optins }) {
  return installHarness(scheduler, {
    nowMs,
    accounts: [realAccount(), ACCOUNTS[ACCT2]],
    optins,
    events: [
      makeEvent({
        uuid: 'e-a2',
        startInMin: 20,
        closerEmail: CLOSER_A2.email,
        eventType: ET2,
        nowMs,
        account: ACCT2,
      }),
    ],
  });
}

const optinCompleto = () => [{ phone: CLOSER_A2.phone, source: 'self', contactJid: JID_A2 }];
const NOW = Date.parse('2026-08-25T14:00:00Z');
const copias = (wa) => wa.sent.filter((m) => m.to === JID_DEV);

// ─── Apagado por default ──────────────────────────────────────────────────────

test('sin CALENDLY_DEV_MIRROR_JID el espejo no existe', async () => {
  await withAgencia({}, async () => {
    delete process.env.CALENDLY_DEV_MIRROR_JID;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = ACCT2;
    const { wa } = escenario({ nowMs: NOW, optins: optinCompleto() });

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    assert.equal(wa.sent.length, 1, 'solo el push al closer');
    assert.equal(wa.sent[0].to, JID_A2);
  });
});

test('con JID pero SIN conexiones declaradas no copia nada', async () => {
  // Vacío = ninguna, nunca "todas": poner el JID sin querer no puede terminar en el dev
  // recibiendo los pushes —con nombres y teléfonos de leads— de las cuatro conexiones.
  await withAgencia({}, async () => {
    process.env.CALENDLY_DEV_MIRROR_JID = JID_DEV;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = '';
    const { wa } = escenario({ nowMs: NOW, optins: optinCompleto() });

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    assert.equal(copias(wa).length, 0);
  });
});

test('una conexión que no está en la lista no se espeja', async () => {
  await withAgencia({}, async () => {
    process.env.CALENDLY_DEV_MIRROR_JID = JID_DEV;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = 'otra_conexion';
    const { wa } = escenario({ nowMs: NOW, optins: optinCompleto() });

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    assert.equal(copias(wa).length, 0, 'el alcance es por conexión, no "todo lo que pase"');
    assert.equal(wa.sent.filter((m) => m.to === JID_A2).length, 1, 'el push real sí sale');
  });
});

// ─── El caso normal ───────────────────────────────────────────────────────────

test('conexión espejada y en vivo: el closer recibe su push y el dev una copia con resultado sent', async () => {
  await withAgencia({}, async () => {
    process.env.CALENDLY_DEV_MIRROR_JID = JID_DEV;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = `${ACCT2},retia`;
    const { wa } = escenario({ nowMs: NOW, optins: optinCompleto() });

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    const alCloser = wa.sent.filter((m) => m.to === JID_A2);
    assert.equal(alCloser.length, 1, 'el push real al closer no cambia');

    const c = copias(wa);
    assert.equal(c.length, 1);
    assert.match(c[0].text, /espejo dev/);
    assert.match(c[0].text, /resultado: \*sent\*/);
    assert.match(c[0].text, /Ana Espejo/, 'la copia dice de qué closer es');
    assert.ok(
      c[0].text.includes(alCloser[0].text),
      'la copia lleva el mensaje ÍNTEGRO que recibió el closer, link wa.me incluido'
    );
  });
});

// ─── Los caminos MUDOS, que son la razón de ser del espejo ────────────────────

test('conexión en DRY-RUN: al closer no le llega nada, al dev sí (resultado dry-run)', async () => {
  await withAgencia({ dryRun: true }, async () => {
    process.env.CALENDLY_DEV_MIRROR_JID = JID_DEV;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = ACCT2;
    const { wa } = escenario({ nowMs: NOW, optins: optinCompleto() });

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    assert.equal(
      wa.sent.filter((m) => m.to === JID_A2).length,
      0,
      'el dry-run sigue siendo mudo para el closer'
    );
    const c = copias(wa);
    assert.equal(c.length, 1, 'pero el dev SÍ ve lo que se habría mandado');
    assert.match(c[0].text, /resultado: \*dry-run\*/);
  });
});

test('closer SIN opt-in: el push se omite y el espejo lo hace visible', async () => {
  // Este es el modo de falla que costó un mes en EstadoX y una semana con equipo@ttrading.co:
  // el push no sale y NADIE se entera, porque el único que podría reportarlo es el closer que
  // no lo recibe.
  await withAgencia({}, async () => {
    process.env.CALENDLY_DEV_MIRROR_JID = JID_DEV;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = ACCT2;
    const { wa } = escenario({ nowMs: NOW, optins: [] }); // nadie escribió a Juanito

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    assert.equal(wa.sent.filter((m) => m.to === JID_A2).length, 0);
    const c = copias(wa);
    assert.equal(c.length, 1);
    assert.match(c[0].text, /resultado: \*skipped-optin\*/);
  });
});

test('opt-in sin hilo (contact_jid null): el espejo reporta skipped-no-thread', async () => {
  await withAgencia({}, async () => {
    process.env.CALENDLY_DEV_MIRROR_JID = JID_DEV;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = ACCT2;
    const { wa } = escenario({
      nowMs: NOW,
      optins: [{ phone: CLOSER_A2.phone, source: 'self', contactJid: null }],
    });

    await scheduler.runCalendlyPoll();
    await scheduler.runCalendlyDelivery();

    const c = copias(wa);
    assert.equal(c.length, 1);
    assert.match(c[0].text, /resultado: \*skipped-no-thread\*/);
  });
});

// ─── El botón de pánico gana ──────────────────────────────────────────────────

test('la pausa GLOBAL también calla el espejo', async () => {
  await withAgencia({}, async () => {
    process.env.CALENDLY_DEV_MIRROR_JID = JID_DEV;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = ACCT2;
    const { wa, store } = escenario({ nowMs: NOW, optins: optinCompleto() });

    await scheduler.runCalendlyPoll();
    store.setCalendlyPaused(true); // `/calendly off` — silencio TOTAL
    await scheduler.runCalendlyDelivery();

    assert.equal(wa.sent.length, 0, 'ni al closer ni al dev: el pánico es silencio total');
  });
});

// ─── Por qué es un env y no un extraJid del roster ────────────────────────────

test('el JID del espejo NO queda reconocido como closer', async () => {
  // Un `extraJids` habría metido este JID en CLOSER_LIDS: el dev pasaría a resolverse COMO ese
  // closer al escribirle a Juanito (su rol, su opt-in, su contexto agéntico). Además el roster
  // prohíbe repetir un JID entre identidades, así que un solo dev no podría espejar a los cinco
  // closers de dos conexiones. El espejo es un destino, no una identidad.
  await withAgencia({}, async () => {
    process.env.CALENDLY_DEV_MIRROR_JID = JID_DEV;
    process.env.CALENDLY_DEV_MIRROR_CONNECTIONS = ACCT2;
    assert.equal(resolveCloserByLid(JID_DEV), null);
    assert.equal(resolveCloserByLid('999'), null);
  });
});
