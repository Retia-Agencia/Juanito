// test/scheduled-bypass-cap.test.js
// REGRESIÓN: el tope horario de respuestas autónomas en grupos (GROUP_REPLY_HOURLY_CAP
// / checkAndIncrementGroupReplyQuota) NUNCA debe frenar los recordatorios ni los
// mensajes programados. Esos salen por los schedulers, que llaman a sendMessage directo
// y JAMÁS pasan por handleGroupMessage (el único lugar donde vive el tope).
//
// Dos guardas:
//  1) Invariante de código (corre nativo en Windows, cubre reminders.js que no se puede
//     importar por better-sqlite3): el tope está SOLO en bot/index.js, ausente de los
//     schedulers y de sendMessage.
//  2) Conductual: el ciclo de mensajes programados entrega al grupo aunque sus deps no
//     tengan ninguna noción del tope (se inyecta un mundo sin quota).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const CAP_TOKENS = ['checkAndIncrementGroupReplyQuota', 'GROUP_REPLY_HOURLY_CAP'];

// ─── 1) Invariante de código ───────────────────────────────────────────────────

test('el tope NO aparece en los caminos de entrega programada', () => {
  const entregaProgramada = [
    'src/scheduler/reminders.js',
    'src/scheduler/group-messages.js',
    'src/scheduler/group-replies.js',
    'src/whatsapp/index.js', // sendMessage: el envío crudo NO debe gatear por el tope
  ];
  for (const file of entregaProgramada) {
    const src = read(file);
    for (const token of CAP_TOKENS) {
      assert.ok(
        !src.includes(token),
        `${file} NO debe referenciar "${token}" (frenaría recordatorios/programados)`
      );
    }
  }
});

test('el tope SÍ vive en handleGroupMessage (si no, este test ya no protege nada)', () => {
  const bot = read('src/bot/index.js');
  for (const token of CAP_TOKENS) {
    assert.ok(bot.includes(token), `bot/index.js debe usar "${token}" (es el único punto gateado)`);
  }
});

// ─── 2) Conductual: el ciclo programado entrega sin saber del tope ──────────────

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.BOSS_PHONE = process.env.BOSS_PHONE || '573000000001';
process.env.TZ = 'America/Bogota';

const { runScheduledMessagesCycle, __setDeps, __resetDeps } = await import(
  '../src/scheduler/group-messages.js'
);

test('mensaje fijo programado se entrega al grupo (deps sin ninguna noción de tope)', async () => {
  const sent = [];
  const deps = {
    listScheduledMessages: () => [
      { id: 1, group_id: 'patah@g.us', group_name: 'Patah', days: '4', time_hm: '20:00', text: 'Recordatorio programado', last_sent_date: null, active: 1, kind: 'fixed' },
    ],
    markScheduledMessageSent: () => {},
    isGroupAuthorized: () => true,
    sendMessage: async (to, text) => sent.push({ to, text }),
  };
  // Si algún día el scheduler intentara consultar el tope, fallaría acá (no existe en deps).
  assert.ok(!('checkAndIncrementGroupReplyQuota' in deps), 'las deps del scheduler no incluyen el tope');

  __setDeps(deps);
  try {
    // Jueves 2026-06-11 20:00 hora Bogotá (UTC-5) → la fila 'days:4 time_hm:20:00' aplica.
    const n = await runScheduledMessagesCycle(new Date('2026-06-11T20:00:00-05:00'));
    assert.equal(n, 1, 'el programado se entrega pase lo que pase con el tope');
    assert.deepEqual(sent, [{ to: 'patah@g.us', text: 'Recordatorio programado' }]);
  } finally {
    __resetDeps();
  }
});
