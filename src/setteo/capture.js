// src/setteo/capture.js
// Capa IMPURA de la captura de setteo (§18.AZ): resuelve al closer, decide si el mensaje es
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
import { parseSetteoReply, localDateISO, esCorreccion } from './parse.js';
import { parseSetteoWithAi } from './setteo-ai.js';
import { isCloserInScope, buildConfirmacion, buildPedirNombres } from './format.js';
import { upsertSetteo, markIfNew, saveMessage } from '../db/index.js';
import {
  isEnabled as hubspotEnabled,
  searchContactsByName,
  contactHasScheduledDeal,
  setteableStageIds,
  dealsOfContacts,
  ownerIdForCloser,
} from '../hubspot/client.js';
import { elegirContacto } from './desambiguar.js';
import { sendMessage } from '../whatsapp/index.js';

const ENABLED = () => process.env.SETTEO_CAPTURE_ENABLED === 'true';

// Gate maestro (§18.AZ). Lo consulta también el router para decidir si un closer entra a su
// contexto agéntico: con la feature apagada, un closer ve EXACTAMENTE lo de hoy.
export function isSetteoCaptureOn() {
  return ENABLED();
}

// Cruce con HubSpot de UN lead. Nunca lanza: si el CRM está apagado o falla, se guarda igual
// con match 'skipped' — perder el setteo por un problema del CRM sería el peor resultado.
// Devuelve { hubspotMatch, hubspotContactId, esCall }.
async function cruzarConHubspot(leadName, closerEmail = null) {
  if (!hubspotEnabled()) return { hubspotMatch: 'skipped', hubspotContactId: null, esCall: 0 };
  try {
    const candidatos = await searchContactsByName(leadName);
    if (!candidatos.length) return { hubspotMatch: 'none', hubspotContactId: null, esCall: 0 };

    // Homónimos: NO se elige uno al azar, pero tampoco nos rendimos. Medido sobre 30 leads
    // reales de Registrado/Calificado, rendirse costaba el 63% de los cruces — y una señal
    // que falla 6 de cada 10 veces se deja de mirar. Se desambigua por el PROCESO (quién de
    // los homónimos tiene un deal en etapa de setteo) y, si hace falta, por el owner.
    // Todo el peso lo lleva `elegirContacto`, que es puro. Ver src/setteo/desambiguar.js.
    let elegido = { id: String(candidatos[0].id), via: 'unico' };
    if (candidatos.length > 1) {
      const [etapasSetteables, dealsPorContacto, ownerId] = await Promise.all([
        setteableStageIds(),
        dealsOfContacts(candidatos.map((c) => c.id)),
        ownerIdForCloser(closerEmail),
      ]);
      elegido = elegirContacto({ candidatos, dealsPorContacto, etapasSetteables, ownerId });
      if (!elegido) {
        console.log(`[Setteo] "${leadName}": ${candidatos.length} homónimos y ninguno desambiguable → ambiguo`);
        return { hubspotMatch: 'ambiguous', hubspotContactId: null, esCall: 0 };
      }
      console.log(`[Setteo] "${leadName}": ${candidatos.length} homónimos → resuelto por ${elegido.via}`);
    }

    const esCall = (await contactHasScheduledDeal(elegido.id)) ? 1 : 0;
    return { hubspotMatch: 'exact', hubspotContactId: String(elegido.id), esCall };
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
    // El email del closer va al cruce: es el desempate final entre homónimos (el deal en
    // etapa de setteo que además es SUYO). Sale del JID, nunca del texto del mensaje.
    const cruce = await cruzarConHubspot(it.leadName, closer.email);
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

// Deja constancia del intercambio en `messages`, con el MISMO chat_id que usa el contexto
// agéntico del closer. No es telemetría: es la memoria de la conversación.
//
// 🔑 Sin esto, la captura determinista es INVISIBLE para el Juanito que conversa. Pasó en el
// smoke del 2026-08-04: el closer reportó 3 leads por texto libre, los tres se guardaron bien,
// y al preguntar "¿cómo voy?" Juanito contestó "No reportaste nada todavía hoy". No estaba
// inventando — en su historia, lo último que había pasado era él mismo diciendo "Borrado,
// empezamos de cero", y desde entonces nadie había dicho nada. La respuesta era una inferencia
// CORRECTA sobre una historia FALSA, que es el peor tipo de error: no se ve como un bug.
//
// El mismo hueco explica el otro fallo del smoke: "descarta eso" llegó sin que el mensaje al
// que se refería estuviera en la historia, y el modelo adivinó a qué apuntaba.
//
// Best-effort: si falla, el setteo YA quedó guardado y eso es lo que importa.
// ⚠️ `source: 'bot'` NO es decorativo: `getRecentHistory` filtra por `source = 'bot'`, así que
// con cualquier otro valor las filas se guardan pero el contexto agéntico NUNCA las lee — el
// bug quedaría igual y encima con la sensación de estar arreglado.
async function dejarRastro(chatId, texto, respuesta) {
  try {
    await saveMessage({ role: 'user', content: texto, source: 'bot', chatId });
    if (respuesta) await saveMessage({ role: 'assistant', content: respuesta, source: 'bot', chatId });
  } catch (e) {
    console.warn(`[Setteo] no pude dejar rastro en la conversación: ${e.message}`);
  }
}

// Devuelve true si el mensaje era un reporte de setteo (y lo manejó).
export async function captureSetteoReply({ from, pushName, text, messageId }) {
  if (!ENABLED()) return false;

  // La identidad SIEMPRE sale del JID de quien escribe, nunca del texto: es lo que impide
  // que alguien registre setteos a nombre de otro closer.
  const closer = closerOf(from);
  if (!closer) return false;
  if (!isCloserInScope(closer.email)) return false;

  // "Descartá el de Juan" es una CORRECCIÓN, no un reporte. Esta capa solo sabe crear, así que
  // no la toca: se deja pasar al contexto agéntico, que tiene `corregir_setteo`. Va ANTES de
  // parsear porque el parser, si lo mira, encuentra "nombre + resultado" donde no lo hay.
  if (esCorreccion(text)) return false;

  let parsed = parseSetteoReply(text);
  // 'agregado' = dijo cuántos pero no quiénes. Se le piden los nombres en vez de inventar
  // filas para cuadrar el número (la tabla es una fila por lead y el cruce necesita nombre).
  if (parsed.kind === 'agregado') {
    if (messageId && !markIfNew(messageId)) return true;
    const pedido = buildPedirNombres(parsed.conteo);
    await sendMessage(from, pedido).catch(() => {});
    // Este rastro importa especialmente: sin él, un "no, descartá eso" posterior llega sin
    // el mensaje al que se refiere y el modelo tiene que adivinar.
    await dejarRastro(from, text, pedido);
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
    const confirmacion = buildConfirmacion({
      fecha: parsed.fecha,
      items: parsed.items,
      resultado,
      hoy: localDateISO(),
    });
    await sendMessage(from, confirmacion).catch(() => {});
    await dejarRastro(from, text, confirmacion);
  } catch (e) {
    console.error('[Setteo] no se pudo guardar:', e.message);
    // Fallar en silencio sería peor que no tener la feature: el closer creería que quedó
    // registrado. Se le dice, y el mensaje crudo queda en el log para recuperarlo.
    await sendMessage(from, 'Uy, no pude guardar eso 😖. Vuelve a mandármelo en un momento.').catch(() => {});
  }
  return true;
}
