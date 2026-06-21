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
