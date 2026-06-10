// src/common/roles.js
// Fuente única de verdad para los roles de quien le escribe a Juanito.
//
// Modelo de "baby proofing": el jefe (dueño no-técnico) se siente dueño pero
// está sandboxed; el equipo (admins) tiene el control real. Ver docs/LID-ADMIN-HANDOFF.md.
//
//   admin   → equipo dev. Máximo privilegio (todas las tools, diagnósticos).
//   boss    → el jefe. Privilegio acotado (no toca tools sensibles ni config).
//   unknown → cualquier otro (closers, desconocidos). No llega a este flujo como jefe.

import { phonesMatch } from './utils.js';

const BOSS_PHONE = () => process.env.BOSS_PHONE;
const BOSS_LID = () => process.env.BOSS_LID;
const ADMIN_LIDS = () =>
  (process.env.ADMIN_LID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Devuelve el rol de un sender (JID de WhatsApp: teléfono@... o <num>@lid).
export function roleOf(sender) {
  if (!sender) return 'unknown';
  const isLid = sender.endsWith('@lid');

  // Admin gana sobre todo: LIDs del equipo configurados en ADMIN_LID.
  // (Un dev de pruebas cuyo LID esté también en BOSS_LID se considera admin.)
  if (isLid && ADMIN_LIDS().includes(sender)) return 'admin';

  // Jefe por su teléfono canónico.
  if (phonesMatch(sender, BOSS_PHONE())) return 'boss';

  // Jefe por LID: su LID específico, o —retrocompat— cualquier @lid si BOSS_LID
  // no está configurado todavía. Con tiering de capacidades, "ser jefe por defecto"
  // ya no es catastrófico: el jefe está sandboxed.
  const bossLid = BOSS_LID();
  if (isLid && (sender === bossLid || !bossLid)) return 'boss';

  return 'unknown';
}

// ¿Tiene acceso al flujo de "jefe" (DM atendido por Claude)?
export function isPrivileged(role) {
  return role === 'admin' || role === 'boss';
}

// ¿Hay un jefe o admin entre los participantes de un grupo?
// Heurística restart-safe para autorizar grupos: si el dueño o el equipo está
// dentro, el grupo es legítimo aunque no hayamos capturado el evento de "add".
// `participants` admite strings (JIDs/LIDs) u objetos { id, lid, jid }.
export function groupHasPrivilegedMember(participants = []) {
  return participants.some((p) => {
    const ids = typeof p === 'string' ? [p] : [p?.id, p?.lid, p?.jid];
    return ids.filter(Boolean).some((id) => isPrivileged(roleOf(id)));
  });
}
