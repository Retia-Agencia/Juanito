// src/setteo/cuota.js
// PURO (sin red ni DB → testeable en Windows). Calcula la cuota de setteo del día:
// horas libres × leads por hora.
//
// La regla es del *Protocolo Máquina de Ventas* (2026-06-10) y del *Refuerzo* (2026-06-19):
// **15 leads por HORA LIBRE**, no 15 al día. Hora libre = hora de la jornada sin una call
// agendada encima. Por eso la cuota NO es un número fijo: un closer con la agenda llena tiene
// una cuota chica y eso es correcto — ya está produciendo en las calls.
//
// ⚠️ Dos correcciones que la aritmética ingenua se come:
//  1. Las DOBLES RESERVAS son reales (§18.AU: de 14 colisiones en 2 meses, 8 eran dos leads
//     distintos en el mismo slot). Dos calls solapadas ocupan UNA hora, no dos — sumar
//     duraciones a secas le inventaría al closer horas ocupadas que no existen y le bajaría
//     la cuota sin razón.
//  2. Una call fuera de la jornada (7am, 8pm) no consume hora libre de la jornada. Se recorta
//     al rango, no se descarta: una call de 16:30 a 17:30 ocupa media hora útil.

const TZ = () => process.env.TZ || 'America/Bogota';

export const JORNADA_INICIO = () => Number(process.env.SETTEO_JORNADA_INICIO ?? 8);
export const JORNADA_FIN = () => Number(process.env.SETTEO_JORNADA_FIN ?? 17);
export const MINUTOS_POR_CALL = () => Number(process.env.SETTEO_MINUTOS_POR_CALL ?? 60);
export const CUOTA_POR_HORA = () => Number(process.env.SETTEO_CUOTA_POR_HORA ?? 15);

// Hora local del día (float: 14.5 = 14:30) de un instante UTC 'YYYY-MM-DD HH:MM:SS'.
// Devuelve null si la call cae en OTRO día local que el pedido — una call de las 23:00 del
// día anterior no puede descontarle horas a hoy.
export function horaLocalDe(callStartUtc, fecha, tz = TZ()) {
  if (!callStartUtc) return null;
  // El formato de la DB es UTC sin sufijo; sin la 'Z' explícita, Date lo leería como hora local.
  const iso = String(callStartUtc).trim().replace(' ', 'T');
  const d = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return null;

  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
    .formatToParts(d)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});

  const diaLocal = `${p.year}-${p.month}-${p.day}`;
  if (fecha && diaLocal !== fecha) return null;
  // 'en-CA' con hour12:false puede devolver '24' para la medianoche.
  const hh = Number(p.hour) % 24;
  return hh + Number(p.minute) / 60;
}

// Une intervalos solapados y devuelve las horas totales cubiertas dentro de [inicio, fin].
// `intervalos`: [{ desde, hasta }] en horas float. Exportada para poder testear el solape solo.
export function horasCubiertas(intervalos, inicio, fin) {
  const clip = intervalos
    .map(({ desde, hasta }) => ({ desde: Math.max(desde, inicio), hasta: Math.min(hasta, fin) }))
    .filter((i) => i.hasta > i.desde)
    .sort((a, b) => a.desde - b.desde);

  let total = 0;
  let curDesde = null;
  let curHasta = null;
  for (const i of clip) {
    if (curHasta === null || i.desde > curHasta) {
      if (curHasta !== null) total += curHasta - curDesde;
      curDesde = i.desde;
      curHasta = i.hasta;
    } else {
      curHasta = Math.max(curHasta, i.hasta); // solapada: extiende, no suma
    }
  }
  if (curHasta !== null) total += curHasta - curDesde;
  return total;
}

// Cuota del día para UN closer.
//   calls: filas con { call_start } (UTC) — ya filtradas por closer y por día.
// Devuelve { horasJornada, horasOcupadas, horasLibres, cuota, callsEnJornada, callsFuera }.
export function calcularCuota({
  calls = [],
  fecha,
  tz = TZ(),
  inicio = JORNADA_INICIO(),
  fin = JORNADA_FIN(),
  minutosPorCall = MINUTOS_POR_CALL(),
  porHora = CUOTA_POR_HORA(),
} = {}) {
  const dur = minutosPorCall / 60;
  const intervalos = [];
  let callsFuera = 0;

  for (const c of calls) {
    const h = horaLocalDe(c.call_start ?? c.callStart ?? c, fecha, tz);
    if (h === null) continue;
    const desde = h;
    const hasta = h + dur;
    // Totalmente fuera de la jornada → no consume hora libre, pero se cuenta para poder
    // explicarle al closer por qué su cuota no bajó.
    if (hasta <= inicio || desde >= fin) {
      callsFuera++;
      continue;
    }
    intervalos.push({ desde, hasta });
  }

  const horasJornada = Math.max(0, fin - inicio);
  const horasOcupadas = horasCubiertas(intervalos, inicio, fin);
  const horasLibres = Math.max(0, horasJornada - horasOcupadas);

  return {
    horasJornada,
    horasOcupadas: Math.round(horasOcupadas * 100) / 100,
    horasLibres: Math.round(horasLibres * 100) / 100,
    cuota: Math.round(horasLibres * porHora),
    callsEnJornada: intervalos.length,
    callsFuera,
  };
}
