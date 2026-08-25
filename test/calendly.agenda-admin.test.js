// test/calendly.agenda-admin.test.js
// Agenda diaria que recibe la admin de la marca (Mariana, 7am). El módulo es PURO a propósito
// —sin red ni DB— porque es la parte que se puede iterar en Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tallyByCloser, buildAgendaMessage } = await import('../src/calendly/agenda-admin.js');

const ROSTER = [
  { email: 'aguilare@estadox.com', name: 'Esteban Aguilar' },
  { email: 'sebastian.salazar@30x.com', name: 'Sebastian Salazar' },
];

const call = (email) => ({ closerEmail: email });

// ─── tallyByCloser ────────────────────────────────────────────────────────────

test('cuenta las calls de cada closer y ordena por cantidad', () => {
  const calls = [
    call('sebastian.salazar@30x.com'),
    call('aguilare@estadox.com'),
    call('aguilare@estadox.com'),
    call('aguilare@estadox.com'),
  ];
  const t = tallyByCloser(calls, ROSTER);
  assert.deepEqual(
    t.map((c) => [c.name, c.count]),
    [
      ['Esteban Aguilar', 3],
      ['Sebastian Salazar', 1],
    ]
  );
});

test('un closer SIN calls sale con 0, no desaparece', () => {
  // Una ausencia se lee igual que "este closer ya no existe" o "el mensaje se cortó". Un 0
  // dice lo que pasó: hoy no tiene agenda.
  const t = tallyByCloser([call('aguilare@estadox.com')], ROSTER);
  assert.equal(t.length, 2);
  const salazar = t.find((c) => c.name === 'Sebastian Salazar');
  assert.equal(salazar.count, 0);
});

test('sin calls devuelve todo el roster en 0', () => {
  const t = tallyByCloser([], ROSTER);
  assert.deepEqual(t.map((c) => c.count), [0, 0]);
  // Empate en 0 → desempata por nombre, para que el orden no baile entre días.
  assert.deepEqual(t.map((c) => c.name), ['Esteban Aguilar', 'Sebastian Salazar']);
});

test('normaliza mayúsculas y espacios del email', () => {
  const t = tallyByCloser([call('  AGUILARE@EstadoX.com ')], ROSTER);
  assert.equal(t.find((c) => c.name === 'Esteban Aguilar').count, 1);
});

test('una call de un host FUERA del roster se cuenta aparte, no se descarta', () => {
  // Descartarla en silencio es exactamente cómo el programa estuvo un mes sin pushes sin que
  // nadie se enterara. Acá tiene que VERSE.
  const t = tallyByCloser([call('nuevo@estadox.com'), call('aguilare@estadox.com')], ROSTER);
  const extra = t.find((c) => c.unmapped);
  assert.ok(extra, 'el host sin mapear tiene que aparecer');
  assert.equal(extra.count, 1);
  assert.equal(extra.email, 'nuevo@estadox.com');
  // Y va al FINAL, después del roster.
  assert.equal(t[t.length - 1].unmapped, true);
});

test('tolera entradas basura sin romperse', () => {
  const t = tallyByCloser([{ closerEmail: null }, {}, call('')], ROSTER);
  assert.deepEqual(t.map((c) => c.count), [0, 0]);
  assert.deepEqual(tallyByCloser(null, ROSTER).map((c) => c.count), [0, 0]);
  assert.deepEqual(tallyByCloser([call('x@y.com')], null), [
    { email: 'x@y.com', name: 'x@y.com', count: 1, unmapped: true },
  ]);
});

// ─── buildAgendaMessage ───────────────────────────────────────────────────────

test('el mensaje trae una línea por closer y el total', () => {
  const t = tallyByCloser(
    [call('aguilare@estadox.com'), call('aguilare@estadox.com'), call('sebastian.salazar@30x.com')],
    ROSTER
  );
  const msg = buildAgendaMessage({
    tally: t,
    dateLabel: 'martes, 25 de agosto',
    programLabel: 'IA para Abogados',
  });
  assert.match(msg, /IA para Abogados/);
  assert.match(msg, /martes, 25 de agosto/);
  assert.match(msg, /• Esteban Aguilar: 2/);
  assert.match(msg, /• Sebastian Salazar: 1/);
  assert.match(msg, /Total: 3/);
});

test('sin llamadas lo dice explícito en vez de un total pelado', () => {
  const msg = buildAgendaMessage({
    tally: tallyByCloser([], ROSTER),
    dateLabel: 'domingo, 30 de agosto',
    programLabel: 'IA para Abogados',
  });
  assert.match(msg, /Total: 0 — no hay llamadas agendadas para hoy\./);
  // Los closers siguen listados, en 0.
  assert.match(msg, /• Esteban Aguilar: 0/);
});

test('el mensaje NO lleva PII de los leads', () => {
  // Es la diferencia con el digest Push 1/2: la admin supervisa carga, no atiende las calls.
  const t = tallyByCloser([call('aguilare@estadox.com')], ROSTER);
  const msg = buildAgendaMessage({ tally: t, dateLabel: 'x', programLabel: 'y' });
  assert.ok(!/@/.test(msg), 'no debe haber correos en el mensaje');
  assert.ok(!/\+?\d{7,}/.test(msg), 'no debe haber teléfonos en el mensaje');
});

test('un host sin mapear se marca en la línea y agrega el aviso al pie', () => {
  const t = tallyByCloser([call('nuevo@estadox.com')], ROSTER);
  const msg = buildAgendaMessage({ tally: t, dateLabel: 'x', programLabel: 'y' });
  assert.match(msg, /sin mapear/);
  assert.match(msg, /avisá al equipo técnico/);
});

test('sin closers configurados avisa en vez de salir mudo', () => {
  const msg = buildAgendaMessage({ tally: [], dateLabel: 'x', programLabel: 'y' });
  assert.match(msg, /No hay closers configurados/);
});

// ─── Regresión del envío real del 2026-08-25 ──────────────────────────────────

test('REGRESIÓN: los closers de OTRA conexión no pueden aparecer como "sin mapear"', () => {
  // Lo que salió mal en el primer envío real: hubspotDigestItems devuelve las citas de TODOS
  // los closers del CRM, no solo las de esta conexión. Volcadas sin filtrar en un tally acotado
  // al roster de EstadoX, las 10 calls de Daniela/Marín/Lozano/Mendoza cayeron en el bucket de
  // "sin mapear" y Mariana recibió sus correos crudos bajo el título "IA para Abogados".
  //
  // El filtro correcto vive en el scheduler (necesita accountOfCloser). Este test fija el
  // CONTRATO que ese filtro tiene que cumplir antes de llamar a tallyByCloser: lo que llega acá
  // ya viene acotado a la conexión, y entonces el bucket de "sin mapear" queda vacío.
  const yaFiltrado = [
    call('aguilare@estadox.com'),
    call('aguilare@estadox.com'),
    call('sebastian.salazar@30x.com'),
  ];
  const t = tallyByCloser(yaFiltrado, ROSTER);
  assert.ok(!t.some((c) => c.unmapped), 'con las calls ya filtradas por conexión no debe haber "sin mapear"');
  const msg = buildAgendaMessage({ tally: t, dateLabel: 'x', programLabel: 'IA para Abogados' });
  assert.ok(!/sin mapear/.test(msg), 'el mensaje no debe traer el aviso de host desconocido');
  assert.ok(!/@30x\.com/.test(msg), 'nunca un correo crudo en el mensaje de la admin');
  assert.match(msg, /Total: 3/);
});
