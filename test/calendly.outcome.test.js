// test/calendly.outcome.test.js
// Tests de los helpers PUROS del registro de outcomes post-call (§18.AB):
// parsers de la respuesta del closer + builders de mensaje (sin red, sin DB → Windows).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota';

const {
  parseAsistenciaReply,
  parseResultadoReply,
  push4DueUtc,
  buildPush4Message,
  buildOutcomeFollowupMessage,
  buildOutcomeConfirmation,
  buildOutcomeReminder,
  ASISTENCIA_LABELS,
  RESULTADO_LABELS,
} = await import('../src/calendly/index.js');

// ─── push4DueUtc ──────────────────────────────────────────────────────────────

test('push4DueUtc = start + duración + gracia (default 30+5 = 35 min)', () => {
  const start = '2026-06-30T20:00:00.000Z';
  assert.equal(push4DueUtc(start).toISOString(), '2026-06-30T20:35:00.000Z');
  assert.equal(push4DueUtc(start, 45, 5).toISOString(), '2026-06-30T20:50:00.000Z');
});

// ─── parseAsistenciaReply ─────────────────────────────────────────────────────

test('asistencia por número', () => {
  assert.equal(parseAsistenciaReply('1'), 'show');
  assert.equal(parseAsistenciaReply('2'), 'no_show');
  assert.equal(parseAsistenciaReply('3'), 'reagendado');
  assert.equal(parseAsistenciaReply('4'), 'cancelado');
  assert.equal(parseAsistenciaReply('opción 2'), 'no_show');
  assert.equal(parseAsistenciaReply('1️⃣'), 'show');
});

test('asistencia: la negación gana sobre "show"/"llegó" (orden correcto)', () => {
  assert.equal(parseAsistenciaReply('no show'), 'no_show');
  assert.equal(parseAsistenciaReply('No Show'), 'no_show');
  assert.equal(parseAsistenciaReply('no llegó'), 'no_show');
  assert.equal(parseAsistenciaReply('no se presentó'), 'no_show');
  assert.equal(parseAsistenciaReply('me dejó fantasma'), 'no_show');
});

test('asistencia: lenguaje natural show / reagendado', () => {
  assert.equal(parseAsistenciaReply('fue show, asistió'), 'show');
  assert.equal(parseAsistenciaReply('sí vino'), 'show');
  assert.equal(parseAsistenciaReply('se conectó'), 'show');
  assert.equal(parseAsistenciaReply('lo reagendé para mañana'), 'reagendado');
  assert.equal(parseAsistenciaReply('reprogramada'), 'reagendado');
});

test('asistencia: no entiendo → null', () => {
  assert.equal(parseAsistenciaReply('jajaja qué tal'), null);
  assert.equal(parseAsistenciaReply(''), null);
  assert.equal(parseAsistenciaReply(null), null);
});

// ─── parseResultadoReply ──────────────────────────────────────────────────────

test('resultado por número', () => {
  assert.equal(parseResultadoReply('1'), 'venta_cerrada');
  assert.equal(parseResultadoReply('2'), 'acuerdo_verbal');
  assert.equal(parseResultadoReply('3'), 'seguimiento');
  assert.equal(parseResultadoReply('4'), 'no_cerro');
});

test('resultado: "no cerró" gana sobre "cerró"', () => {
  assert.equal(parseResultadoReply('no cerró'), 'no_cerro');
  assert.equal(parseResultadoReply('no vendí nada'), 'no_cerro');
  assert.equal(parseResultadoReply('cerró, venta'), 'venta_cerrada');
  assert.equal(parseResultadoReply('vendido'), 'venta_cerrada');
});

test('resultado: acuerdo verbal y seguimiento', () => {
  assert.equal(parseResultadoReply('quedó en acuerdo verbal'), 'acuerdo_verbal');
  assert.equal(parseResultadoReply('me dijo que lo va a pensar'), 'seguimiento');
  assert.equal(parseResultadoReply('seguimiento'), 'seguimiento');
  assert.equal(parseResultadoReply('cualquier cosa'), null);
});

// ─── Mensajes ─────────────────────────────────────────────────────────────────

test('buildPush4Message incluye lead, hora y las 3 opciones', () => {
  const msg = buildPush4Message({ name: 'Juan Pérez', startIso: '2026-06-30T20:00:00.000Z' });
  assert.match(msg, /Juan Pérez/);
  assert.match(msg, /Show/);
  assert.match(msg, /No show/);
  assert.match(msg, /Reagend/);
  assert.match(msg, /\d{1,2}:\d{2}/); // hora local
});

test('buildOutcomeFollowupMessage lista los 4 resultados', () => {
  const msg = buildOutcomeFollowupMessage({ name: 'Juan' });
  assert.match(msg, /Venta cerrada/);
  assert.match(msg, /Acuerdo verbal/);
  assert.match(msg, /Seguimiento/);
  assert.match(msg, /No cerró/);
});

test('buildOutcomeConfirmation refleja asistencia y resultado', () => {
  assert.match(
    buildOutcomeConfirmation({ name: 'Juan', asistencia: 'show', resultado: 'venta_cerrada' }),
    /Juan.*Show.*Venta cerrada/
  );
  // Sin resultado (no_show) no muestra la barra de resultado.
  const m = buildOutcomeConfirmation({ name: 'Juan', asistencia: 'no_show' });
  assert.match(m, /No show/);
  assert.doesNotMatch(m, /\//);
});

test('buildOutcomeReminder menciona al lead y vuelve a dar las opciones', () => {
  const msg = buildOutcomeReminder({ name: 'Juan Pérez', startIso: '2026-06-30T20:00:00.000Z' });
  assert.match(msg, /Recordatorio/i);
  assert.match(msg, /Juan Pérez/);
  assert.match(msg, /Show/);
});

test('labels expuestos para reportes', () => {
  assert.equal(ASISTENCIA_LABELS.no_show, 'No show');
  assert.equal(RESULTADO_LABELS.venta_cerrada, 'Venta cerrada');
});
