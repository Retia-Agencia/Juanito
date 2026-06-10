// src/bot/group-guard.js
// Guardia de autorización de grupos (default-deny anti-secuestro), ROBUSTO:
// no depende solo del evento `group-participants.update` (que NO se re-emite si
// agregaron al bot mientras estaba reiniciando). Aquí la decisión se evalúa
// también al arrancar (barrido) y en cada mensaje de grupo.
//
// SEGURIDAD: el auto-leave puede ser catastrófico si la detección de jefe/admin
// falla (saldría de grupos legítimos). Por eso hay un flag GROUP_AUTOLEAVE:
//   - 'log' (default) → solo registra qué HARÍA (WOULD-LEAVE), no sale de nada.
//   - 'on'            → aplica el auto-leave real.
// Flujo recomendado: deploy en 'log', verificar en logs que los grupos del jefe
// salen como KEEP, y recién ahí poner GROUP_AUTOLEAVE=on.

import { listGroups, getGroupParticipants, leaveGroup } from '../whatsapp/index.js';
import { isGroupAuthorized, authorizeGroup, deauthorizeGroup } from '../db/index.js';
import { roleOf, groupHasPrivilegedMember } from '../common/roles.js';

export const autoleaveMode = () => (process.env.GROUP_AUTOLEAVE || 'log').toLowerCase();

// Evalúa UN grupo y aplica/loggea la decisión.
// Devuelve: 'authorized' (ya estaba) | 'kept' (jefe/admin presente → autorizado)
//           | 'left' (salió) | 'would-leave' (modo log).
export async function enforceGroup(chatId, groupName) {
  if (isGroupAuthorized(chatId)) return 'authorized';

  const participants = await getGroupParticipants(chatId);

  if (groupHasPrivilegedMember(participants)) {
    authorizeGroup({ groupId: chatId, groupName, authorizedBy: 'participant' });
    console.log(`[GroupGuard] KEEP "${groupName}" (${chatId}) — jefe/admin presente`);
    return 'kept';
  }

  // Sin jefe/admin → grupo no autorizado. Volcamos roles para auditar la detección.
  const roleDump = participants.map((p) => `${p}=${roleOf(p)}`).join(', ');
  console.warn(`[GroupGuard] sin jefe/admin en "${groupName}" (${chatId}). Participantes: ${roleDump}`);

  if (autoleaveMode() === 'on') {
    await leaveGroup(chatId).catch((e) => console.error('[GroupGuard] leaveGroup:', e.message));
    console.warn(`[GroupGuard] LEFT "${groupName}" (${chatId})`);
    return 'left';
  }
  console.warn(`[GroupGuard] WOULD-LEAVE "${groupName}" (${chatId}) — modo log (poné GROUP_AUTOLEAVE=on para aplicar)`);
  return 'would-leave';
}

// Re-evaluación SIMÉTRICA (ignora el cache de la tabla): autoriza si hay jefe/admin
// presente, o REVOCA + sale si ya no queda ninguno. La usa el barrido y el evento de
// "se fue un participante" — así el estado del grupo sigue a la presencia del jefe/admin.
// Devuelve 'kept' | 'left' | 'would-leave'.
export async function reevaluateGroup(groupId, groupName) {
  const participants = await getGroupParticipants(groupId);

  if (groupHasPrivilegedMember(participants)) {
    if (!isGroupAuthorized(groupId)) {
      authorizeGroup({ groupId, groupName, authorizedBy: 'participant' });
      console.log(`[GroupGuard] KEEP "${groupName}" (${groupId}) — jefe/admin presente`);
    }
    return 'kept';
  }

  // Ya no hay jefe/admin → revocar autorización previa (si la había).
  if (isGroupAuthorized(groupId)) {
    deauthorizeGroup(groupId);
    console.warn(`[GroupGuard] REVOKE "${groupName}" (${groupId}) — ya no hay jefe/admin`);
  }
  const roleDump = participants.map((p) => `${p}=${roleOf(p)}`).join(', ');
  console.warn(`[GroupGuard] sin jefe/admin en "${groupName}" (${groupId}). Participantes: ${roleDump}`);

  if (autoleaveMode() === 'on') {
    await leaveGroup(groupId).catch((e) => console.error('[GroupGuard] leaveGroup:', e.message));
    console.warn(`[GroupGuard] LEFT "${groupName}" (${groupId})`);
    return 'left';
  }
  console.warn(`[GroupGuard] WOULD-LEAVE "${groupName}" (${groupId}) — modo log (poné GROUP_AUTOLEAVE=on)`);
  return 'would-leave';
}

// El bot fue removido (o salió) de un grupo → limpiar su autorización en DB.
export function onSelfRemoved(groupId) {
  if (deauthorizeGroup(groupId)) {
    console.log(`[GroupGuard] Removido del grupo ${groupId} — autorización limpiada`);
  }
}

// Barrido al arrancar: re-valida TODOS los grupos (autoriza/revoca según presencia).
// Cubre cambios ocurridos mientras el bot estaba caído (Baileys no re-emite esos
// eventos al reconectar). Auto-sanador: deja el estado consistente en cada arranque.
export async function sweepGroups() {
  try {
    const groups = await listGroups();
    console.log(`[GroupGuard] Barrido de ${groups.length} grupos (GROUP_AUTOLEAVE=${autoleaveMode()})`);
    for (const g of groups) {
      try {
        await reevaluateGroup(g.id, g.name);
      } catch (e) {
        console.error(`[GroupGuard] error evaluando "${g.name}":`, e.message);
      }
    }
    console.log('[GroupGuard] Barrido terminado');
  } catch (e) {
    console.error('[GroupGuard] no se pudo listar grupos para el barrido:', e.message);
  }
}
