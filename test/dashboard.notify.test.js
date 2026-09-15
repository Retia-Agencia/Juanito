// test/dashboard.notify.test.js — el canal fuera de banda del watchdog.
//
// Por qué se testea: este canal existe para el único escenario en que NADIE más va a avisar
// (el bot caído), y por definición se ejercita cuando todo lo demás ya falló. Un bug acá no se
// descubre operando — se descubre el día que importa. El 2026-09-14 Juanito estuvo 2 horas
// caído por `conflict / device_removed` y la alerta no tenía por dónde salir.
//
// Corre en Windows: notify.js solo importa src/common/http.js, sin better-sqlite3.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { enviarTelegram, telegramConfigurado } from '../dashboard/server/notify.js';

const fetchReal = globalThis.fetch;

beforeEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

afterEach(() => {
  globalThis.fetch = fetchReal;
});

const configurar = () => {
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  process.env.TELEGRAM_CHAT_ID = '12345';
};

// ─── Autodesactivación ────────────────────────────────────────────────────────
// Misma convención que los jobs del scheduler: sin credenciales se apaga solo, nunca rompe.

test('sin token ni chat_id está apagado y no toca la red', async () => {
  let llamadas = 0;
  globalThis.fetch = async () => {
    llamadas++;
    throw new Error('no debería llamarse');
  };
  assert.equal(telegramConfigurado(), false);
  assert.equal(await enviarTelegram('hola'), false);
  assert.equal(llamadas, 0);
});

test('con token pero sin chat_id sigue apagado (media configuración no alcanza)', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  assert.equal(telegramConfigurado(), false);
  assert.equal(await enviarTelegram('hola'), false);
});

// ─── Camino feliz ─────────────────────────────────────────────────────────────

test('configurado: postea a la API de Telegram y devuelve true', async () => {
  configurar();
  let url = null;
  let body = null;
  globalThis.fetch = async (u, init) => {
    url = String(u);
    body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => '' };
  };
  assert.equal(await enviarTelegram('Juanito caído'), true);
  assert.match(url, /^https:\/\/api\.telegram\.org\/bottoken-de-prueba\/sendMessage$/);
  assert.equal(body.chat_id, '12345');
  assert.equal(body.text, 'Juanito caído');
});

// Sin parse_mode a propósito: el texto trae correos y motivos de skip con `_` y `*`, y Markdown
// rechazaría el mensaje entero con 400 justo cuando más se necesita que salga.
test('no manda parse_mode — un guion bajo en un correo no puede tumbar la alerta', async () => {
  configurar();
  let body = null;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => '' };
  };
  await enviarTelegram('closer_uno@30x.com perdió *3* pushes');
  assert.equal(body.parse_mode, undefined);
  assert.equal(body.text, 'closer_uno@30x.com perdió *3* pushes');
});

// ─── Es best-effort: nunca lanza ──────────────────────────────────────────────
// El caller es el watchdog, que corre en el proceso que tiene que seguir vivo cuando todo lo
// demás se cayó. Una excepción acá sería exactamente el peor momento para tumbarlo.

test('un error de red devuelve false en vez de lanzar', async () => {
  configurar();
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await enviarTelegram('hola'), false);
});

test('una respuesta no-ok devuelve false en vez de lanzar', async () => {
  configurar();
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
  assert.equal(await enviarTelegram('hola'), false);
});

test('si hasta el .text() del error falla, igual devuelve false', async () => {
  configurar();
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => {
      throw new Error('cuerpo ilegible');
    },
  });
  assert.equal(await enviarTelegram('hola'), false);
});

// ─── Recorte ──────────────────────────────────────────────────────────────────
// Telegram corta en 4096 y no avisa. Preferimos recortar nosotros y decirlo, para que nadie
// lea una alerta truncada creyendo que está completa.

test('un mensaje larguísimo se recorta y lo dice', async () => {
  configurar();
  let body = null;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => '' };
  };
  await enviarTelegram('x'.repeat(10000));
  assert.ok(body.text.length < 4096, `quedó en ${body.text.length}, Telegram corta en 4096`);
  assert.match(body.text, /recortado, mirá el dashboard/);
});

test('un mensaje normal no se toca', async () => {
  configurar();
  let body = null;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => '' };
  };
  const mensaje = '🚨 Juanito — revisión\n\n🔴 Pushes vencidos: 6';
  await enviarTelegram(mensaje);
  assert.equal(body.text, mensaje);
});
