// src/common/approval-routing.js
// Ruteo del flujo de APROBACIONES. Por defecto las aprobaciones (borradores recurrentes
// §18.F, respuestas de grupo §18.O y respuestas a DMs de desconocidos §18.J) se envían al
// DM del jefe. Si se configura APPROVALS_GROUP, se redirigen a ese GRUPO ("Aprobaciones
// Juanito"), donde el jefe/admin las gestionan sin mención (ver handleApprovalConsole).
//
// APPROVALS_GROUP puede ser un group_id (…@g.us, comparación O(1) sin socket) o el NOMBRE
// del grupo (se resuelve en runtime vía resolveGroupByName, importado de forma perezosa para
// no arrastrar Baileys en los tests). Sin APPROVALS_GROUP o si no resuelve → DM del jefe.

import { bossDmTarget } from './roles.js';

const RAW = () => (process.env.APPROVALS_GROUP || '').trim();

// group_id del grupo de aprobaciones, o null si no está configurado / no resuelve.
// El router lo usa para detectar mensajes que llegan EN ese grupo.
export async function approvalsGroupId() {
  const t = RAW();
  if (!t) return null;
  if (t.endsWith('@g.us')) return t;
  try {
    // Import perezoso: solo cuando hay que resolver por nombre (necesita el socket).
    const { resolveGroupByName } = await import('../whatsapp/index.js');
    const g = await resolveGroupByName(t);
    return g?.id || null;
  } catch {
    return null;
  }
}

// Destino al que mandar las solicitudes de aprobación: el grupo si está configurado y
// resuelve, o el DM del jefe como fallback seguro (comportamiento previo).
export async function approvalsTarget() {
  return (await approvalsGroupId()) || bossDmTarget();
}
