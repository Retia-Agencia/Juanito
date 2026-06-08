// test/roles.test.js
// Cubre roleOf() (fuente de verdad de roles) y toolsForRole() (gateo de tools).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// El SDK de Anthropic exige una apiKey al construir el cliente (claude/index.js).
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const { roleOf, isPrivileged } = await import('../src/common/roles.js');
const { toolsForRole } = await import('../src/claude/index.js');

// Helper: corre fn con env temporal y restaura al terminar.
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const BOSS_PHONE = '573105643297';
const BOSS_LID = '147313234280449@lid';
const ADMIN_LID = '129446371655733@lid';

test('roleOf: LID en ADMIN_LID es admin', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(roleOf(ADMIN_LID), 'admin');
  });
});

test('roleOf: admin gana sobre boss si el LID está en ambos', () => {
  // Mismo LID en BOSS_LID y ADMIN_LID → debe quedar admin (caso real del compañero).
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID: BOSS_LID }, () => {
    assert.equal(roleOf(BOSS_LID), 'admin');
  });
});

test('roleOf: jefe por teléfono', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(roleOf(`${BOSS_PHONE}@s.whatsapp.net`), 'boss');
  });
});

test('roleOf: jefe por su BOSS_LID específico', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(roleOf(BOSS_LID), 'boss');
  });
});

test('roleOf: @lid desconocido con BOSS_LID configurado es unknown', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(roleOf('999999999999999@lid'), 'unknown');
  });
});

test('roleOf: retrocompat — sin BOSS_LID, cualquier @lid no-admin es boss', () => {
  withEnv({ BOSS_PHONE, BOSS_LID: undefined, ADMIN_LID }, () => {
    assert.equal(roleOf('999999999999999@lid'), 'boss');
    // pero un LID admin sigue siendo admin aunque no haya BOSS_LID
    assert.equal(roleOf(ADMIN_LID), 'admin');
  });
});

test('roleOf: vacío/nulo es unknown', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(roleOf(''), 'unknown');
    assert.equal(roleOf(null), 'unknown');
    assert.equal(roleOf(undefined), 'unknown');
  });
});

test('isPrivileged: admin y boss sí, unknown no', () => {
  assert.equal(isPrivileged('admin'), true);
  assert.equal(isPrivileged('boss'), true);
  assert.equal(isPrivileged('unknown'), false);
});

test('toolsForRole: admin en DM tiene save_memory', () => {
  const names = toolsForRole('admin', { isGroup: false }).map((t) => t.name);
  assert.ok(names.includes('save_memory'));
  assert.ok(names.includes('create_reminder'));
});

test('toolsForRole: jefe en DM NO tiene save_memory pero sí el resto', () => {
  const names = toolsForRole('boss', { isGroup: false }).map((t) => t.name);
  assert.ok(!names.includes('save_memory'));
  assert.ok(names.includes('create_reminder'));
  assert.ok(names.includes('summarize_group'));
  assert.ok(names.includes('search_knowledge'));
});

test('toolsForRole: en grupo nunca hay save_memory, ni siquiera para admin', () => {
  assert.ok(!toolsForRole('admin', { isGroup: true }).map((t) => t.name).includes('save_memory'));
  assert.ok(!toolsForRole('boss', { isGroup: true }).map((t) => t.name).includes('save_memory'));
});
