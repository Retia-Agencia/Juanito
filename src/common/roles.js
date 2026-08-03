// src/common/roles.js
// Fuente única de verdad para los roles de quien le escribe a Juanito.
//
// Modelo de "baby proofing": el jefe (dueño no-técnico) se siente dueño pero
// está sandboxed; el equipo (admins) tiene el control real. Ver docs/LID-ADMIN-HANDOFF.md.
//
//   admin   → equipo dev. Máximo privilegio (todas las tools, diagnósticos).
//   boss    → el jefe. Privilegio acotado (no toca tools sensibles ni config).
//   closer  → alguien del roster de ventas. Privilegio MÍNIMO y acotado a LO SUYO:
//             registra y consulta su propio setteo, nada más (§18.AV). No es privilegiado.
//   unknown → cualquier otro (desconocidos).

import { phonesMatch } from './utils.js';
import { resolveCloserByPhone, resolveCloserByLid } from '../calendly/closers.js';

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

  // Jefe por LID EXPLÍCITO (el retrocompat va más abajo, después de los closers).
  const bossLid = BOSS_LID();
  if (isLid && bossLid && sender === bossLid) return 'boss';

  // Closer del roster. Va DESPUÉS del jefe/admin (nadie del equipo pierde su rol por
  // estar también en el roster) y ANTES del retrocompat de abajo: si no, en un despliegue
  // sin BOSS_LID configurado TODOS los closers serían "boss" y verían las tools del jefe.
  if (isCloser(sender)) return 'closer';

  // Retrocompat: cualquier @lid es el jefe si BOSS_LID no está configurado todavía.
  // Con tiering de capacidades, "ser jefe por defecto" ya no es catastrófico: el jefe
  // está sandboxed. Los closers ya salieron arriba, así que este fallback no los toca.
  if (isLid && !bossLid) return 'boss';

  return 'unknown';
}

// ¿Este sender es un closer del roster? Resuelve por teléfono o por LID de trabajo
// (CLOSER_LIDS). NO usa pushName: el nombre de WhatsApp lo elige quien escribe, así que
// un desconocido podría llamarse "Pablo Lozano" y heredar el rol. El pushName sirve para
// el opt-in (donde el peor caso es no registrar a nadie), no para dar privilegios.
export function isCloser(sender) {
  if (!sender) return false;
  return Boolean(resolveCloserByPhone(sender) || resolveCloserByLid(sender));
}

// El closer detrás de un sender: { email, name, phone } | null. Fuente ÚNICA de la
// identidad del closer para todo lo de setteo — el email SIEMPRE sale de acá (del JID de
// quien escribe), NUNCA del texto del mensaje ni de un argumento del comando. Es lo que
// impide que un closer consulte o registre setteos a nombre de otro.
export function closerOf(sender) {
  if (!sender) return null;
  return resolveCloserByPhone(sender) || resolveCloserByLid(sender) || null;
}

// ¿Tiene acceso al flujo de "jefe" (DM atendido por Claude)?
export function isPrivileged(role) {
  return role === 'admin' || role === 'boss';
}

// Privilegio ESTRICTO para acciones desde un GRUPO (órdenes del jefe en el chat del grupo).
// A diferencia de roleOf(), NO usa el fallback retrocompat "cualquier @lid = jefe": en un
// grupo TODOS los participantes llegan como @lid, así que ese fallback convertiría a todo el
// grupo en jefe. Aquí exigimos identidad CONFIGURADA explícitamente:
//   - LID en ADMIN_LID, o
//   - BOSS_LID definido y el sender es EXACTAMENTE ese LID, o
//   - el teléfono canónico del jefe (BOSS_PHONE).
// Si no hay BOSS_LID/ADMIN_LID/BOSS_PHONE configurados, devuelve false → la feature de
// órdenes-en-grupo queda apagada de forma segura.
export function isStrictPrivileged(sender) {
  if (!sender) return false;
  const isLid = sender.endsWith('@lid');
  if (isLid && ADMIN_LIDS().includes(sender)) return true;
  const bossLid = BOSS_LID();
  if (isLid && bossLid && sender === bossLid) return true;
  if (phonesMatch(sender, BOSS_PHONE())) return true;
  return false;
}

// Destinatario para los DMs que el SISTEMA le manda al jefe (aprobación de
// borradores, recordatorios sin destinatario explícito). Prefiere BOSS_LID: en
// WhatsApp multi-device el jefe interactúa por @lid, y enviar a un @lid funciona
// (los digests de Calendly ya entregan a LIDs). Cae al teléfono si no hay LID.
// Así, si el jefe sólo está identificado por LID (sin teléfono a mano), igual le
// llegan las aprobaciones. Devuelve null si no hay ninguno configurado.
export function bossDmTarget() {
  return BOSS_LID() || BOSS_PHONE() || null;
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
