// test/calendly.lead-form.test.js
// §18.CA — el formulario del anuncio como segunda fuente del teléfono del lead.
// Todo PURO: no toca DB ni red, así que corre en Windows sin compilar better-sqlite3.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFormIndex, formPhonesFor, altPhonesFor, fetchFormIndex } from '../src/calendly/lead-form.js';
import { buildPush3Message } from '../src/calendly/index.js';
import { ACCOUNTS } from '../src/calendly/accounts.js';

// Filas como las devuelve src/sheets/client.js: arreglos de celdas, con el encabezado incluido.
const HOJA = [
  ['¿Cuál es tu nombre completo?', '¿Cuál es tu correo electrónico?', '¿Cuál es tu número de WhatsApp?'],
  ['Gustavo Adolfo Laguna Leal', 'gustavo.laguna21@gmail.com', '+573006018595'],
  ['Paul Laguna Panetta', 'paullagunap@yahoo.com', '+573245478204'],
  ['Ana Sin Teléfono', 'ana@example.com', ''],
];

test('buildFormIndex indexa por email en minúscula e ignora el encabezado y las filas sin teléfono', () => {
  const idx = buildFormIndex(HOJA);
  assert.equal(idx.size, 2);
  assert.deepEqual(formPhonesFor(idx, 'GUSTAVO.LAGUNA21@GMAIL.COM'), ['+573006018595']);
  assert.deepEqual(formPhonesFor(idx, '  paullagunap@yahoo.com  '), ['+573245478204']);
  assert.deepEqual(formPhonesFor(idx, 'ana@example.com'), []);
  assert.deepEqual(formPhonesFor(idx, 'nadie@example.com'), []);
});

test('buildFormIndex acumula teléfonos DISTINTOS del mismo email y deduplica los equivalentes', () => {
  const idx = buildFormIndex([
    ['X', 'dos@example.com', '+573001112222'],
    ['X', 'dos@example.com', '3001112222'], // el mismo, sin prefijo de país → no se duplica
    ['X', 'dos@example.com', '+573009998888'], // otro de verdad → sí entra
  ]);
  assert.deepEqual(formPhonesFor(idx, 'dos@example.com'), ['+573001112222', '+573009998888']);
});

// El caso real que originó esto: un dígito de diferencia, y los dos números son móviles
// colombianos perfectamente válidos. Ningún validador de FORMA lo puede atrapar.
test('altPhonesFor detecta el typo de Gustavo Laguna (un solo dígito de diferencia)', () => {
  const idx = buildFormIndex(HOJA);
  const alt = altPhonesFor('+57 300 3018595', formPhonesFor(idx, 'gustavo.laguna21@gmail.com'));
  assert.deepEqual(alt, ['+573006018595']);
});

test('altPhonesFor NO alarma cuando el número es el mismo escrito distinto (prefijo de país, espacios)', () => {
  assert.deepEqual(altPhonesFor('+57 300 601 8595', ['+573006018595']), []);
  assert.deepEqual(altPhonesFor('3006018595', ['+57 300 6018595']), []);
});

test('altPhonesFor se abstiene sin teléfono de Calendly y sin filas del formulario', () => {
  assert.deepEqual(altPhonesFor(null, ['+573006018595']), []);
  assert.deepEqual(altPhonesFor('+573006018595', []), []);
  assert.deepEqual(altPhonesFor('+573006018595', undefined), []);
});

// Guarda de frontera: las filas vienen de una hoja que el cliente edita a mano.
test('altPhonesFor corta en 2 alternos para que un email sucio no arme un muro', () => {
  const alt = altPhonesFor('+573001112222', ['+573001111111', '+573002222222', '+573003333333']);
  assert.equal(alt.length, 2);
});

// ─── El mensaje al closer ─────────────────────────────────────────────────────

test('el push con DOS números abre nombrando al lead y lleva los dos links rotulados', () => {
  const msg = buildPush3Message({
    name: 'Gustavo Laguna',
    firstName: 'Gustavo',
    phone: '+57 300 3018595',
    startIso: '2026-09-16T13:30:00Z',
    programKey: 'comunicarte',
    closer: 'Maru',
    linkLlamada: 'https://meet.google.com/abc',
    altPhones: ['+573006018595'],
  });
  // El aviso va en la PRIMERA línea y con el nombre: el closer sabe de quién es antes de nada.
  const primera = msg.split('\n')[0];
  assert.match(primera, /OJO/);
  assert.match(primera, /Gustavo Laguna/);
  assert.match(primera, /DOS números distintos/);
  // Los dos links, cada uno rotulado por su fuente.
  assert.match(msg, /📞 Calendly: \+57 300 3018595/);
  assert.match(msg, /📞 Formulario: \+573006018595/);
  assert.match(msg, /wa\.me\/573003018595\?text=/);
  assert.match(msg, /wa\.me\/573006018595\?text=/);
  // Y le dice qué hacer con la duda.
  assert.match(msg, /hoja/);
});

test('sin alternos el push sale IDÉNTICO al de antes del cambio (la rama vieja no se toca)', () => {
  const args = {
    name: 'Ana Gómez',
    firstName: 'Ana',
    phone: '+573001112222',
    startIso: '2026-06-10T20:30:00Z',
    programKey: 'abogados',
    closer: 'Sebastian',
    linkLlamada: 'https://zoom.us/j/9',
  };
  const sinCampo = buildPush3Message(args);
  const conVacio = buildPush3Message({ ...args, altPhones: [] });
  assert.equal(sinCampo, conVacio);
  assert.match(sinCampo, /^🔔 \*Push 3\*/);
  assert.doesNotMatch(sinCampo, /OJO/);
});

test('un lead sin teléfono en Calendly no puede terminar con la alarma de dos números', () => {
  const msg = buildPush3Message({
    name: 'Ana Gómez',
    phone: null,
    startIso: '2026-06-10T20:30:00Z',
    programKey: 'comunicarte',
    closer: 'Maru',
    altPhones: ['+573006018595'],
  });
  assert.match(msg, /mándalo manual/);
  assert.doesNotMatch(msg, /OJO/);
});

// ─── El interruptor: qué conexiones hacen el cruce ────────────────────────────
// Esta prueba es la que impide que el cambio se derrame a 30X. Si alguien le agrega `leadForm`
// a la conexión de 30X, sus leads empezarían a compararse contra una hoja de Retia.
test('SOLO las dos conexiones de Retia declaran formulario; 30X y EstadoX no', () => {
  const conForm = Object.values(ACCOUNTS).filter((a) => a.leadForm).map((a) => a.key).sort();
  assert.deepEqual(conForm, ['comunicarte', 'retia']);
  for (const key of conForm) {
    assert.equal(ACCOUNTS[key].hubspot, false, `${key}: el cruce por hoja es para las conexiones SIN HubSpot`);
    assert.ok(ACCOUNTS[key].leadForm.id && ACCOUNTS[key].leadForm.tab);
  }
  // Y cada una apunta a SU propia hoja: cruzar un lead contra el formulario del otro programa
  // le pondría al closer el teléfono de un desconocido.
  assert.notEqual(ACCOUNTS.retia.leadForm.id, ACCOUNTS.comunicarte.leadForm.id);
});

// ─── El fallo de la hoja nunca puede tumbar un push ───────────────────────────

test('fetchFormIndex devuelve null (no lanza) si la hoja falla, si está vacía o si no hay leadForm', async () => {
  const cuenta = { key: 'retia', leadForm: { id: 'x', tab: 'y' } };
  const revienta = async () => { throw new Error('403 sin permiso'); };
  assert.equal(await fetchFormIndex(cuenta, { fetchSheetValues: revienta }), null);
  assert.equal(await fetchFormIndex(cuenta, { fetchSheetValues: async () => [] }), null);
  assert.equal(await fetchFormIndex({ key: '30x' }, { fetchSheetValues: async () => HOJA }), null);
  assert.equal(await fetchFormIndex(cuenta, {}), null);
  // Y en el camino feliz sí indexa.
  const idx = await fetchFormIndex(cuenta, { fetchSheetValues: async () => HOJA });
  assert.equal(idx.size, 2);
});
