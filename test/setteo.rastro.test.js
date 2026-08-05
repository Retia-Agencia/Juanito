// test/setteo.rastro.test.js
// La captura determinista tiene que dejar RASTRO en `messages` (§18.BD).
//
// Por qué existe: en el smoke del 2026-08-04 el closer reportó 3 leads por texto libre, los
// tres se guardaron bien, y al preguntar "¿cómo voy?" Juanito respondió "No reportaste nada
// todavía hoy". No inventaba: la captura no persiste el intercambio, así que en SU historia
// lo último ocurrido era él mismo diciendo "Borrado, empezamos de cero". Una inferencia
// correcta sobre una historia falsa — el peor tipo de error, porque no parece un bug.
//
// Necesita better-sqlite3 nativo → corre en Docker (Dockerfile.test), no en Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'juanito-rastro-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
process.env.TZ = 'America/Bogota';
execFileSync('node', ['src/db/migrate.js'], { env: { ...process.env }, stdio: 'ignore' });

const { CLOSERS } = await import('../src/calendly/closers.js');
const [EMAIL, closer] = Object.entries(CLOSERS)[0];

// Scope acotado a ese closer y captura prendida, ANTES de importar capture.js (lee env al vuelo,
// pero mejor no depender de eso).
process.env.SETTEO_CAPTURE_ENABLED = 'true';
process.env.SETTEO_CAPTURE_CLOSERS = EMAIL;
process.env.SETTEO_AI_FALLBACK = 'false'; // sin red: solo el parser determinista
process.env.HUBSPOT_ENABLED = 'false';    // el cruce cae a 'skipped', no toca el CRM

const db = await import('../src/db/index.js');
const { captureSetteoReply } = await import('../src/setteo/capture.js');

const CHAT = `${closer.phone.replace(/\D/g, '')}@s.whatsapp.net`;

// Se lee por la MISMA puerta que usa el contexto agéntico. No es un detalle: getRecentHistory
// filtra por `source = 'bot'`, así que guardar con otro source dejaría filas que existen en la
// tabla y son invisibles para Juanito — el bug seguiría vivo y el test en verde.
const mensajesDe = (chatId) => db.getRecentHistory(50, chatId);

test('un setteo capturado deja el mensaje del closer Y la respuesta en la conversación', async () => {
  const antes = mensajesDe(CHAT).length;
  const ok = await captureSetteoReply({
    from: CHAT,
    pushName: closer.name,
    text: 'Hoy toqué a Ana Ruiz, contestó y agendó',
    messageId: `rastro-${Date.now()}`,
  });
  assert.equal(ok, true, 'el mensaje debía consumirse como setteo');

  const despues = mensajesDe(CHAT);
  assert.equal(despues.length - antes, 2, 'deben quedar DOS filas: lo que dijo y lo que se le respondió');
  const roles = despues.slice(-2).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant'], 'y en ese orden, o la API rechaza el historial');
  assert.match(despues.at(-2).content, /Ana Ruiz/, 'el mensaje del closer se guarda tal cual');
});

test('la repregunta por números sueltos también deja rastro', async () => {
  // Es el caso que rompió primero: sin el mensaje en la historia, un "no, descartá eso"
  // posterior llega sin referente y el modelo adivina a qué apunta.
  const antes = mensajesDe(CHAT).length;
  const ok = await captureSetteoReply({
    from: CHAT,
    pushName: closer.name,
    text: 'toqué 20 leads hoy, 5 contestaron',
    messageId: `rastro-agg-${Date.now()}`,
  });
  assert.equal(ok, true);
  const despues = mensajesDe(CHAT);
  assert.equal(despues.length - antes, 2, 'la repregunta también se conversa');
  assert.match(despues.at(-2).content, /20 leads/);
});

test('un mensaje que NO es setteo no ensucia la conversación', async () => {
  // capture.js devuelve false y el mensaje sigue su camino al contexto agéntico, que lo
  // guardará por su cuenta. Guardarlo acá lo duplicaría.
  const antes = mensajesDe(CHAT).length;
  const ok = await captureSetteoReply({
    from: CHAT,
    pushName: closer.name,
    text: '¿a qué hora es la reunión de mañana?',
    messageId: `rastro-no-${Date.now()}`,
  });
  assert.equal(ok, false);
  assert.equal(mensajesDe(CHAT).length, antes, 'no se guarda nada');
});

test('un sender que NO es closer del roster no deja rastro', async () => {
  const CHAT_AJENO = '999999999999@lid';
  const ok = await captureSetteoReply({
    from: CHAT_AJENO,
    pushName: 'Desconocido Cualquiera',
    text: 'Hoy toqué a Ana Ruiz, contestó',
    messageId: `rastro-ajeno-${Date.now()}`,
  });
  assert.equal(ok, false);
  assert.equal(mensajesDe(CHAT_AJENO).length, 0);
});

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* limpieza best-effort */
  }
});
