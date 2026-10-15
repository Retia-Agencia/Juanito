// Semáforo de Retia: todo se prueba con deps en memoria para no cargar DB ni WhatsApp.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { runSemaforoRetia, semaforoRetiaHabilitado } = await import(
  '../src/scheduler/semaforo-retia.js'
);

const NOW = new Date('2026-07-14T14:15:00Z'); // 09:15 en Bogotá
const CONFIG = [
  { programa: 'Alpha', horas: ['09:00'], horaCierre: '18:00' },
  { programa: 'Beta', horas: ['10:00'], horaCierre: null },
];

const METRICA = {
  metrica: 'costo_por_agenda',
  color: 'peligro',
  motivo: null,
  moneda: 'COP',
  gasto: 609860,
  agendas: 2,
  costo: 304930,
  umbral: { meta: 200000, aceptable: 250000 },
  porcentajeDelUmbral: 152.5,
  ayerALaMismaHora: { dia: '2026-07-13', gasto: 300000, agendas: 3, costo: 100000 },
  trayectoria: [
    { hora: '09:00', gasto: 0, agendas: 0, costo: null },
    { hora: '11:00', gasto: 120000, agendas: 1, costo: 120000 },
  ],
  diasSeguidosEnRojo: 3,
  agendasMeta: 4,
  campanas: [],
  notas: [{ tipo: 'problema', texto: 'Creativo agotado' }],
};

const GRUPO = 'retia@g.us';

// `destino` es el campo que el CRM mandaba antes del ticket 268; se ignora si llega.
function envio(programa = 'Alpha', destino = undefined) {
  return {
    programa,
    ...(destino === undefined ? {} : { destino }),
    tipo: 'dia',
    hora: '09:00',
    enlaceHub: 'https://hub.test/alpha',
    error: null,
    metricas: [METRICA],
    texto: `🚦 Semáforo de pauta · ${programa} · 09:00\n🔴 Costo por agenda: $304.930 COP\nVer en el Hub: https://hub.test/alpha`,
  };
}

function harness({ respuesta, fetchError = null, status = 200, configGuardada = null } = {}) {
  const sent = [];
  const settings = configGuardada == null ? {} : { semaforo_retia_config: configGuardada };
  const calls = [];
  const h = { sent, settings, calls };
  h.deps = {
    fetchConDeadline: async (...args) => {
      calls.push(args);
      if (fetchError) throw fetchError;
      return { status, json: async () => respuesta };
    },
      sendMessage: async (to, text) => {
      sent.push({ to, text });
    },
    getSetting: (key) => settings[key] ?? null,
    setSetting: (key, value) => (settings[key] = value),
  };
  return h;
}

beforeEach(() => {
  process.env.TZ = 'America/Bogota';
  process.env.RETIA_SEMAFORO_URL = 'https://crm.test/semaforo';
  process.env.RETIA_SEMAFORO_SECRETO = 'secreto-test';
  process.env.RETIA_SEMAFORO_GRUPO = GRUPO;
});

test('dos programas: los dos van al grupo del .env y guarda la configuración', async () => {
  const respuesta = {
    sincronizacion: { estado: 'ok', ultimaFoto: null },
    envios: [envio(), envio('Beta')],
    configuracion: CONFIG,
  };
  const h = harness({ respuesta });

  assert.deepEqual(await runSemaforoRetia({ now: NOW, deps: h.deps }), {
    enviados: 2,
    modo: 'ok',
  });
  assert.deepEqual(h.sent.map((x) => x.to), [GRUPO, GRUPO]);
  assert.equal(h.settings.semaforo_retia_config, JSON.stringify(CONFIG));
  assert.deepEqual(h.calls[0], [
    'https://crm.test/semaforo',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-semaforo-secreto': 'secreto-test',
      },
      body: '{}',
    },
  ]);
});

test('envíos vacíos: no manda y sí guarda la configuración', async () => {
  const h = harness({ respuesta: { sincronizacion: null, envios: [], configuracion: CONFIG } });
  const result = await runSemaforoRetia({ deps: h.deps });
  assert.deepEqual(result, { enviados: 0, modo: 'ok' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.settings.semaforo_retia_config, JSON.stringify(CONFIG));
});

test('un destino que todavía mande el CRM se ignora: va al grupo del .env', async () => {
  const h = harness({
    respuesta: { sincronizacion: null, envios: [envio('Alpha', 'viejo@g.us')], configuracion: CONFIG },
  });
  await runSemaforoRetia({ deps: h.deps });
  assert.deepEqual(h.sent.map((x) => x.to), [GRUPO]);
});

test('fetch caído: avisa al grupo solo por el programa que tocaba a esta hora', async () => {
  const h = harness({
    fetchError: new Error('timeout'),
    configGuardada: JSON.stringify(CONFIG),
  });
  const result = await runSemaforoRetia({ now: NOW, deps: h.deps });
  assert.deepEqual(result, { enviados: 1, modo: 'caido' });
  assert.deepEqual(h.sent.map((x) => x.to), [GRUPO]);
  assert.match(h.sent[0].text, /Alpha · 09:00/);
  assert.match(h.sent[0].text, /El CRM no respondió/);
});

test('fetch caído sin configuración: no manda', async () => {
  const h = harness({ fetchError: new Error('timeout') });
  assert.deepEqual(await runSemaforoRetia({ now: NOW, deps: h.deps }), {
    enviados: 0,
    modo: 'caido',
  });
  assert.equal(h.sent.length, 0);
});

test('status 401 se trata como CRM caído', async () => {
  const h = harness({ status: 401, configGuardada: JSON.stringify(CONFIG) });
  const result = await runSemaforoRetia({ now: NOW, deps: h.deps });
  assert.equal(result.modo, 'caido');
  assert.equal(result.enviados, 1);
});

test('manda el texto del CRM tal cual', async () => {
  const h = harness({
    respuesta: { sincronizacion: null, envios: [envio()], configuracion: CONFIG },
  });
  await runSemaforoRetia({ deps: h.deps });
  assert.equal(h.sent[0].text, envio().texto);
});

test('un envío sin texto no se inventa y el otro sale normal', async () => {
  const { texto, ...sinTexto } = envio();
  const h = harness({
    respuesta: {
      sincronizacion: null,
      envios: [sinTexto, envio('Beta')],
      configuracion: CONFIG,
    },
  });
  const result = await runSemaforoRetia({ deps: h.deps });
  assert.deepEqual(result, { enviados: 1, modo: 'ok' });
  assert.match(h.sent[0].text, /Beta/);
});

test('un sendMessage que falla no corta el siguiente', async () => {
  const h = harness({
    respuesta: {
      sincronizacion: null,
      envios: [envio(), envio('Beta')],
      configuracion: CONFIG,
    },
  });
  let intentos = 0;
  const enviar = h.deps.sendMessage;
  h.deps.sendMessage = async (to, text) => {
    if (intentos++ === 0) throw new Error('WA caído');
    return enviar(to, text);
  };
  const result = await runSemaforoRetia({ deps: h.deps });
  assert.deepEqual(result, { enviados: 1, modo: 'ok' });
  assert.match(h.sent[0].text, /Beta/);
});

test('sin URL, secreto o grupo el semáforo queda deshabilitado', () => {
  const completo = { RETIA_SEMAFORO_URL: 'https://crm', RETIA_SEMAFORO_SECRETO: 'x', RETIA_SEMAFORO_GRUPO: 'g@g.us' };
  assert.equal(semaforoRetiaHabilitado({ ...completo, RETIA_SEMAFORO_URL: '' }), false);
  assert.equal(semaforoRetiaHabilitado({ ...completo, RETIA_SEMAFORO_SECRETO: '' }), false);
  assert.equal(semaforoRetiaHabilitado({ ...completo, RETIA_SEMAFORO_GRUPO: '' }), false);
  assert.equal(semaforoRetiaHabilitado(completo), true);
});
