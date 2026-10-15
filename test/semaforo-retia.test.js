// Semáforo de Retia: todo se prueba con deps en memoria para no cargar DB ni WhatsApp.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { armarMensaje } = await import('../src/semaforo/mensaje.js');
const { runSemaforoRetia, semaforoRetiaHabilitado } = await import(
  '../src/scheduler/semaforo-retia.js'
);

const NOW = new Date('2026-07-14T14:15:00Z'); // 09:15 en Bogotá
const CONFIG = [
  { programa: 'Alpha', destino: 'alpha@g.us', horas: ['09:00'], horaCierre: '18:00' },
  { programa: 'Beta', destino: 'beta@g.us', horas: ['10:00'], horaCierre: null },
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

function envio(programa = 'Alpha', destino = 'alpha@g.us') {
  return {
    programa,
    destino,
    tipo: 'dia',
    hora: '09:00',
    enlaceHub: 'https://hub.test/alpha',
    error: null,
    metricas: [METRICA],
  };
}

function harness({ respuesta, fetchError = null, status = 200, configGuardada = null } = {}) {
  const sent = [];
  const settings = configGuardada == null ? {} : { semaforo_retia_config: configGuardada };
  const calls = [];
  const h = { sent, settings, calls, fallaPara: null };
  h.deps = {
    fetchConDeadline: async (...args) => {
      calls.push(args);
      if (fetchError) throw fetchError;
      return { status, json: async () => respuesta };
    },
    sendMessage: async (to, text) => {
      if (h.fallaPara === to) throw new Error('WA caído');
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
});

test('dos programas: manda a ambos destinos y guarda la configuración', async () => {
  const respuesta = {
    sincronizacion: { estado: 'ok', ultimaFoto: null },
    envios: [envio(), envio('Beta', 'beta@g.us')],
    configuracion: CONFIG,
  };
  const h = harness({ respuesta });

  assert.deepEqual(await runSemaforoRetia({ now: NOW, deps: h.deps }), {
    enviados: 2,
    modo: 'ok',
  });
  assert.deepEqual(h.sent.map((x) => x.to), ['alpha@g.us', 'beta@g.us']);
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

test('fetch caído: avisa solo al destino configurado para la hora actual', async () => {
  const h = harness({
    fetchError: new Error('timeout'),
    configGuardada: JSON.stringify(CONFIG),
  });
  const result = await runSemaforoRetia({ now: NOW, deps: h.deps });
  assert.deepEqual(result, { enviados: 1, modo: 'caido' });
  assert.deepEqual(h.sent.map((x) => x.to), ['alpha@g.us']);
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

test('un envío con error muestra el error y el otro sale normal', async () => {
  const conError = { ...envio(), error: 'No pude calcular la cohorte' };
  const h = harness({
    respuesta: {
      sincronizacion: null,
      envios: [conError, envio('Beta', 'beta@g.us')],
      configuracion: CONFIG,
    },
  });
  await runSemaforoRetia({ deps: h.deps });
  assert.match(h.sent[0].text, /⚠️ No pude calcular la cohorte/);
  assert.doesNotMatch(h.sent[0].text, /Costo por agenda/);
  assert.match(h.sent[1].text, /Costo por agenda/);
});

test('un sendMessage que falla no corta el siguiente', async () => {
  const h = harness({
    respuesta: {
      sincronizacion: null,
      envios: [envio(), envio('Beta', 'beta@g.us')],
      configuracion: CONFIG,
    },
  });
  h.fallaPara = 'alpha@g.us';
  const result = await runSemaforoRetia({ deps: h.deps });
  assert.deepEqual(result, { enviados: 1, modo: 'ok' });
  assert.deepEqual(h.sent.map((x) => x.to), ['beta@g.us']);
});

test('mensaje de día incluye umbral, gasto, ayer, rojo y Hub', () => {
  const msg = armarMensaje(envio(), null);
  assert.match(msg, /^🚦 Semáforo de pauta · Alpha · 09:00/);
  assert.match(msg, /🔴 Costo por agenda: \$304\.930 COP/);
  assert.match(msg, /Meta \$200\.000 COP · aceptable \$250\.000 COP/);
  assert.match(msg, /Gasto \$609\.860 COP · 2 agendas/);
  assert.match(msg, /Ayer a esta hora: \$100\.000 COP \(3 agendas\)/);
  assert.match(msg, /🔴 3 días seguidos en rojo/);
  assert.match(msg, /• ⚠️ Creativo agotado/);
  assert.match(msg, /Ver en el Hub: https:\/\/hub\.test\/alpha$/);
});

test('mensaje de cierre incluye la trayectoria completa', () => {
  const msg = armarMensaje({ ...envio(), tipo: 'cierre', hora: '18:00' }, null);
  assert.match(msg, /^🚦 Cierre del día · Alpha · 18:00/);
  assert.match(
    msg,
    /Trayectoria: 09:00 \$0 COP · 0 ag \| 11:00 \$120\.000 COP · 1 ag/
  );
});

test('sin dato explica que falta cargar el umbral', () => {
  const metrica = { ...METRICA, color: 'sin_dato', costo: null, umbral: null, motivo: 'sin_umbral' };
  const msg = armarMensaje({ ...envio(), metricas: [metrica] }, null);
  assert.match(msg, /⚪ Costo por agenda: sin dato/);
  assert.match(msg, /Falta cargar la meta en el CRM/);
});

test('error de sincronización muestra la hora de la última foto en Bogotá', () => {
  const msg = armarMensaje(envio(), {
    estado: 'error',
    ultimaFoto: '2026-07-14T15:27:00Z',
  });
  assert.match(msg, /⚠️ No se pudo leer Meta; cifras de la última foto \(10:27\)/);
});

test('sin URL o sin secreto el semáforo queda deshabilitado', () => {
  assert.equal(semaforoRetiaHabilitado({ RETIA_SEMAFORO_URL: '', RETIA_SEMAFORO_SECRETO: 'x' }), false);
  assert.equal(semaforoRetiaHabilitado({ RETIA_SEMAFORO_URL: 'https://crm', RETIA_SEMAFORO_SECRETO: '' }), false);
  assert.equal(semaforoRetiaHabilitado({ RETIA_SEMAFORO_URL: 'https://crm', RETIA_SEMAFORO_SECRETO: 'x' }), true);
});
