// src/common/approval-intent.js
// PURO (sin deps). Detección DETERMINISTA de una aprobación clara en la consola de
// aprobaciones, para resolverla sin pasar por el LLM (evita el loop en que el modelo
// interpretaba "aprobado" como una corrección y re-generaba sin fin).
//
// Anclado a ^...$ sobre el "core" (sin id ni signos) para no confundir un pedido como
// "envíame la versión revisada" con un envío. Devuelve { isApprove, id|null }.

const APPROVE_CORE_RE =
  /^(aprob\w*|apru[eé]b\w*|s[íi]|dale|perfecto|oka?y?|list[oa]|env[ií]al[oa]( as[ií])?|m[áa]ndal[oa]|as[ií]( est[áa]| qued[oó])? bien|as[ií])$/i;

export function parseApproval(text) {
  const raw = (text || '').trim().toLowerCase();
  const idMatch = raw.match(/#?\b(\d{1,5})\b/);
  const id = idMatch ? Number(idMatch[1]) : null;
  const core = raw.replace(/#?\b\d{1,5}\b/g, '').replace(/[.,;:!¡?¿)(]/g, '').trim();
  return { isApprove: APPROVE_CORE_RE.test(core), id };
}

// Descarte CLARO de un pendiente ("no", "descártalo", "cancela", "bórralo", "elimínalo").
// Mismo criterio anclado que parseApproval para no tragarse una corrección ("no, mejor di…").
const DISCARD_CORE_RE =
  /^(no|nop|nel|descart\w*|descártal[oa]|cancel\w*|b[oó]rral[oa]|elim[ií]nal[oa]|desech\w*|d[eé]jal[oa]( as[ií])?|no( la| lo)? mandes|no( la| lo)? env[ií]es)$/i;

export function parseDiscard(text) {
  const raw = (text || '').trim().toLowerCase();
  const id = raw.match(/#?\b(\d{1,5})\b/);
  const core = raw.replace(/#?\b\d{1,5}\b/g, '').replace(/[.,;:!¡?¿)(]/g, '').trim();
  return { isDiscard: DISCARD_CORE_RE.test(core), id: id ? Number(id[1]) : null };
}

// Resuelve a QUÉ pendiente apunta un REPLY, leyendo la notificación CITADA. Las notificaciones
// de Juanito traen un encabezado fijo: "📨 *Respuesta pendiente #N*" o "📝 *Borrador #N*", así
// que el mensaje citado nos da el tipo Y el id sin ambigüedad (resuelve el caso de 2+ pendientes
// donde "apruebo" sin id era ambiguo). Devuelve { type:'reply'|'draft', id } o null.
export function parseApprovalTarget(quotedText) {
  const raw = (quotedText || '').toString();
  if (!raw) return null;
  const reply = raw.match(/respuesta pendiente\s*#?(\d{1,5})/i);
  if (reply) return { type: 'reply', id: Number(reply[1]) };
  const draft = raw.match(/borrador\s*#?(\d{1,5})/i);
  if (draft) return { type: 'draft', id: Number(draft[1]) };
  return null;
}
