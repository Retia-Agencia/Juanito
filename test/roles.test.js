// test/roles.test.js
// Cubre roleOf() (fuente de verdad de roles) y toolsForRole() (gateo de tools).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// El SDK de Anthropic exige una apiKey al construir el cliente (claude/index.js).
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const { roleOf, isPrivileged, isStrictPrivileged, groupHasPrivilegedMember, isCloser, closerOf } = await import('../src/common/roles.js');
const { toolsForRole, splitMemory } = await import('../src/claude/index.js');

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

// ─── Rol closer (§18.AV) ──────────────────────────────────────────────────────
// Se apoya en el roster real de calendly/closers.js: Pablo Lozano (una sola identidad,
// sin workLid) y Sebastian Rodriguez (dos identidades, con workLid de trabajo).
const CLOSER_PHONE_JID = '573046131437@s.whatsapp.net'; // Pablo Lozano
const CLOSER_WORK_LID = '158025419608301@lid';          // Sebastian Rodriguez (30x)

test('roleOf: closer por su teléfono canónico', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(roleOf(CLOSER_PHONE_JID), 'closer');
  });
});

test('roleOf: closer por su LID de trabajo', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(roleOf(CLOSER_WORK_LID), 'closer');
  });
});

// El bug que este test bloquea: el fallback retrocompat "cualquier @lid = boss" corre
// cuando BOSS_LID no está configurado. Si la rama de closer fuera DESPUÉS, todo closer que
// escribiera desde su LID quedaría como jefe y vería las tools del jefe.
test('roleOf: SIN BOSS_LID, el LID de un closer es closer — no boss por retrocompat', () => {
  withEnv({ BOSS_PHONE, BOSS_LID: undefined, ADMIN_LID }, () => {
    assert.equal(roleOf(CLOSER_WORK_LID), 'closer');
    // y el retrocompat sigue vivo para un @lid que NO es de nadie del roster
    assert.equal(roleOf('999999999999999@lid'), 'boss');
  });
});

test('roleOf: el equipo NO pierde su rol por estar también en el roster', () => {
  withEnv({ BOSS_PHONE: '573046131437', BOSS_LID, ADMIN_LID }, () => {
    // mismo número que Pablo Lozano, pero configurado como el jefe → gana boss
    assert.equal(roleOf(CLOSER_PHONE_JID), 'boss');
  });
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID: CLOSER_WORK_LID }, () => {
    assert.equal(roleOf(CLOSER_WORK_LID), 'admin');
  });
});

test('isPrivileged: un closer NO es privilegiado', () => {
  assert.equal(isPrivileged('closer'), false);
});

test('isStrictPrivileged: un closer NO puede dar órdenes desde un grupo', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(isStrictPrivileged(CLOSER_WORK_LID), false);
    assert.equal(isStrictPrivileged(CLOSER_PHONE_JID), false);
  });
});

test('closerOf: devuelve la identidad; el pushName NO da rol de closer', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(closerOf(CLOSER_PHONE_JID)?.email, 'pablo.lozano@30x.com');
    assert.equal(closerOf(CLOSER_WORK_LID)?.email, 'sebastian@30x.com');
    assert.equal(closerOf('999999999999999@lid'), null);
    // Un desconocido que se ponga "Pablo Lozano" de nombre de WhatsApp NO hereda el rol:
    // el pushName lo elige quien escribe, así que nunca da privilegios.
    assert.equal(isCloser('999999999999999@lid'), false);
    assert.equal(roleOf('999999999999999@lid'), 'unknown');
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

test('groupHasPrivilegedMember: detecta admin/boss entre participantes (strings y objetos)', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    const outsiders = ['111111111111111@lid', '222222222222222@lid'];
    assert.equal(groupHasPrivilegedMember(outsiders), false, 'solo desconocidos → false');
    assert.equal(groupHasPrivilegedMember([...outsiders, ADMIN_LID]), true, 'con admin → true');
    assert.equal(groupHasPrivilegedMember([{ id: ADMIN_LID }]), true, 'objeto con id admin');
    assert.equal(groupHasPrivilegedMember([{ id: '333@lid', lid: BOSS_LID }]), true, 'objeto con lid boss');
    assert.equal(groupHasPrivilegedMember([`${BOSS_PHONE}@s.whatsapp.net`]), true, 'boss por teléfono');
    assert.equal(groupHasPrivilegedMember([]), false, 'vacío → false');
  });
});

test('isStrictPrivileged: jefe por BOSS_LID exacto, admin por ADMIN_LID, jefe por teléfono', () => {
  withEnv({ BOSS_PHONE, BOSS_LID, ADMIN_LID }, () => {
    assert.equal(isStrictPrivileged(BOSS_LID), true);
    assert.equal(isStrictPrivileged(ADMIN_LID), true);
    assert.equal(isStrictPrivileged(`${BOSS_PHONE}@s.whatsapp.net`), true);
    assert.equal(isStrictPrivileged('999999999999999@lid'), false);
    assert.equal(isStrictPrivileged(''), false);
  });
});

test('isStrictPrivileged: SIN BOSS_LID, un @lid cualquiera NO es privilegiado (no usa el fallback)', () => {
  // Diferencia clave con roleOf(): en grupos todos llegan como @lid; el fallback
  // "cualquier @lid = jefe" convertiría a todo el grupo en jefe. isStrictPrivileged NO lo usa.
  withEnv({ BOSS_PHONE, BOSS_LID: undefined, ADMIN_LID }, () => {
    assert.equal(isStrictPrivileged('999999999999999@lid'), false);
    // pero un LID admin sigue siéndolo, y el jefe por teléfono también
    assert.equal(isStrictPrivileged(ADMIN_LID), true);
    assert.equal(isStrictPrivileged(`${BOSS_PHONE}@s.whatsapp.net`), true);
  });
});

test('toolsForRole: jefe-en-grupo (bossInGroup) expone solo el set acotado', () => {
  const names = toolsForRole('boss', { isGroup: true, bossInGroup: true }).map((t) => t.name);
  assert.deepEqual(
    names.sort(),
    ['create_reminder', 'manage_reminders', 'schedule_group_message', 'set_group_instructions'].sort()
  );
  // NO expone lectura de datos privados ni memoria
  assert.ok(!names.includes('search_knowledge'));
  assert.ok(!names.includes('summarize_group'));
  assert.ok(!names.includes('save_memory'));
});

test('toolsForRole: grupo SIN bossInGroup sigue sin tools de acción (aislado)', () => {
  const names = toolsForRole('boss', { isGroup: true }).map((t) => t.name);
  assert.ok(!names.includes('create_reminder'));
  assert.ok(!names.includes('set_group_instructions'));
});

test('toolsForRole: admin en DM tiene save_memory', () => {
  const names = toolsForRole('admin', { isGroup: false }).map((t) => t.name);
  assert.ok(names.includes('save_memory'));
  assert.ok(names.includes('create_reminder'));
});

test('toolsForRole: jefe en DM NO tiene save_memory pero sí remember_note y el resto', () => {
  const names = toolsForRole('boss', { isGroup: false }).map((t) => t.name);
  assert.ok(!names.includes('save_memory'));
  assert.ok(names.includes('remember_note')); // memoria sandboxed del jefe
  assert.ok(names.includes('create_reminder'));
  assert.ok(names.includes('summarize_group'));
  assert.ok(names.includes('search_knowledge'));
});

test('toolsForRole: admin en DM tiene save_memory y remember_note', () => {
  const names = toolsForRole('admin', { isGroup: false }).map((t) => t.name);
  assert.ok(names.includes('save_memory'));
  assert.ok(names.includes('remember_note'));
});

test('toolsForRole: en grupo no hay escrituras de memoria, ni para admin', () => {
  for (const role of ['admin', 'boss']) {
    const names = toolsForRole(role, { isGroup: true }).map((t) => t.name);
    assert.ok(!names.includes('save_memory'));
    assert.ok(!names.includes('remember_note'));
  }
});

test('splitMemory separa notas del jefe (prefijo boss_note:) de la memoria núcleo', () => {
  const mem = [
    { key: 'numero_cuenta', value: '123' },
    { key: 'boss_note:cafe', value: 'le gusta el café sin azúcar' },
    { key: 'boss_note:1717000000000', value: 'odia las reuniones de los lunes' },
  ];
  const { core, notes } = splitMemory(mem);
  assert.equal(core.length, 1);
  assert.equal(core[0].key, 'numero_cuenta');
  assert.equal(notes.length, 2);
  assert.ok(notes.every((n) => n.key.startsWith('boss_note:')));
});
