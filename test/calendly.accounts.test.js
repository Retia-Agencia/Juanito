// test/calendly.accounts.test.js
// Registro de cuentas de Calendly (multi-empresa). Fija dos clases de invariantes:
//
//   1. RETRO-COMPAT: mover los event_types a accounts.js no puede cambiar nada de lo que
//      ya funcionaba — si un ET se cae del registro, Juanito deja de ver esas llamadas EN
//      SILENCIO (nadie se entera hasta que un closer reclama).
//   2. AISLAMIENTO: una cuenta no puede alcanzar los recursos de otra.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ACCOUNTS, DEFAULT_ACCOUNT, accountOf, accountOfProgram, activeAccounts, eventTypeToProgram } =
  await import('../src/calendly/accounts.js');
const { programKeyOf, PROGRAM_EVENT_TYPES } = await import('../src/calendly/index.js');

// Guarda/restaura env alrededor de un caso (mismo idioma que test/roles.test.js).
function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── Retro-compat: los programas de 30X siguen resolviendo ────────────────────

// Eran 6 hasta el 2026-08-25, cuando `abogados` se mudó al Calendly propio de EstadoX. Los otros
// 5 no se tocaron: el punto de este test es que mover UN programa de conexión no arrastre a los
// demás (los eventTypes de cada conexión se DERIVAN de programs.js, así que un error de tipeo en
// la `connection` de uno los sacaría a todos del mapa de 30x sin ningún error).
test('los 5 programas que quedan en la cuenta 30x siguen mapeando a su programKey', () => {
  const esperados = [
    'second_brain',
    'linkedin',
    'developers',
    'operaciones',
    'instagram',
  ];
  const programas = Object.values(ACCOUNTS['30x'].eventTypes);
  assert.deepEqual(programas.sort(), [...esperados].sort());

  // Y cada ET resuelve por programKeyOf, que es lo que usa el resto del código.
  for (const [et, prog] of Object.entries(ACCOUNTS['30x'].eventTypes)) {
    assert.equal(programKeyOf(et), prog, `el ET de ${prog} no resuelve`);
    assert.equal(programKeyOf({ event_type: et }), prog, `${prog} no resuelve desde el evento`);
  }
});

test('PROGRAM_EVENT_TYPES sale del registro y trae los ETs de TODAS las cuentas', () => {
  const ets = PROGRAM_EVENT_TYPES();
  // Unión de los ETs de cada cuenta (30x: 5; estadox: 1; retia: 1). Derivado del registro para
  // que sumar un programa/cuenta no requiera tocar este número a mano.
  const all = Object.values(ACCOUNTS).flatMap((a) => Object.keys(a.eventTypes));
  assert.equal(ets.length, all.length);
  assert.deepEqual([...ets].sort(), all.sort());
});

test('un event_type desconocido no resuelve a ningún programa', () => {
  // Importa: sin esto, una cita de un programa NO gestionado heredaría el copy de otro.
  assert.equal(programKeyOf('https://api.calendly.com/event_types/no-existe'), null);
  assert.equal(programKeyOf(undefined), null);
  assert.equal(programKeyOf({}), null);
});

test('la cuenta default existe y es 30x', () => {
  assert.equal(DEFAULT_ACCOUNT, '30x');
  assert.ok(accountOf(DEFAULT_ACCOUNT), 'la cuenta default tiene que existir en el registro');
  assert.equal(accountOf('no-existe'), null);
});

// ─── Auto-desactivación por token ─────────────────────────────────────────────

test('activeAccounts filtra por token presente (auto-desactivación)', () => {
  // Se apagan explícitamente los tokens de las OTRAS conexiones: si quedaran colgados del
  // entorno real, este test pasaría o fallaría según la máquina donde corre.
  withEnv({ CALENDLY_TOKEN: 'tok-30x', CALENDLY_TOKEN_ESTADOX: undefined, CALENDLY_TOKEN_RETIA: undefined }, () => {
    assert.deepEqual(
      activeAccounts().map((a) => a.key),
      ['30x']
    );
  });
  // Sin token, la cuenta no existe → los jobs no arrancan y Juanito se comporta como si
  // Calendly nunca se hubiera configurado.
  withEnv({ CALENDLY_TOKEN: undefined, CALENDLY_TOKEN_ESTADOX: undefined, CALENDLY_TOKEN_RETIA: undefined }, () => {
    assert.deepEqual(activeAccounts(), []);
  });
});

// ─── accountOfProgram ─────────────────────────────────────────────────────────

test('accountOfProgram ubica la cuenta dueña de cada programa', () => {
  assert.equal(accountOfProgram('second_brain').key, '30x');
  // abogados se mudó al Calendly propio de EstadoX el 2026-08-25 (antes era '30x').
  assert.equal(accountOfProgram('abogados').key, 'estadox');
  assert.equal(accountOfProgram('instagram').key, '30x');
  // Un programa que no es de nadie → null (el caller decide; nunca asume una cuenta).
  assert.equal(accountOfProgram('programa_fantasma'), null);
  assert.equal(accountOfProgram(null), null);
});

test('eventTypeToProgram aplana todas las cuentas sin colisionar', () => {
  const plano = eventTypeToProgram();
  const totalPorCuenta = Object.values(ACCOUNTS).reduce(
    (n, a) => n + Object.keys(a.eventTypes).length,
    0
  );
  // Si dos cuentas declararan el mismo ET, el aplanado perdería una → el conteo lo delata.
  assert.equal(Object.keys(plano).length, totalPorCuenta, 'hay event_types duplicados entre cuentas');
});

// ─── Contrato del registro ────────────────────────────────────────────────────

test('toda cuenta del registro cumple el contrato estructural', () => {
  for (const [key, a] of Object.entries(ACCOUNTS)) {
    assert.equal(a.key, key, `${key}: la key interna no coincide con la del mapa`);
    for (const fn of ['token', 'orgUri', 'dryRun', 'push4']) {
      assert.equal(typeof a[fn], 'function', `${key}.${fn} debe ser función (se lee en caliente)`);
    }
    assert.equal(typeof a.hubspot, 'boolean', `${key}.hubspot debe ser booleano`);
    assert.equal(typeof a.label, 'string', `${key}.label debe ser string (sale en las alertas al admin)`);
  }
});

test('una cuenta CON token está completamente configurada', () => {
  // Una cuenta staged (sin token) puede tener orgUri/eventTypes vacíos: está inerte, no la
  // ve activeAccounts(). Pero apenas alguien le pone el token, entra al poll — y ahí sí
  // tiene que estar completa, o pollearía una org vacía y no agendaría nada EN SILENCIO.
  for (const a of activeAccounts()) {
    assert.ok(
      a.orgUri().startsWith('https://api.calendly.com/organizations/'),
      `${a.key}: tiene token pero su orgUri es inválida ("${a.orgUri()}")`
    );
    assert.ok(
      Object.keys(a.eventTypes).length > 0,
      `${a.key}: tiene token pero no declara event_types → no vería ninguna cita`
    );
  }
});

test('las cuentas staged (sin token) están inertes', () => {
  withEnv({ CALENDLY_TOKEN: 'tok-30x', CALENDLY_TOKEN_ESTADOX: undefined, CALENDLY_TOKEN_RETIA: undefined }, () => {
    const activas = activeAccounts().map((a) => a.key);
    assert.ok(!activas.includes('retia'), 'retia no debe estar activa sin su token');
    assert.ok(!activas.includes('estadox'), 'estadox no debe estar activa sin su token');
    assert.deepEqual(activas, ['30x']);
  });
});

test('dryRun de 30x respeta CALENDLY_DRY_RUN y su default seguro', () => {
  const a = accountOf('30x');
  // Default true = no envía. Es el default seguro histórico.
  withEnv({ CALENDLY_DRY_RUN: undefined }, () => assert.equal(a.dryRun(), true));
  withEnv({ CALENDLY_DRY_RUN: 'true' }, () => assert.equal(a.dryRun(), true));
  // Solo el literal 'false' habilita el envío real (así está en prod).
  withEnv({ CALENDLY_DRY_RUN: 'false' }, () => assert.equal(a.dryRun(), false));
});
