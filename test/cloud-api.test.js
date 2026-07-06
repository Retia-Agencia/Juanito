// test/cloud-api.test.js
// Tests del adaptador de la Cloud API (Twilio) con un fetch falso. Sin red.
//   node --test test/cloud-api.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCloudApiSender } from '../src/whatsapp/cloud-api.js';

function fakeFetch(recorder, { ok = true, status = 201, body = '{"sid":"SM123","status":"queued"}' } = {}) {
  return async (url, opts) => {
    recorder.push({ url, opts });
    return { ok, status, text: async () => body };
  };
}

test('sendTemplate: POST con To/From/ContentSid/ContentVariables y auth básica', async () => {
  const calls = [];
  const sender = createCloudApiSender({
    accountSid: 'ACxxx',
    authToken: 'tok',
    from: '573001112233',
    fetchImpl: fakeFetch(calls),
    minGapMs: 0,
    jitterMs: 0,
  });
  const resp = await sender.sendTemplate({ to: '573105551234', contentSid: 'HX9', vars: { 1: 'Ana' } });
  assert.equal(resp.sid, 'SM123');
  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.match(url, /Accounts\/ACxxx\/Messages\.json$/);
  assert.equal(opts.method, 'POST');
  assert.match(opts.headers.Authorization, /^Basic /);
  const params = new URLSearchParams(opts.body);
  assert.equal(params.get('To'), 'whatsapp:+573105551234');
  assert.equal(params.get('From'), 'whatsapp:+573001112233');
  assert.equal(params.get('ContentSid'), 'HX9');
  assert.equal(params.get('ContentVariables'), JSON.stringify({ 1: 'Ana' }));
});

test('sendTemplate: respuesta no-ok lanza con el status', async () => {
  const sender = createCloudApiSender({
    accountSid: 'AC',
    authToken: 't',
    from: '571',
    fetchImpl: fakeFetch([], { ok: false, status: 401, body: 'unauthorized' }),
    minGapMs: 0,
    jitterMs: 0,
  });
  await assert.rejects(() => sender.sendTemplate({ to: '572', contentSid: 'HX', vars: {} }), /Twilio 401/);
});

test('faltan credenciales → constructor lanza', () => {
  assert.throws(() => createCloudApiSender({ accountSid: 'AC', authToken: '', from: '57' }), /credenciales/);
});
