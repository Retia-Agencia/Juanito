// src/setteo/metricas.js
// Capa IMPURA de `/missetteos` (§18.AV): junta las tres cifras del closer.
//   1. Reportado  → SQLite (lo que le contó a Juanito)
//   2. HubSpot    → el CRM en vivo (lo que quedó REGISTRADO, de lo que dependen las comisiones)
//   3. Cuota      → horas libres × 15 (Protocolo Máquina de Ventas)
// El formato vive en format.js (puro). La cuenta de horas libres, en cuota.js (puro).
//
// Ninguna de las tres puede tumbar a las otras: si HubSpot está caído se muestra "—" y no un
// cero, que le haría creer al closer que no registró nada.

import { localDateISO, shiftDateISO } from './parse.js';
import { calcularCuota } from './cuota.js';
import { formatMisSetteos, formatMisSetteosVacio } from './format.js';
import { summarizeSetteos } from '../db/index.js';
import { countSetteosDeCloser } from '../scheduler/setteo.js';
import { agendaCallsForToday } from '../scheduler/daily-reports.js';

const TZ = () => process.env.TZ || 'America/Bogota';

function dateLabel(now, dias) {
  const d = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ(), weekday: 'short', day: 'numeric', month: 'short',
  }).format(now);
  return dias > 1 ? `últimos ${dias} días` : d;
}

// Calls del closer HOY, de la unión deduplicada Calendly + HubSpot (la misma que la agenda del
// jefe). Best-effort: si falla, se devuelve [] y la cuota sale sobre la jornada completa — se
// prefiere una cuota alta de más a bloquear el comando.
async function callsDelCloser(closer, now) {
  try {
    const todas = await agendaCallsForToday(now, 'cuota de setteo');
    const email = String(closer.email).toLowerCase();
    return todas.filter((c) => String(c.closer_email || '').toLowerCase() === email);
  } catch (e) {
    console.warn(`[Setteo] no pude leer la agenda para la cuota: ${e.message}`);
    return [];
  }
}

// Arma el mensaje de `/missetteos` para UN closer. `dias`: 1 = hoy (default).
// El closer viene de roles.closerOf(sender) — la identidad NUNCA sale del texto del mensaje.
export async function buildMisSetteos({ closer, now = new Date(), dias = 1 } = {}) {
  const hoy = localDateISO(now, TZ());
  const desde = dias > 1 ? shiftDateISO(hoy, -(dias - 1)) : hoy;

  const reportado = summarizeSetteos({ closerEmail: closer.email, desde, hasta: hoy });

  // La cuota es siempre la de HOY: es una meta del día, no acumulable hacia atrás.
  const calls = await callsDelCloser(closer, now);
  const cuota = calcularCuota({ calls, fecha: hoy, tz: TZ() });

  // daysBack de HubSpot es 0 = hoy. Para ventanas más largas no se consulta: el conteo del CRM
  // es por día y sumarlo día a día serían N llamadas a la API por comando.
  const hubspot = dias === 1 ? await countSetteosDeCloser(closer.email, { now, daysBack: 0 }) : null;

  const label = dateLabel(now, dias);
  if (!reportado.total && !reportado.eranCall) {
    return formatMisSetteosVacio({ dateLabel: label, cuota });
  }

  return formatMisSetteos({
    closerName: closer.name,
    dateLabel: label,
    reportado,
    hubspot,
    cuota,
    hoyLabel: dias > 1 ? 'de hoy' : 'del día',
  });
}
