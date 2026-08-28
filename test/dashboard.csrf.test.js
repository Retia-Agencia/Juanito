// test/dashboard.csrf.test.js — el dashboard no tiene login: la red es la auth. Esto fija que
// eso NO alcanza para los POST, y que un pedido armado por otra página no pasa.
//
// El hallazgo original (auditoría 2026-08-26): `/api/deploy` respondía ANTES de cualquier gate y
// no había un solo chequeo de Origin/Referer/CSRF. Un POST `text/plain` desde cualquier pestaña
// de alguien del tailnet disparaba un deploy `todo` → reconexión de Baileys → riesgo de softban.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { motivoRechazoCsrf, HEADER_PROPIO, VALOR_PROPIO } from '../dashboard/server/csrf.js';

const bueno = (extra = {}) => ({
  [HEADER_PROPIO]: VALOR_PROPIO,
  'content-type': 'application/json',
  ...extra,
});

beforeEach(() => {
  delete process.env.DASH_ALLOWED_ORIGINS;
});

test('el pedido de la propia UI pasa', () => {
  assert.equal(motivoRechazoCsrf(bueno()), null);
});

test('curl sin Origin pasa: el header propio ya filtró (selftests, scripts del VPS)', () => {
  assert.equal(motivoRechazoCsrf({ [HEADER_PROPIO]: VALOR_PROPIO }), null);
});

// ─── El ataque exacto del informe ─────────────────────────────────────────────

test('el POST text/plain sin header propio —el ataque del informe— se rechaza', () => {
  const motivo = motivoRechazoCsrf({
    'content-type': 'text/plain;charset=UTF-8',
    origin: 'https://sitio-cualquiera.com',
    host: 'juanito.tail2df10b.ts.net',
  });
  assert.ok(motivo, 'un POST cross-origin sin header propio TIENE que rechazarse');
  assert.match(motivo, /header de origen/);
});

test('sin el header propio no pasa NADA, por más que el resto esté impecable', () => {
  const motivo = motivoRechazoCsrf({
    'content-type': 'application/json',
    origin: 'https://juanito.tail2df10b.ts.net',
    host: 'juanito.tail2df10b.ts.net',
  });
  assert.match(motivo, /header de origen/);
});

test('el header propio con otro valor no sirve', () => {
  assert.match(motivoRechazoCsrf(bueno({ [HEADER_PROPIO]: 'otra-cosa' })), /header de origen/);
});

// ─── Content-Type: los tipos "simples" son los que no disparan preflight ──────

for (const tipo of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
  test(`content-type "${tipo}" se rechaza aunque venga el header propio`, () => {
    const motivo = motivoRechazoCsrf(bueno({ 'content-type': tipo }));
    assert.match(motivo, /content-type no aceptado/);
  });
}

test('el charset pegado al content-type no rompe el chequeo', () => {
  assert.equal(motivoRechazoCsrf(bueno({ 'content-type': 'application/json; charset=utf-8' })), null);
});

// ─── Origin: defensa en profundidad, deliberadamente indulgente ───────────────

test('Origin que coincide con Host pasa', () => {
  const h = bueno({ origin: 'https://juanito.tail2df10b.ts.net', host: 'juanito.tail2df10b.ts.net' });
  assert.equal(motivoRechazoCsrf(h), null);
});

test('Origin que coincide con X-Forwarded-Host pasa (el caso de tailscale serve)', () => {
  // Detrás del proxy, `host` puede ser el del backend. Si esto fallara, el dashboard quedaría
  // tapiado en producción sin un error que lo explique — que es peor que el bug original.
  const h = bueno({
    origin: 'https://juanito.tail2df10b.ts.net',
    host: 'localhost:8080',
    'x-forwarded-host': 'juanito.tail2df10b.ts.net',
  });
  assert.equal(motivoRechazoCsrf(h), null);
});

test('Origin ajeno se rechaza aun con el header propio puesto', () => {
  const h = bueno({ origin: 'https://evil.example', host: 'juanito.tail2df10b.ts.net' });
  assert.match(motivoRechazoCsrf(h), /origin ajeno/);
});

test('DASH_ALLOWED_ORIGINS es la válvula de escape', () => {
  process.env.DASH_ALLOWED_ORIGINS = 'http://localhost:5173, https://otro.ts.net';
  const h = bueno({ origin: 'http://localhost:5173', host: 'juanito.tail2df10b.ts.net' });
  assert.equal(motivoRechazoCsrf(h), null, 'el dev server de Vite tiene que poder entrar');
});

test('Origin malformado se rechaza en vez de romper', () => {
  assert.match(motivoRechazoCsrf(bueno({ origin: 'no-es-una-url' })), /origin malformado/);
});
