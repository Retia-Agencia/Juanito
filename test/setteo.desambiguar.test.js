// test/setteo.desambiguar.test.js
// Elegir entre homónimos de HubSpot (§18.BC). Puro: corre en Windows.
//
// El caso NO es hipotético. Medido el 2026-08-04 sobre 30 leads reales de Registrado/
// Calificado: 19 devolvían varios candidatos ("Santiago Moreno" → 7). Sin desambiguar, el
// cruce acertaba el 37%.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { elegirContacto } = await import('../src/setteo/desambiguar.js');

const SETTEABLES = new Set(['registrado', 'calificado']);
const c = (id) => ({ id, properties: {} });

test('un solo candidato → se elige, sin mirar nada más', () => {
  const r = elegirContacto({ candidatos: [c('1')], etapasSetteables: SETTEABLES });
  assert.deepEqual(r, { id: '1', via: 'unico' });
});

test('sin candidatos → null', () => {
  assert.equal(elegirContacto({ candidatos: [], etapasSetteables: SETTEABLES }), null);
  assert.equal(elegirContacto({}), null);
});

test('homónimos: gana el que tiene un deal en etapa de SETTEO', () => {
  // El caso de la mayoría (16 de los 19 ambiguos reales). El otro homónimo existe pero su
  // deal ya está agendado/ganado: no es a quien el closer está persiguiendo.
  const r = elegirContacto({
    candidatos: [c('viejo'), c('vivo')],
    dealsPorContacto: new Map([
      ['viejo', [{ dealstage: 'ganado', ownerId: '9' }]],
      ['vivo', [{ dealstage: 'calificado', ownerId: '9' }]],
    ]),
    etapasSetteables: SETTEABLES,
  });
  assert.deepEqual(r, { id: 'vivo', via: 'etapa' });
});

test('si DOS están en etapa de setteo, desempata el owner del closer que reporta', () => {
  // Los 3 restantes de los 19. Dos personas distintas con el mismo nombre, ambas activas:
  // la que cuenta es la del closer que está escribiendo.
  const r = elegirContacto({
    candidatos: [c('deOtro'), c('mio')],
    dealsPorContacto: new Map([
      ['deOtro', [{ dealstage: 'registrado', ownerId: '111' }]],
      ['mio', [{ dealstage: 'registrado', ownerId: '222' }]],
    ]),
    etapasSetteables: SETTEABLES,
    ownerId: '222',
  });
  assert.deepEqual(r, { id: 'mio', via: 'owner' });
});

test('dos en etapa de setteo y SIN owner resuelto → null, no se adivina', () => {
  // Sin ownerId (HubSpot a medias, closer sin owner mapeado) preferimos el ⚠️ antes que
  // atribuirle la gestión al homónimo equivocado: eso ensucia el conteo de DOS personas.
  const r = elegirContacto({
    candidatos: [c('a'), c('b')],
    dealsPorContacto: new Map([
      ['a', [{ dealstage: 'registrado', ownerId: '111' }]],
      ['b', [{ dealstage: 'registrado', ownerId: '222' }]],
    ]),
    etapasSetteables: SETTEABLES,
    ownerId: null,
  });
  assert.equal(r, null);
});

test('dos en etapa de setteo y AMBOS del mismo owner → null', () => {
  // Duplicados del mismo lead, los dos suyos: no hay criterio para elegir y da igual cuál,
  // pero elegir mal rompería el `hubspot_contact_id`. Se muestra el ⚠️.
  const r = elegirContacto({
    candidatos: [c('a'), c('b')],
    dealsPorContacto: new Map([
      ['a', [{ dealstage: 'registrado', ownerId: '222' }]],
      ['b', [{ dealstage: 'calificado', ownerId: '222' }]],
    ]),
    etapasSetteables: SETTEABLES,
    ownerId: '222',
  });
  assert.equal(r, null);
});

test('ninguno en etapa de setteo → null aunque uno sea del closer', () => {
  // Si NADIE está en Registrado/Calificado, lo más probable es que el closer se refiera a
  // alguien que no tenemos bien identificado. El owner solo desempata DENTRO de los que sí.
  const r = elegirContacto({
    candidatos: [c('a'), c('b')],
    dealsPorContacto: new Map([
      ['a', [{ dealstage: 'agendado', ownerId: '222' }]],
      ['b', [{ dealstage: 'ganado', ownerId: '999' }]],
    ]),
    etapasSetteables: SETTEABLES,
    ownerId: '222',
  });
  assert.equal(r, null);
});

test('un candidato sin deals no estorba al que sí los tiene', () => {
  // Contacto huérfano (creado por un formulario, sin negocio). Es la mitad del problema de
  // duplicados de este CRM.
  const r = elegirContacto({
    candidatos: [c('huerfano'), c('conDeal')],
    dealsPorContacto: new Map([['conDeal', [{ dealstage: 'registrado', ownerId: '5' }]]]),
    etapasSetteables: SETTEABLES,
  });
  assert.deepEqual(r, { id: 'conDeal', via: 'etapa' });
});

test('los ids se comparan como STRING (HubSpot los devuelve mezclados)', () => {
  // Las asociaciones vienen con `toObjectId` numérico y los contactos con `id` string. Sin
  // normalizar, el Map no encuentra nada y todo cae a ambiguo en silencio.
  const r = elegirContacto({
    candidatos: [{ id: 55484607148 }, { id: 199211698494 }],
    dealsPorContacto: new Map([['199211698494', [{ dealstage: 'calificado', ownerId: 7 }]]]),
    etapasSetteables: SETTEABLES,
    ownerId: 7,
  });
  assert.deepEqual(r, { id: '199211698494', via: 'etapa' });
});
