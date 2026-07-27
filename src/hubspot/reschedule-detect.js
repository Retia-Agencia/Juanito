// src/hubspot/reschedule-detect.js
// PURO (sin red, sin DB → testeable en Windows). Detecta la reagenda hecha DENTRO del CRM:
// la que nadie avisa y que hoy deja un push rancio.
//
// Por qué existe (2026-07-29): reagendar en HubSpot NO mueve la hora del meeting, CREA UNO
// NUEVO y deja el viejo intacto con su hora original (medido: 8 de 10 casos). Así que la call
// vieja se queda con su Push 3 —"tu call con X arranca en 25 min"— para algo que no va a pasar,
// y con su Push 4 preguntando cómo fue una llamada que nunca ocurrió, lo que además ensucia los
// outcomes y el reporte del jefe. Backtest sobre 21 días: ~4 pushes rancios por semana.
//
// ⚠️ ACÁ EL RIESGO SE DA VUELTA. En agenda-poll.js el peligro es mandar dos pushes; acá el
// peligro es CANCELAR el push de una call que sí va a ocurrir — el closer llega en frío a una
// llamada real. Por eso la regla se eligió con el dato en la mano y no por intuición.
//
// La medición que la fijó (21 días, 647 calls de closer, pares del MISMO contacto y programa
// con distinta hora, la nueva creada antes de que arrancara la vieja):
//
//   gap entre createdate(vieja) y createdate(nueva) │ n  │ outcome de la VIEJA
//   ────────────────────────────────────────────────┼────┼──────────────────────────────
//   < 1 min   (misma tanda de booking)              │ 19 │ 5 COMPLETED ← calls REALES
//   1-10 min                                        │  1 │ 1 NO_SHOW   ← la hora llegó
//   ≥ 10 min                                        │ 13 │ 7 SCHEDULED, 6 vacío, 0 COMPLETED
//
// El corte en 10 minutos separa limpio: por encima, NINGUNA de las viejas llegó a completarse
// (firma exacta de una call que no ocurrió); por debajo aparecen pares creados con segundos de
// diferencia —una misma tanda de booking que agenda dos citas reales— y 5 de ellas SÍ se
// completaron. Cancelarlas habría sido el error caro.
//
// Lo que NO sirvió, para que nadie lo reintente:
//   · `hs_meeting_outcome` de la vieja: HubSpot no la marca 'RESCHEDULED' al reagendar. En los
//     13 casos buenos quedó en 'SCHEDULED' o vacía. No es señal.
//   · Diff de hora del mismo `meeting.id`: la hora del meeting viejo NO cambia. No hay diff.

// Clave de identidad de una call: closer + minuto. La MISMA de agenda-poll.js y meetings.js.
export const callKey = (email, callStart) =>
  `${String(email || '').toLowerCase().trim()}|${String(callStart || '').slice(0, 16)}`;

// Minutos que deben separar la creación de las dos citas para que sea una reagenda y no dos
// citas de la misma tanda de booking. Ver la tabla del encabezado antes de bajarlo.
export const MIN_REBOOK_GAP_MIN = 10;

const startMsOf = (call) => Date.parse(`${String(call?.call_start || '').replace(' ', 'T')}Z`);
const createdMsOf = (call) => Date.parse(String(call?.created_at || ''));

// ¿Qué calls con push pendiente quedaron huérfanas porque el lead se reagendó en el CRM?
//   `nuevas`             — citas RECIÉN CREADAS en HubSpot, ya mapeadas a calls de closer y con
//                          `contact_id` pegado ({ meeting_id, contact_id, closer_email, program,
//                          call_start, created_at, prospect_name }).
//   `siblingsByContact`  — { contact_id: [calls del mismo lead] }, incluida la nueva.
// Devuelve { superseded: [{ vieja, nueva, gapMin }], skipped } — `skipped` es para el log: un
// descarte mudo acá es indistinguible de un bug.
export function pickRescheduledAway({
  nuevas = [],
  siblingsByContact = {},
  nowMs = Date.now(),
  minGapMin = MIN_REBOOK_GAP_MIN,
} = {}) {
  const superseded = [];
  const yaVistas = new Set(); // dedup: HubSpot guarda varios registros de la MISMA call vieja
  const skipped = { mismoMinuto: 0, otroPrograma: 0, mismaTanda: 0, yaArranco: 0, nuevaEnPasado: 0 };

  for (const nueva of nuevas) {
    const nuevaStart = startMsOf(nueva);
    const nuevaCreated = createdMsOf(nueva);
    if (!Number.isFinite(nuevaStart) || !Number.isFinite(nuevaCreated)) continue;

    // La cita nueva tiene que ser una cita FUTURA. Si no, es un registro de algo que ya pasó
    // (un closer dejando constancia de una call vieja) y no reemplaza nada: sin este guardarraíl,
    // registrar a mano una llamada de ayer le mataría el push a la call real de mañana.
    if (nuevaStart <= nowMs) {
      skipped.nuevaEnPasado++;
      continue;
    }

    for (const vieja of siblingsByContact[nueva.contact_id] || []) {
      if (String(vieja.meeting_id) === String(nueva.meeting_id)) continue;

      if (vieja.program !== nueva.program) {
        skipped.otroPrograma++; // otro programa = otra conversación, no una movida
        continue;
      }
      if (String(vieja.call_start).slice(0, 16) === String(nueva.call_start).slice(0, 16)) {
        skipped.mismoMinuto++; // duplicado de registro, no reagenda
        continue;
      }

      const viejaStart = startMsOf(vieja);
      const viejaCreated = createdMsOf(vieja);
      if (!Number.isFinite(viejaStart) || !Number.isFinite(viejaCreated)) continue;

      // Si la vieja ya arrancó, su push ya salió y salió BIEN: esto es un rebook post-call
      // (no-show → se vuelve a agendar), que es sano y no hay nada que cancelar. En el backtest
      // son 39 de 72 pares: la mayoría de las "reagendas" son de este tipo.
      if (viejaStart <= nowMs) {
        skipped.yaArranco++;
        continue;
      }

      const gapMin = (nuevaCreated - viejaCreated) / 60000;
      if (!(gapMin >= minGapMin)) {
        skipped.mismaTanda++; // creadas juntas → las DOS son citas reales (ver tabla del header)
        continue;
      }

      const key = callKey(vieja.closer_email, vieja.call_start);
      if (yaVistas.has(key)) continue;
      yaVistas.add(key);
      superseded.push({ vieja, nueva, gapMin: Math.round(gapMin) });
    }
  }

  superseded.sort((a, b) => String(a.vieja.call_start).localeCompare(String(b.vieja.call_start)));
  return { superseded, skipped };
}
