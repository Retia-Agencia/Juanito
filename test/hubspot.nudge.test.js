// Tests PUROS del cerebro del modelo nudge (src/hubspot/nudge.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNudgeAction, dealUrl, buildDealNudgeMessage, buildCreateDealNudgeMessage } from '../src/hubspot/nudge.js';

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
  assert.match(buildCreateDealNudgeMessage({ name: 'Ana', reason: 'no_deal' }), /sin deal/i);
  assert.match(buildCreateDealNudgeMessage({ name: 'Ana', reason: 'no_contact' }), /no lo encuentro/i);
});
