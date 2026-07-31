// test/calendly.closer-phone-refresh.test.js
// Regresión: rotarle el número a un closer NO puede matar los pushes ya agendados.
//
// El bug (Daniela Camacho, 29-jul-2026): `calendly_pushes` congela `closer_phone` al AGENDAR,
// hasta 48h antes de la call, y la entrega enrutaba con esa copia. Cuando el jefe le rotó el
// número (+573103062287 → +573018094666), las filas ya agendadas siguieron buscando el opt-in
// por el número VIEJO → `skipped: closer sin opt-in`. Y como el skip era terminal, arreglar el
// roster no las revivía: 5 leads se quedaron sin precall.
//
// El fix re-resuelve el teléfono contra el roster vivo AL ENTREGAR, a partir de `closer_email`
// (la identidad estable, que sí vive en la fila). Es el mismo criterio que ya se había aplicado
// al teléfono del LEAD en f8a18b4 — acá se cierra el lado del CLOSER.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';
process.env.CALENDLY_REQUIRE_OPTIN = 'true';
process.env.CALENDLY_DRY_RUN = 'false'; // la cuenta 30x va EN VIVO, como en producción

const scheduler = await import('../src/scheduler/calendly.js');
const { installHarness, makeEvent } = await import('./helpers/calendly-harness.js');
const { CLOSERS } = await import('../src/calendly/closers.js');

const CLOSER = 'daniela.camacho@30x.com';
const PHONE_NUEVO = CLOSERS[CLOSER].phone; // el que hoy tiene el roster
const PHONE_VIEJO = '+573103062287';       // el que tenía antes de la rotación del 28-jul
const JID = '68604267614366@lid';          // su hilo real de opt-in

// startInMin 20 → el `due` del Push 3 (start − 25) ya pasó → catch-up: agenda y entrega
// en el mismo escenario, sin tener que mover el reloj.
function armar(nowMs, optins) {
  return installHarness(scheduler, {
    nowMs,
    optins,
    events: [makeEvent({ uuid: 'e-rotacion', startInMin: 20, closerEmail: CLOSER, nowMs })],
  });
}

test('rotación de número: la fila quedó con el teléfono viejo → igual se entrega al hilo vigente', async () => {
  const now = Date.parse('2026-07-29T14:00:00Z');
  // El opt-in vive SOLO bajo el número nuevo: es el hilo por el que Daniela le habla a Juanito.
  const { store, wa } = armar(now, [{ phone: PHONE_NUEVO, source: 'self', contactJid: JID }]);

  await scheduler.runCalendlyPoll();
  const row = store._rows.find((r) => r.push_n === 3);
  assert.ok(row, 'se agendó el Push 3');

  // Simula la fila agendada ANTES de la rotación: el poll la estampó con el número viejo.
  row.closer_phone = PHONE_VIEJO;
  assert.notEqual(PHONE_VIEJO, PHONE_NUEVO, 'el escenario solo tiene sentido si difieren');

  await scheduler.runCalendlyDelivery();

  assert.equal(wa.sent.length, 1, 'el push salió (antes del fix moría como "closer sin opt-in")');
  assert.equal(wa.sent[0].to, JID, 'fue al hilo vigente, resuelto por email y no por la copia vieja');
  assert.equal(store._rows.find((r) => r.push_n === 3).status, 'sent');

  scheduler.__resetDeps();
});

test('closer que ya no está en el roster → cae al teléfono guardado en la fila (sin regresión)', async () => {
  const now = Date.parse('2026-07-29T14:00:00Z');
  const HUERFANO = 'exclose@30x.com';
  const PHONE_HUERFANO = '+573001234567';
  const JID_HUERFANO = '999@lid';
  const { store, wa } = armar(now, [{ phone: PHONE_HUERFANO, source: 'self', contactJid: JID_HUERFANO }]);

  await scheduler.runCalendlyPoll();
  const row = store._rows.find((r) => r.push_n === 3);

  // Modela al closer que salió del roster DESPUÉS de que se agendó su push: `resolveCloser`
  // ya no lo encuentra, así que el único dato utilizable es el que quedó en la fila.
  row.closer_email = HUERFANO;
  row.closer_phone = PHONE_HUERFANO;
  assert.equal(CLOSERS[HUERFANO], undefined, 'este email no está en el roster');

  await scheduler.runCalendlyDelivery();

  assert.equal(wa.sent.length, 1, 'el fallback mantiene el comportamiento anterior');
  assert.equal(wa.sent[0].to, JID_HUERFANO);

  scheduler.__resetDeps();
});

test('sin opt-in todavía: el push NO se quema, y sale solo cuando el closer abre el hilo', async () => {
  // La otra mitad del bug de Daniela: aunque se arreglara la causa, la fila ya estaba
  // 'skipped' para siempre. Ahora sobrevive y el siguiente tick la entrega.
  const now = Date.parse('2026-07-29T14:00:00Z');
  const { store, wa } = armar(now, []); // todavía sin opt-in

  await scheduler.runCalendlyPoll();
  await scheduler.runCalendlyDelivery();

  assert.equal(wa.sent.length, 0, 'sin opt-in no se envía nada (anti-ban intacto)');
  assert.equal(store._rows.find((r) => r.push_n === 3).status, 'scheduled', 'queda vivo, no quemado');

  // El closer le escribe a Juanito: nace el opt-in.
  store.optIn(PHONE_NUEVO, JID);
  await scheduler.runCalendlyDelivery();

  assert.equal(wa.sent.length, 1, 'el mismo push se entrega en el tick siguiente');
  assert.equal(wa.sent[0].to, JID);

  scheduler.__resetDeps();
});

test('el reintento está acotado: con la call ya empezada, el guard de obsolescencia lo mata', async () => {
  // Sin este límite, un push sin opt-in reintentaría para siempre. El guard ya existía;
  // esto blinda que siga cubriendo el camino nuevo (revert en vez de skip).
  const now = Date.parse('2026-07-29T14:00:00Z');
  const { store, wa, clock } = armar(now, []); // sin opt-in

  await scheduler.runCalendlyPoll();
  clock.ms = now + 21 * 60000; // la llamada (start = now + 20min) ya arrancó
  await scheduler.runCalendlyDelivery();

  assert.equal(wa.sent.length, 0);
  const row = store._rows.find((r) => r.push_n === 3);
  assert.equal(row.status, 'skipped', 'el guard lo cierra: no queda reintentando eternamente');
  assert.match(row.message, /push obsoleto/);

  scheduler.__resetDeps();
});
