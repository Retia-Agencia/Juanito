// test/setteo.commands.test.js
// Comandos del closer (§18.AZ): /missetteos y /nuevosetteo. Sin red ni DB → corren en Windows
// (commands.js no importa deps nativas; todo lo pesado se inyecta).
//
// Lo que estos tests protegen sobre todo es el AISLAMIENTO: un closer solo puede ver y
// registrar LO SUYO, y la identidad sale de su JID, nunca de lo que escriba.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { handleCommand } = await import('../src/bot/commands.js');
const { formatMisSetteos, formatMisSetteosVacio, formatListaSetteos, estadoDeSetteo } =
  await import('../src/setteo/format.js');

// Identidades reales del roster (calendly/closers.js).
const SEBAS_LID = '158025419608301@lid';   // sebastian@30x.com
const PABLO_JID = '573046131437@s.whatsapp.net'; // pablo.lozano@30x.com
const AJENO = '999999999999999@lid';

const okDeps = (spy = {}) => ({
  buildMisSetteos: async (args) => {
    spy.misSetteos = args;
    return 'MÉTRICAS';
  },
  guardarSetteos: async (args) => {
    spy.guardar = args;
    return { guardados: args.items.length, calls: 0, ambiguos: 0, sinMatch: 0, nombres: [] };
  },
});

// ─── Aislamiento ──────────────────────────────────────────────────────────────

test('/missetteos: quien no es closer no entra', async () => {
  const out = await handleCommand({ text: '/missetteos', sender: AJENO, role: 'unknown' }, okDeps());
  assert.match(out, /para los closers/);
});

test('/missetteos: la identidad sale del JID, no del texto', async () => {
  const spy = {};
  // Aunque escriba el nombre de OTRO closer, el comando resuelve por su propio JID.
  await handleCommand({ text: '/missetteos Pablo Lozano', sender: SEBAS_LID, role: 'closer' }, okDeps(spy));
  assert.equal(spy.misSetteos.closer.email, 'sebastian@30x.com');
});

test('/missetteos: cada closer resuelve a lo suyo', async () => {
  const a = {};
  const b = {};
  await handleCommand({ text: '/missetteos', sender: SEBAS_LID, role: 'closer' }, okDeps(a));
  await handleCommand({ text: '/missetteos', sender: PABLO_JID, role: 'closer' }, okDeps(b));
  assert.equal(a.misSetteos.closer.email, 'sebastian@30x.com');
  assert.equal(b.misSetteos.closer.email, 'pablo.lozano@30x.com');
});

test('/missetteos: ventana por defecto 1 día, con argumento la respeta y la topea', async () => {
  const spy = {};
  await handleCommand({ text: '/missetteos', sender: SEBAS_LID, role: 'closer' }, okDeps(spy));
  assert.equal(spy.misSetteos.dias, 1);
  await handleCommand({ text: '/missetteos 7', sender: SEBAS_LID, role: 'closer' }, okDeps(spy));
  assert.equal(spy.misSetteos.dias, 7);
  await handleCommand({ text: '/missetteos 9999', sender: SEBAS_LID, role: 'closer' }, okDeps(spy));
  assert.equal(spy.misSetteos.dias, 90, 'una ventana absurda se topea');
});

test('/missetteos: si el builder falla, el closer recibe un aviso, no un stacktrace', async () => {
  const out = await handleCommand(
    { text: '/missetteos', sender: SEBAS_LID, role: 'closer' },
    { buildMisSetteos: async () => { throw new Error('HubSpot 500'); } }
  );
  assert.match(out, /No pude armar tus métricas/);
  assert.doesNotMatch(out, /HubSpot 500/, 'no filtra el error interno');
});

// ─── /nuevosetteo ─────────────────────────────────────────────────────────────

test('/nuevosetteo sin texto muestra el formato en vez de fallar', async () => {
  const out = await handleCommand({ text: '/nuevosetteo', sender: SEBAS_LID, role: 'closer' }, okDeps());
  assert.match(out, /Registrar setteo/);
  assert.match(out, /toqué a Juan Pérez/);
});

test('/nuevosetteo guarda lo parseado, con el closer del JID', async () => {
  const spy = {};
  const out = await handleCommand(
    { text: '/nuevosetteo toqué a Juan Pérez y María Gómez, María agendó', sender: SEBAS_LID, role: 'closer' },
    okDeps(spy)
  );
  assert.equal(spy.guardar.closer.email, 'sebastian@30x.com');
  assert.equal(spy.guardar.items.length, 2);
  assert.equal(spy.guardar.source, 'comando');
  assert.equal(spy.guardar.items.find((i) => i.leadNorm === 'maria gomez').agendo, 1);
  assert.match(out, /Anotado/);
});

test('/nuevosetteo con cantidades pero sin nombres pide los nombres', async () => {
  const out = await handleCommand(
    { text: '/nuevosetteo hoy toqué 20 leads, 3 agendaron', sender: SEBAS_LID, role: 'closer' },
    okDeps()
  );
  assert.match(out, /nombres/);
  assert.match(out, /\*20\*/);
});

test('/nuevosetteo que no se entiende NO inventa un lead', async () => {
  const spy = {};
  const out = await handleCommand(
    { text: '/nuevosetteo asdfgh qwerty', sender: SEBAS_LID, role: 'closer' },
    { ...okDeps(spy), parseSetteoWithAi: async () => ({ kind: 'none' }) }
  );
  assert.equal(spy.guardar, undefined, 'no debe guardar nada');
  assert.match(out, /No logré entender/);
});

test('/nuevosetteo: quien no es closer no entra', async () => {
  const out = await handleCommand({ text: '/nuevosetteo Juan Pérez', sender: AJENO, role: 'unknown' }, okDeps());
  assert.match(out, /para los closers/);
});

// El /setteos del jefe NO puede quedar accesible a un closer: es el consolidado de todos.
test('/setteos (el del jefe) sigue cerrado para un closer', async () => {
  const out = await handleCommand({ text: '/setteos', sender: SEBAS_LID, role: 'closer' }, okDeps());
  assert.match(out, /solo para el jefe o el equipo/);
});

test('/help del closer muestra lo suyo y nada del jefe', async () => {
  const out = await handleCommand({ text: '/help', sender: SEBAS_LID, role: 'closer' });
  assert.match(out, /missetteos/);
  assert.doesNotMatch(out, /reportejefe|\/status|\/grupos/);
});

// ─── Formato de las tres cifras ───────────────────────────────────────────────

const reportado = (over = {}) => ({
  total: 24, contestaron: 11, agendaron: 4, vendieron: 1, ambiguos: 0, eranCall: 0,
  tasaRespuesta: 11 / 24, tasaSetteo: 4 / 11, ...over,
});
const cuota = (over = {}) => ({ horasJornada: 9, horasOcupadas: 6, horasLibres: 3, cuota: 45, callsEnJornada: 6, callsFuera: 0, ...over });

test('formato: singular y plural del desglose', () => {
  const uno = formatMisSetteos({
    closerName: 'S', dateLabel: 'hoy',
    reportado: reportado({ total: 5, contestaron: 1, agendaron: 1, vendieron: 1, tasaSetteo: 1 }),
    hubspot: 5, cuota: cuota(),
  });
  assert.match(uno, /1 contestó · 1 agendó · 1 venta/);
  const varios = formatMisSetteos({ closerName: 'S', dateLabel: 'hoy', reportado: reportado({ vendieron: 2 }), hubspot: 24, cuota: cuota() });
  assert.match(varios, /11 contestaron · 4 agendaron · 2 ventas/);
});

test('formato: las tres cifras y la brecha', () => {
  const msg = formatMisSetteos({ closerName: 'Sebas', dateLabel: 'mié 6 ago', reportado: reportado(), hubspot: 9, cuota: cuota() });
  assert.match(msg, /Reportados a mí\s+24/);
  assert.match(msg, /Registrados en HubSpot\s+9/);
  assert.match(msg, /faltan 15/);
  assert.match(msg, /Cuota.*45/s);
  assert.match(msg, /3h libres × 15/);
  assert.match(msg, /15 setteos que me contaste no están/);
  assert.match(msg, /no cuentan para comisión/);
});

// Un cero falso le haría creer al closer que no registró nada en el CRM.
test('formato: HubSpot caído muestra "—", NUNCA un cero', () => {
  const msg = formatMisSetteos({ closerName: 'S', dateLabel: 'hoy', reportado: reportado(), hubspot: null, cuota: cuota() });
  assert.match(msg, /Registrados en HubSpot\s+—/);
  assert.match(msg, /no pude consultarlo/);
  assert.doesNotMatch(msg, /faltan/);
  assert.doesNotMatch(msg, /no cuentan para comisión/);
});

test('formato: sin brecha no hay advertencia', () => {
  const msg = formatMisSetteos({ closerName: 'S', dateLabel: 'hoy', reportado: reportado({ total: 9 }), hubspot: 9, cuota: cuota() });
  assert.doesNotMatch(msg, /faltan|no cuentan para comisión/);
});

// Con n chico, "100%" es ruido presentado como dato — el error del prototipo HTML.
test('formato: la tasa de setteo se omite con muestras chicas', () => {
  const chico = formatMisSetteos({
    closerName: 'S', dateLabel: 'hoy',
    reportado: reportado({ total: 1, contestaron: 1, agendaron: 1, tasaSetteo: 1 }),
    hubspot: 1, cuota: cuota(),
  });
  assert.doesNotMatch(chico, /agendás el/, 'con 1 contestado no se puede afirmar una tasa');

  const grande = formatMisSetteos({ closerName: 'S', dateLabel: 'hoy', reportado: reportado(), hubspot: 9, cuota: cuota() });
  assert.match(grande, /agendás el 36%/);
});

test('formato: avisa los leads que ya eran call y los homónimos', () => {
  const msg = formatMisSetteos({
    closerName: 'S', dateLabel: 'hoy',
    reportado: reportado({ eranCall: 2, ambiguos: 1 }), hubspot: 9, cuota: cuota(),
  });
  assert.match(msg, /2 leads ya tenían cita/);
  assert.match(msg, /1 con homónimos/);
});

test('formato: calls fuera de jornada se explican (para que no parezca un error de cuota)', () => {
  const msg = formatMisSetteos({
    closerName: 'S', dateLabel: 'hoy', reportado: reportado(), hubspot: 9, cuota: cuota({ callsFuera: 2 }),
  });
  assert.match(msg, /2 calls cayeron fuera de la jornada/);
});

test('formato vacío: muestra la cuota y cómo reportar', () => {
  const msg = formatMisSetteosVacio({ dateLabel: 'hoy', cuota: cuota() });
  assert.match(msg, /Todavía no me contaste/);
  assert.match(msg, /\*45\*/);
  assert.match(msg, /toqué a Juan Pérez/);
});

// ─── La lista de setteos (a QUIÉNES, no solo cuántos) ─────────────────────────
// El setteómetro —el prototipo del que salió esta feature— tenía la tabla de contactos a la
// vista. Sin la lista, el closer ve el número pero no puede revisar ni corregir lo que no ve.

const fila = (over = {}) => ({
  lead_name: 'Juan Pérez', fecha: '2026-08-06',
  contesto: 1, agendo: 0, vendio: 0, es_call: 0, hubspot_match: 'exact', ...over,
});

test('lista: las cuatro etiquetas del setteómetro salen de los flags acumulativos', () => {
  assert.equal(estadoDeSetteo(fila({ contesto: 0 })), 'no contestó');
  assert.equal(estadoDeSetteo(fila()), 'contestó'); // "en seguimiento" del setteómetro
  assert.equal(estadoDeSetteo(fila({ agendo: 1 })), 'agendó');
  // Quien vendió tiene los tres flags en 1: gana el de más arriba, no se muestra "contestó".
  assert.equal(estadoDeSetteo(fila({ agendo: 1, vendio: 1 })), 'venta');
  // El lead que ya tenía cita se rotula aparte: no cuenta como setteo y hay que poder verlo.
  assert.equal(estadoDeSetteo(fila({ agendo: 1, es_call: 1 })), 'ya tenía cita');
});

test('lista: aparece en /missetteos con nombre y estado', () => {
  const msg = formatMisSetteos({
    closerName: 'S', dateLabel: 'hoy', reportado: reportado(), hubspot: 9, cuota: cuota(),
    filas: [fila(), fila({ lead_name: 'María Gómez', agendo: 1 })],
  });
  assert.match(msg, /Tus setteos:/);
  assert.match(msg, /• Juan Pérez — contestó/);
  assert.match(msg, /• María Gómez — agendó/);
});

test('lista: marca los que no están en HubSpot (es la brecha, lead por lead)', () => {
  const msg = formatMisSetteos({
    closerName: 'S', dateLabel: 'hoy', reportado: reportado(), hubspot: 9, cuota: cuota(),
    filas: [fila({ hubspot_match: 'none' })],
  });
  assert.match(msg, /• Juan Pérez — contestó ⚠️/);
  assert.match(msg, /no lo encontré en HubSpot/);
});

test('lista: se corta para que el mensaje siga siendo leíble en WhatsApp', () => {
  const filas = Array.from({ length: 20 }, (_, i) => fila({ lead_name: `Lead ${i}` }));
  const L = formatListaSetteos(filas, { max: 15 });
  assert.equal(L.filter((l) => l.includes('•')).length, 15);
  assert.ok(L.some((l) => /y 5 más/.test(l)));
});

test('lista: con ventana de varios días cada línea lleva su fecha', () => {
  const L = formatListaSetteos([fila({ fecha: '2026-08-06' })], { conFecha: true });
  assert.ok(L.some((l) => l.includes('06/08 Juan Pérez')));
});

test('lista: sin filas no ensucia el mensaje', () => {
  assert.deepEqual(formatListaSetteos([]), []);
  const msg = formatMisSetteos({
    closerName: 'S', dateLabel: 'hoy', reportado: reportado(), hubspot: 9, cuota: cuota(), filas: [],
  });
  assert.doesNotMatch(msg, /Tus setteos:/);
});
