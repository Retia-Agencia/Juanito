// test/approval-routing.test.js
// Ruteo de aprobaciones (approvalsTarget/approvalsGroupId). Puro: con APPROVALS_GROUP
// como group_id o vacío NO se importa whatsapp (Baileys) → corre nativo en Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOSS_LID = '111@lid'; // fallback de bossDmTarget

const { approvalsTarget, approvalsGroupId } = await import('../src/common/approval-routing.js');

test('sin APPROVALS_GROUP → cae al DM del jefe (bossDmTarget)', async () => {
  delete process.env.APPROVALS_GROUP;
  assert.equal(await approvalsGroupId(), null);
  assert.equal(await approvalsTarget(), '111@lid');
});

test('APPROVALS_GROUP como group_id (@g.us) → se usa directo, sin resolver socket', async () => {
  process.env.APPROVALS_GROUP = '120363999@g.us';
  try {
    assert.equal(await approvalsGroupId(), '120363999@g.us');
    assert.equal(await approvalsTarget(), '120363999@g.us');
  } finally {
    delete process.env.APPROVALS_GROUP;
  }
});

test('APPROVALS_GROUP con espacios alrededor → se normaliza (trim)', async () => {
  process.env.APPROVALS_GROUP = '  120363999@g.us  ';
  try {
    assert.equal(await approvalsGroupId(), '120363999@g.us');
  } finally {
    delete process.env.APPROVALS_GROUP;
  }
});

test('APPROVALS_GROUP vacío/espacios → null (fallback)', async () => {
  process.env.APPROVALS_GROUP = '   ';
  try {
    assert.equal(await approvalsGroupId(), null);
    assert.equal(await approvalsTarget(), '111@lid');
  } finally {
    delete process.env.APPROVALS_GROUP;
  }
});
