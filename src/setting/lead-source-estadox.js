// src/setting/lead-source-estadox.js
// Fuente de leads del setteo para EstadoX (programa 'abogados'). Lee el Google Sheet
// de postulaciones (§18.B) y separa quién NO agendó llamada.
//
// Señal de "no agendó" = columna I (COL.calendly) vacía — la misma que
// src/sheets/aggregate.js usa para CONTAR bookings; aquí la usamos para ENUMERAR a
// quienes faltan. El teléfono (col B) y el nombre (col A) son PII que el reporte del
// grupo NO lee; el setteo sí los usa porque envía por la Cloud API oficial.
//
// Único archivo del módulo que toca red (vía sheets/client.js). Devuelve:
//   - leads:       filas sin agendar y con teléfono válido (candidatas a enrolar)
//   - bookedByKey: Map lead_key → bool (¿ya agendó?) para el re-check al entregar.

import { fetchLeadRows } from '../sheets/client.js';
import { COL } from '../sheets/columns.js';
import { parseSubmittedAt } from '../sheets/parse.js';
import { validatePhone } from '../common/utils.js';
import { toDialable } from './setting-logic.js';

const PROGRAM = 'abogados';
const isFilled = (v) => v != null && String(v).trim() !== '';

export async function fetchEstadoxLeads({ fetchRows = fetchLeadRows, defaultCc = process.env.SETTING_DEFAULT_CC || '57' } = {}) {
  const rows = await fetchRows();
  const leads = [];
  const bookedByKey = new Map();

  for (const row of rows || []) {
    const v = validatePhone(row?.[COL.phone]);
    if (!v.ok) continue;               // sin teléfono plausible → no es lead marcable
    const lead_key = v.digits;         // dígitos normalizados → clave estable de dedup
    const booked = isFilled(row?.[COL.calendly]);

    // El re-check al entregar necesita saber si ESTE lead ya agendó en CUALQUIER fila
    // (un lead puede tener varias postulaciones). "Agendó" gana sobre "no agendó".
    if (booked) bookedByKey.set(lead_key, true);
    else if (!bookedByKey.has(lead_key)) bookedByKey.set(lead_key, false);

    if (booked) continue;              // ya agendó → no se enrola
    const submittedMs = parseSubmittedAt(row?.[COL.submittedAt]);
    if (submittedMs == null) continue; // sin fecha → no se enrola (la compuerta la maneja igual)

    const to_phone = toDialable(row?.[COL.phone], defaultCc);
    if (!to_phone) continue;

    leads.push({
      program: PROGRAM,
      lead_key,
      to_phone,
      to_name: isFilled(row?.[COL.name]) ? String(row[COL.name]).trim() : null,
      submittedMs,
    });
  }

  return { leads, bookedByKey };
}
