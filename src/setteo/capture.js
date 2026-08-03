// src/setteo/capture.js
// Capa IMPURA de la captura de setteo (§18.AV): resuelve al closer, decide si el mensaje es
// un reporte de setteo, lo cruza con HubSpot y lo guarda. La lógica pura vive en parse.js
// (qué dijo) y cuota.js (cuánto le tocaba).
//
// Se invoca desde src/index.js para DMs que NO son del jefe, DESPUÉS de captureOutcomeReply
// (si hay un Push 4 abierto, ese mensaje es su respuesta y tiene prioridad) y ANTES de
// handleCloserOptin (que devuelve true para cualquier mensaje de un closer conocido y se
// tragaría el reporte).
//
// Orden de intentos, igual que el Push 4 con las reagendas: regex primero, IA solo si el
// regex no entendió. Si ninguno entiende, NO consume el mensaje (devuelve false) y el flujo
// normal sigue — el closer no queda atrapado en un modo "setteo" del que no puede salir.
//
// ⚠️ Juanito NUNCA escribe en HubSpot (decisión 2026-07-20). Acá solo se LEE, para cruzar.

import { closerOf } from '../common/roles.js';
import { parseSetteoReply, localDateISO } from './parse.js';
import { parseSetteoWithAi } from './setteo-ai.js';
import { isCloserInScope, buildConfirmacion, buildPedirNombres } from './format.js';
import { upsertSetteo, markIfNew } from '../db/index.js';
import { isEnabled as hubspotEnabled, searchContactsByName, contactHasScheduledDeal } from '../hubspot/client.js';
import { sendMessage } from '../whatsapp/index.js';

const ENABLED = () => process.env.SETTEO_CAPTURE_ENABLED === 'true';

// Gate maestro (§18.AV). Lo consulta también el router para decidir si un closer entra a su
// contexto agéntico: con la feature apagada, un closer ve EXACTAMENTE lo de hoy.
export function isSetteoCaptureOn() {
  return ENABLED();
}

// Cruce con HubSpot de UN lead. Nunca lanza: si el CRM está apagado o falla, se guarda igual
// con match 'skipped' — perder el setteo por un problema del CRM sería el peor resultado.
// Devuelve { hubspotMatch, hubspotContactId, esCall }.
async function cruzarConHubspot(leadName) {
  if (!hubspotEnabled()) return { hubspotMatch: 'skipped', hubspotContactId: null, esCall: 0 };
  try {
    const candidatos = await searchContactsByName(leadName);
    if (!candidatos.length) return { hubspotMatch: 'none', hubspotContactId: null, esCall: 0 };
    if (candidatos.length > 1) {
      // Homónimos: NO se elige uno al azar. Se guarda como ambiguo y se muestra — descartar
      // en silencio es el error que este repo ya evita en `sinMapear` (hubspot/setteo.js).
      return { hubspotMatch: 'ambiguous', hubspotContactId: null, esCall: 0 };
    }
    const id = candidatos[0].id;
    const esCall = (await contactHasScheduledDeal(id)) ? 1 : 0;
    return { hubspotMatch: 'exact', hubspotContactId: String(id), esCall };
  } catch (e) {
    console.warn(`[Setteo] cruce con HubSpot de "${leadName}" falló: ${e.message}`);
    return { hubspotMatch: 'skipped', hubspotContactId: null, esCall: 0 };
  }
}

// Guarda los items ya parseados. Exportada porque la usan las dos entradas: este módulo
// (texto libre / comando) y la tool `registrar_setteo` del closer agéntico.
// Devuelve { guardados, calls, ambiguos, sinMatch, nombres }.
export async function guardarSetteos({ closer, fecha, items, rawReply = null, source = 'libre' }) {
  const res = { guardados: 0, calls: 0, ambiguos: 0, sinMatch: 0, nombres: [] };

  for (const it of items) {
    const cruce = await cruzarConHubspot(it.leadName);
    upsertSetteo({
      closerEmail: closer.email,
      closerPhone: closer.phone,
      closerName: closer.name,
      leadName: it.leadName,
      leadNorm: it.leadNorm,
      fecha,
      contesto: it.contesto,
      agendo: it.agendo,
      vendio: it.vendio,
      rawReply,
      source,
      ...cruce,
    });
    res.guardados++;
    res.nombres.push(it.leadName);
    if (cruce.esCall) res.calls++;
    if (cruce.hubspotMatch === 'ambiguous') res.ambiguos++;
    if (cruce.hubspotMatch === 'none') res.sinMatch++;
  }
  return res;
}

// Devuelve true si el mensaje era un reporte de setteo (y lo manejó).
export async function captureSetteoReply({ from, pushName, text, messageId }) {
  if (!ENABLED()) return false;

  // La identidad SIEMPRE sale del JID de quien escribe, nunca del texto: es lo que impide
  // que alguien registre setteos a nombre de otro closer.
  const closer = closerOf(from);
  if (!closer) return false;
  if (!isCloserInScope(closer.email)) return false;

  let parsed = parseSetteoReply(text);
  // 'agregado' = dijo cuántos pero no quiénes. Se le piden los nombres en vez de inventar
  // filas para cuadrar el número (la tabla es una fila por lead y el cruce necesita nombre).
  if (parsed.kind === 'agregado') {
    if (messageId && !markIfNew(messageId)) return true;
    await sendMessage(from, buildPedirNombres(parsed.conteo)).catch(() => {});
    return true;
  }

  if (parsed.kind === 'none') {
    parsed = await parseSetteoWithAi(text);
    if (parsed.kind !== 'setteos') return false; // no era un setteo → sigue el flujo normal
  }

  if (messageId && !markIfNew(messageId)) return true;

  try {
    const resultado = await guardarSetteos({
      closer,
      fecha: parsed.fecha,
      items: parsed.items,
      rawReply: text,
      source: parsed.source || 'libre',
    });
    console.log(
      `[Setteo] ${closer.name}: ${resultado.guardados} setteo(s) el ${parsed.fecha} ` +
        `(calls: ${resultado.calls}, ambiguos: ${resultado.ambiguos}, sin match: ${resultado.sinMatch})`
    );
    await sendMessage(
      from,
      buildConfirmacion({ fecha: parsed.fecha, items: parsed.items, resultado, hoy: localDateISO() })
    ).catch(() => {});
  } catch (e) {
    console.error('[Setteo] no se pudo guardar:', e.message);
    // Fallar en silencio sería peor que no tener la feature: el closer creería que quedó
    // registrado. Se le dice, y el mensaje crudo queda en el log para recuperarlo.
    await sendMessage(from, 'Uy, no pude guardar eso 😖. Volvé a mandármelo en un momento.').catch(() => {});
  }
  return true;
}
