// Tests PUROS del cerebro del modelo nudge (src/hubspot/nudge.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNudgeAction, dealUrl, buildDealNudgeMessage, buildCreateDealNudgeMessage, buildTwinReviewMessage } from '../src/hubspot/nudge.js';

test('programa no cubierto → ask (Push 4 clásico)', () => {
  assert.deepEqual(decideNudgeAction({ covered: false }), { action: 'ask', reason: 'uncovered' });
  assert.equal(decideNudgeAction(null).action, 'ask');
});

test('error del matcher → ask (red de seguridad, no perder el dato)', () => {
  assert.equal(decideNudgeAction({ covered: true, error: 'boom' }).action, 'ask');
});

test('deal resuelto (closer ya avanzó) → silent', () => {
  assert.deepEqual(decideNudgeAction({ covered: true, status: 'resolved', deal: { id: '1' } }), { action: 'silent' });
});

test('deal estancado en Agendado → nudge_update con link', () => {
  const r = decideNudgeAction({ covered: true, status: 'stale', deal: { id: '55' } });
  assert.equal(r.action, 'nudge_update');
  assert.match(r.dealUrl, /deal\/55$/);
});

test('lead sin contacto o sin deal → nudge_create', () => {
  assert.equal(decideNudgeAction({ covered: true, reason: 'no_contact' }).action, 'nudge_create');
  assert.equal(decideNudgeAction({ covered: true, contact: {}, reason: 'no_deal' }).action, 'nudge_create');
});

test('etapa no clasificable (unknown) → ask (red de seguridad)', () => {
  assert.equal(decideNudgeAction({ covered: true, status: 'unknown', deal: { id: '1' } }).action, 'ask');
});

test('dealUrl arma el deep-link con el portal', () => {
  assert.equal(dealUrl('99'), 'https://app.hubspot.com/contacts/50929115/deal/99');
  assert.equal(dealUrl(null), null);
});

test('mensajes: nudge de update menciona lead, link e invita a reagenda', () => {
  const m = buildDealNudgeMessage({ name: 'Pablo G.', url: 'https://x/deal/1' });
  assert.match(m, /Pablo G\./);
  assert.match(m, /Agendado/);
  assert.match(m, /https:\/\/x\/deal\/1/);
  assert.match(m, /reagend/i);
});

test('mensajes: nudge de create distingue no_deal de no_contact', () => {
  // El copy cambió el 2026-07-28 (ver el test de abajo): los dos motivos siguen distinguiéndose,
  // pero ninguno manda a crear el deal de una.
  assert.match(buildCreateDealNudgeMessage({ name: 'Ana', reason: 'no_deal' }), /no le veo deal/i);
  assert.match(buildCreateDealNudgeMessage({ name: 'Ana', reason: 'no_contact' }), /no lo encuentro/i);
});

// ─── Gemelos: el lead agendó con un correo distinto al del formulario (2026-07-28) ──────────
// Regla de ops: el deal casi siempre YA existe y ya es del closer, colgado de otro contacto.
// Decirle "créalo" produce un duplicado. Estos tests fijan las tres salidas posibles.

test('un solo deal de gemelo → se adopta y el mensaje dice bajo qué correo está', () => {
  const msg = buildDealNudgeMessage({
    name: 'Francisco Patarroyo',
    url: 'https://app.hubspot.com/contacts/1/deal/63140649533',
    viaTwin: { id: '237475367219', email: 'f.patarroyo@hotmail.com' },
  });
  assert.match(msg, /Francisco Patarroyo/);
  assert.match(msg, /63140649533/);
  // Sin esta línea el closer cree que Juanito se equivocó de deal: él buscó por el correo
  // de la reunión y ahí no está.
  assert.match(msg, /f\.patarroyo@hotmail\.com/);
});

test('sin gemelo, el nudge de siempre no menciona ningún correo', () => {
  const msg = buildDealNudgeMessage({ name: 'Ana', url: 'https://x/deal/1' });
  assert.ok(!msg.includes('Ojo: el deal está bajo'));
});

test('varios homónimos con deal → nudge_review con TODOS los links, nunca elegir uno', () => {
  const d = decideNudgeAction({
    covered: true,
    reason: 'ambiguous_twin',
    twinDealIds: ['61596985627', '63133504121'],
  });
  assert.equal(d.action, 'nudge_review');
  assert.equal(d.dealUrls.length, 2);

  const msg = buildTwinReviewMessage({ name: 'Diana Fonseca', urls: d.dealUrls });
  assert.match(msg, /61596985627/);
  assert.match(msg, /63133504121/);
  // Lo que NO debe hacer: mandarlo a crear uno nuevo.
  assert.match(msg, /No crees uno nuevo sin mirar estos primero/);
});

test('el nudge de creación ya NO dice "créalo" a secas: manda a buscar por nombre o teléfono', () => {
  for (const reason of ['no_contact', 'no_deal']) {
    const msg = buildCreateDealNudgeMessage({ name: 'Ana Gómez', reason });
    assert.match(msg, /búscalo por \*nombre\* o \*teléfono\*/i, `${reason}: falta la instrucción de ops`);
    assert.match(msg, /no por el correo de la reunión/i, `${reason}: falta el porqué`);
    // La creación sigue permitida, pero de último y con la etapa correcta.
    assert.match(msg, /Si de verdad no existe, créalo y déjalo en \*Agendado\*/);
  }
});
