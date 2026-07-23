// src/scheduler/setteo.js
// Capa IMPURA del conteo de setteos: resuelve la ventana + el scope de closers, consulta HubSpot
// en vivo (owners, contactos tocados, deals para el discriminador) y arma el bloque. La lógica
// pura (agregación + formato) vive en hubspot/setteo.js.
//
// Gate (decisión del jefe, análogo a BOSS_REPORT_ENABLED): el bloque de setteo NO se anexa al
// reporte del jefe salvo que SETTEO_REPORT_ENABLED=true. El comando on-demand `/setteos` corre
// SIEMPRE (lo pide un admin explícitamente), igual que `/reportejefe` funciona con el cron off.
//
// Scope piloto: SETTEO_REPORT_CLOSERS (CSV de emails). Default = el scope del nudge
// (CALENDLY_PUSH4_CLOSERS) → arrancamos acotados a Sebastian, como todo lo de HubSpot. Si no hay
// scope configurado, no se consulta nada (no fan-out sorpresa a todo el equipo).

import { getOwnerEmailMap, searchTouchedContacts, contactHasScheduledDeal } from '../hubspot/client.js';
import { aggregateSetteos, formatSetteoBlock } from '../hubspot/setteo.js';
import { dayRangeUtc } from '../calendly/index.js';

const TZ = () => process.env.TZ || 'America/Bogota';

export function isSetteoReportEnabled() {
  return process.env.SETTEO_REPORT_ENABLED === 'true';
}

// Emails del scope (minúsculas). Default = scope del nudge. [] si ninguno configurado.
function scopeEmails() {
  const raw = process.env.SETTEO_REPORT_CLOSERS || process.env.CALENDLY_PUSH4_CLOSERS || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function dateLabel(now) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: TZ(), weekday: 'short', day: 'numeric', month: 'short' }).format(now);
}

// Core (SIN gate): consulta HubSpot y devuelve el texto del bloque, o null si no hay setteos /
// no hay scope / HubSpot está apagado. Lo usa `/setteos` on-demand y (tras el gate) el reporte
// del jefe. `daysBack`: 0 = hoy.
export async function buildSetteoBlock({ now = new Date(), daysBack = 0 } = {}) {
  const emails = scopeEmails();
  if (!emails.length) return null;

  const ownerEmailMap = await getOwnerEmailMap();
  if (!Object.keys(ownerEmailMap).length) return null;

  // email → ownerId (invertir el mapa) y quedarnos con los owners del scope.
  const emailToOwner = {};
  for (const [ownerId, email] of Object.entries(ownerEmailMap)) emailToOwner[email] = ownerId;
  const ownerIds = emails.map((e) => emailToOwner[e]).filter(Boolean);
  if (!ownerIds.length) return null;

  const { minStartIso, maxStartIso } = dayRangeUtc(TZ(), daysBack, now);

  // Contactos tocados de cada owner del scope + discriminador esCall (¿tiene deal con cita?).
  const annotated = [];
  for (const ownerId of ownerIds) {
    const touched = await searchTouchedContacts({ ownerId, sinceIso: minStartIso, untilIso: maxStartIso });
    for (const c of touched) {
      const esCall = await contactHasScheduledDeal(c.id);
      annotated.push({ ownerId: c.ownerId, esCall });
    }
  }

  const agg = aggregateSetteos(annotated, ownerEmailMap);
  return formatSetteoBlock(agg, { dateLabel: dateLabel(now) });
}
