// src/hubspot/setteo.js
// Lógica PURA del conteo de setteos por closer (sin red, sin DB → testeable en Windows,
// como deals.js). El fetch a HubSpot (contactos tocados, deals para el discriminador) vive
// en client.js; la orquestación (ventana, envío) en scheduler/setteo.js.
//
// Qué mide: cuántos LEADS distintos tocó cada closer en la ventana, SIN contar los que ya
// son leads de call (los que tienen una cita agendada — esos los mide el Push 4 / la cosecha
// por agenda_status). "1 lead tocado = 1 setteo": un contacto con actividad de contacto
// registrada cuenta UNA vez, sin importar cuántos mensajes (regla del training S3 "una
// interacción por día por canal"). Es un conteo de setteos REGISTRADOS en HubSpot, no reales:
// si el closer no registra la actividad, acá se ve 0 — por diseño también mide disciplina de
// registro (audit S3: 156/193 calls sin marcación).
//
// Atribución: por el DUEÑO del contacto en HubSpot (hubspot_owner_id → email → roster). Es un
// proxy: notes_last_contacted dice CUÁNDO se tocó, no QUIÉN lo registró; si el que setea no es
// el owner, se descuadra. Aceptable para v1. Un owner que NO está en el roster de closers va al
// bucket `sinMapear` (visible, nunca descartado en silencio — mismo criterio que "closers sin
// mapear" en commands.js).

import { resolveCloser, isIgnoredCloser } from '../calendly/closers.js';

// Consolida los contactos tocados (ya anotados por la capa impura con su `esCall`) en el conteo
// por closer. `contacts` = [{ ownerId, esCall }]. `ownerEmailMap` = { ownerId → email }.
// Devuelve { porCloser: [{ name, setteos }] (desc), sinMapear: N, ignorados: N, calls: N }.
//   · esCall true  → es lead de call, NO cuenta como setteo (pero se totaliza en `calls`).
//   · owner ignorado (isIgnoredCloser) → `ignorados`, no se muestra.
//   · owner sin entrada en el roster    → `sinMapear`.
export function aggregateSetteos(contacts = [], ownerEmailMap = {}) {
  const byCloser = new Map(); // name → setteos
  let sinMapear = 0;
  let ignorados = 0;
  let calls = 0;

  for (const c of contacts) {
    if (c.esCall) {
      calls++;
      continue;
    }
    const email = ownerEmailMap[String(c.ownerId)] || null;
    if (email && isIgnoredCloser(email)) {
      ignorados++;
      continue;
    }
    const closer = email ? resolveCloser(email) : null;
    if (!closer) {
      sinMapear++;
      continue;
    }
    byCloser.set(closer.name, (byCloser.get(closer.name) || 0) + 1);
  }

  const porCloser = [...byCloser.entries()]
    .map(([name, setteos]) => ({ name, setteos }))
    .sort((a, b) => b.setteos - a.setteos || a.name.localeCompare(b.name));

  return { porCloser, sinMapear, ignorados, calls };
}

const plural = (n, sing, plu = sing + 's') => (n === 1 ? sing : plu);

// Formatea el bloque de setteo para el DM del jefe. Devuelve el texto, o `null` si no hubo
// NINGÚN setteo mapeado (nada útil que reportar → el reporte del jefe queda igual que hoy).
export function formatSetteoBlock(agg, { dateLabel = 'hoy' } = {}) {
  const { porCloser = [], sinMapear = 0 } = agg || {};
  if (!porCloser.length && !sinMapear) return null;

  const total = porCloser.reduce((a, x) => a + x.setteos, 0);
  const head = `🧲 *Setteo (backlog) — ${dateLabel}*\n${total} ${plural(total, 'setteo')}`;

  const lines = porCloser.map((s) => `   • *${s.name}* — ${s.setteos} ${plural(s.setteos, 'setteo')}`);
  if (sinMapear) lines.push(`   • _sin mapear_ — ${sinMapear}`);

  const footer =
    `\n\n_Leads tocados sin cita agendada, por dueño en HubSpot. ` +
    `Mide el registro de la gestión, no el esfuerzo real._`;

  return `${head}\n${lines.join('\n')}${footer}`;
}
