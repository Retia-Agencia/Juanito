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
//
// `reportado` (opcional, §18.AZ): { nombre del closer → nº de setteos que ÉL reportó por
// WhatsApp }. Cuando viene, cada línea muestra las dos cifras y la BRECHA. Esa brecha es la
// señal que hoy no existe en ningún lado: quién está gestionando sin registrar en el CRM.
//
// ⚠️ La brecha es AMBIGUA por naturaleza y se presenta como pregunta, no como veredicto: o el
// closer no registró en HubSpot, o no hizo el trabajo que dice. Juanito no puede distinguirlo
// (nunca escribe en HubSpot ni ve los mensajes del closer), así que no lo afirma. Decir
// "Fulano no registra" sobre un dato que también admite "Fulano infla" sería fabricar una
// conclusión que el dato no sostiene, y esto va al DM del jefe.
export function formatSetteoBlock(agg, { dateLabel = 'hoy', reportado = null } = {}) {
  const { porCloser = [], sinMapear = 0 } = agg || {};
  const conReporte = reportado ? Object.entries(reportado).filter(([, n]) => n > 0) : [];
  if (!porCloser.length && !sinMapear && !conReporte.length) return null;

  const total = porCloser.reduce((a, x) => a + x.setteos, 0);
  const head = `🧲 *Setteo (backlog) — ${dateLabel}*\n${total} ${plural(total, 'setteo')} en HubSpot`;

  // Todos los closers que aparecen en cualquiera de las dos fuentes. Un closer que reportó
  // por WhatsApp y NO registró nada en HubSpot es justo el caso que hay que ver, así que no
  // puede quedarse fuera por no estar en el agregado del CRM.
  const nombres = [...new Set([...porCloser.map((s) => s.name), ...conReporte.map(([n]) => n)])];
  const enHubspot = Object.fromEntries(porCloser.map((s) => [s.name, s.setteos]));

  const lines = nombres
    .map((name) => ({ name, hs: enHubspot[name] || 0, rep: reportado?.[name] ?? null }))
    .sort((a, b) => Math.max(b.hs, b.rep || 0) - Math.max(a.hs, a.rep || 0) || a.name.localeCompare(b.name))
    .map(({ name, hs, rep }) => {
      if (rep === null) return `   • *${name}* — ${hs} ${plural(hs, 'setteo')}`;
      const brecha = rep - hs;
      const marca = brecha > 0 ? `  ⚠️ ${brecha} sin registrar` : '';
      return `   • *${name}* — ${rep} ${plural(rep, 'reportado')} / ${hs} en HubSpot${marca}`;
    });
  if (sinMapear) lines.push(`   • _sin mapear_ — ${sinMapear}`);

  const footer = reportado
    ? `\n\n_"Reportados" = lo que el closer le contó a Juanito. "En HubSpot" = lo que quedó ` +
      `registrado, que es de lo que dependen las comisiones. La diferencia puede ser gestión sin ` +
      `registrar o reporte inflado: el dato no distingue._`
    : `\n\n_Leads tocados sin cita agendada, por dueño en HubSpot. ` +
      `Mide el registro de la gestión, no el esfuerzo real._`;

  return `${head}\n${lines.join('\n')}${footer}`;
}
