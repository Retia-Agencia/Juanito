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
import { localDateISO, shiftDateISO } from '../setteo/parse.js';

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

// Agregado CRUDO de HubSpot para una lista de emails. Devuelve { agg, ownerEmailMap } o null si
// no se puede consultar (sin scope / sin owners / HubSpot apagado). Separado del formateo para
// que `/missetteos` (§18.AV) pueda pedir el conteo de UN closer sin armar el bloque del jefe.
async function fetchSetteoAgg(emails, { now = new Date(), daysBack = 0 } = {}) {
  if (!emails.length) return null;

  const ownerEmailMap = await getOwnerEmailMap();
  if (!Object.keys(ownerEmailMap).length) return null;

  // email → ownerId (invertir el mapa) y quedarnos con los owners pedidos.
  const emailToOwner = {};
  for (const [ownerId, email] of Object.entries(ownerEmailMap)) emailToOwner[email] = ownerId;
  const ownerIds = emails.map((e) => emailToOwner[e]).filter(Boolean);
  if (!ownerIds.length) return null;

  const { minStartIso, maxStartIso } = dayRangeUtc(TZ(), daysBack, now);

  // Contactos tocados de cada owner + discriminador esCall (¿tiene deal con cita?).
  const annotated = [];
  for (const ownerId of ownerIds) {
    const touched = await searchTouchedContacts({ ownerId, sinceIso: minStartIso, untilIso: maxStartIso });
    for (const c of touched) {
      const esCall = await contactHasScheduledDeal(c.id);
      annotated.push({ ownerId: c.ownerId, esCall });
    }
  }

  return { agg: aggregateSetteos(annotated, ownerEmailMap), ownerEmailMap };
}

// Core (SIN gate): consulta HubSpot y devuelve el texto del bloque, o null si no hay setteos /
// no hay scope / HubSpot está apagado. Lo usa `/setteos` on-demand y (tras el gate) el reporte
// del jefe. `daysBack`: 0 = hoy.
export async function buildSetteoBlock({ now = new Date(), daysBack = 0 } = {}) {
  const r = await fetchSetteoAgg(scopeEmails(), { now, daysBack });

  // Lo que los closers reportaron por WhatsApp (§18.AV). Best-effort: si la tabla no existe
  // todavía o algo falla, el bloque sale como antes (solo HubSpot), nunca se cae.
  let reportado = null;
  try {
    const { setteosByCloser } = await import('../db/index.js');
    const fecha = localDateISO(now, TZ());
    const desde = daysBack ? shiftDateISO(fecha, -daysBack) : fecha;
    const filas = setteosByCloser({ desde, hasta: fecha });
    if (filas.length) {
      reportado = Object.fromEntries(filas.map((f) => [f.closer_name || f.closer_email, f.setteos]));
    }
  } catch (e) {
    console.warn('[Setteo] no pude leer lo reportado por los closers:', e.message);
  }

  // Sin agregado de HubSpot pero CON reportes: igual hay algo que decirle al jefe — de hecho
  // es el caso más informativo (gestión reportada que no llegó al CRM).
  if (!r && !reportado) return null;
  return formatSetteoBlock(r?.agg || { porCloser: [], sinMapear: 0 }, { dateLabel: dateLabel(now), reportado });
}

// Cuántos setteos tiene REGISTRADOS en HubSpot UN closer en el día (§18.AV). Es la segunda de
// las tres cifras de `/missetteos`: mide el registro en el CRM, que es de lo que dependen las
// comisiones, no el esfuerzo real.
// Devuelve un número, o `null` si no se pudo consultar (HubSpot apagado, owner no encontrado,
// API caída). `null` NO es 0: en el mensaje se muestra "no disponible", nunca un cero falso.
export async function countSetteosDeCloser(email, { now = new Date(), daysBack = 0 } = {}) {
  if (!email) return null;
  try {
    const r = await fetchSetteoAgg([String(email).toLowerCase().trim()], { now, daysBack });
    if (!r) return null;
    // El agregado viene por NOMBRE de closer; con un solo owner consultado, la suma es suya.
    return r.agg.porCloser.reduce((a, x) => a + x.setteos, 0);
  } catch (e) {
    console.warn(`[Setteo] conteo de HubSpot para ${email} falló: ${e.message}`);
    return null;
  }
}
