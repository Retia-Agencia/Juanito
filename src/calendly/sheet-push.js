// src/calendly/sheet-push.js
// Push 5 (§18.AP): el recordatorio de llenar los Google Sheets que se le manda al closer
// DESPUÉS de cada llamada. Lo reciben las conexiones que declaran `sheets` en
// accounts.js es la que lo recibe; 30x no declara la lista y por eso no lo tiene.
//
// PURO (sin DB, sin red, sin deps nativas), igual que push-logic.js / outcome-logic.js:
// el scheduler lo importa y los tests lo prueban directo. El efecto (agendar la fila y
// entregarla) vive en src/scheduler/calendly.js.
//
// Por qué es un archivo aparte y no dos funciones más en index.js, que es donde viven
// push4DueUtc/buildPush4Message: index.js es código compartido con 30X y este cambio no
// puede tocarlo. El módulo ya usa ese patrón de "un archivo por concern".
//
// ⚠️ No confundir con el Push 4: ese es el REGISTRO DE OUTCOME de 30X ("¿cómo te fue?"),
// con pendientes, cosecha de HubSpot y recordatorios. Las conexiones de Retia lo tienen apagado
// (ACCOUNTS.retia.push4 → false), así que el Push 5 es su único push post-call. El número
// 5 no es un typo: el 4 está ocupado por otra cosa.

import { formatCallTime } from './index.js';

// ─── Cuándo vence el Push 5 ───────────────────────────────────────────────────
// A diferencia de push4DueUtc, que asume una duración fija, este usa el FIN REAL de la
// llamada: `end_time` viene en el payload de Calendly (listProgramEvents devuelve el objeto
// crudo) y hasta ahora no lo leía nadie. Con él, una call de 45 o 60 minutos no recibe el
// recordatorio mientras todavía está en curso.
//
// Sin `end_time` utilizable —uuid sintético de reagenda, payload viejo, fecha inválida—
// cae a la duración asumida, exactamente como push4DueUtc.
export function push5DueUtc(startIso, endIso, { durationMin = 30, delayMin = 10 } = {}) {
  const endMs = Date.parse(endIso || '');
  const startMs = new Date(startIso).getTime();
  const base = Number.isFinite(endMs) ? endMs : startMs + durationMin * 60000;
  return new Date(base + delayMin * 60000);
}

// ─── El mensaje ───────────────────────────────────────────────────────────────
// Informativo y sin acción esperada: el closer no contesta nada, Juanito no verifica que el
// sheet se haya llenado (no tiene acceso a esos archivos) y no insiste. Un disparo por call.
// `tz` sin default a propósito: formatCallTime ya cae a TZ() cuando llega undefined, y TZ es
// privado de index.js (no se exporta y este cambio no puede tocar ese archivo).
export function buildPush5Message({ name, firstName, startIso, sheets = [], tz }) {
  const who = name || firstName || 'el prospecto';
  const time = formatCallTime(startIso, tz);
  const lista = sheets.map((s) => `• ${s.label}: ${s.url}`).join('\n');
  const cuantos = sheets.length === 1 ? 'el sheet' : 'los dos sheets';
  return `📝 *Registra la call* — *${who}* (de las ${time}). Llena ${cuantos}:\n${lista}`;
}
