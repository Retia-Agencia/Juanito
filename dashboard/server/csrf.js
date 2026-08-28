// dashboard/server/csrf.js
// PURO. Decide si un POST del dashboard viene de la propia UI o de otro lado.
//
// Vive en su propio módulo por la misma razón que src/whatsapp/disconnect-logic.js: el
// `index.js` del dashboard hace `server.listen()` al importarse, así que cualquier test que
// lo importe abre un puerto. Acá no hay deps nativas ni efectos, o sea se puede iterar en
// Windows sin Docker.
//
// ── El problema ──────────────────────────────────────────────────────────────
// El dashboard no tiene login: la auth es la red (el tailnet). Eso responde "quién puede
// llegar", pero NO "quién armó este pedido". El navegador de alguien del tailnet manda la IP
// y las cookies correctas aunque el `fetch` lo haya escrito una página cualquiera de internet
// que esa persona tenga abierta en otra pestaña. Sin nada de esto, un POST `text/plain` desde
// cualquier sitio disparaba un deploy `todo` — o sea reconectaba Baileys, con el riesgo de
// softban de §18.AT — y la víctima no veía absolutamente nada.
//
// ── Por qué el header propio alcanza ─────────────────────────────────────────
// No es un secreto y no hace falta rotarlo. Funciona por cómo está definido CORS: un header
// no estándar saca al pedido de la categoría "simple", así que el navegador está OBLIGADO a
// mandar antes un preflight `OPTIONS`. El servidor responde 405 a OPTIONS y no emite un solo
// header `Access-Control-Allow-*`, así que el preflight nunca pasa y el POST real jamás se
// envía. `curl` puede mandar el header; un navegador cross-origin no.
//
// El Content-Type se exige por lo mismo: `application/json` tampoco es un tipo "simple" (solo
// lo son form-urlencoded, multipart y text/plain), y `leerCuerpo` parsea JSON venga como
// venga — sin este chequeo el atacante elegía el tipo que no dispara preflight.
//
// ── Por qué el Origin NO es el gate principal ────────────────────────────────
// Detrás de `tailscale serve` el `Host` que ve este proceso puede ser el del backend y no el
// del tailnet; un chequeo estricto ahí dejaría el dashboard tapiado sin un error que lo
// explique, que es peor que el bug. Por eso solo se rechaza un Origin que ADEMÁS de no
// coincidir con Host ni con X-Forwarded-Host, no esté en `DASH_ALLOWED_ORIGINS`. Que NO venga
// Origin no es sospechoso: curl y los selftests no lo mandan, y el header propio ya filtró.

export const HEADER_PROPIO = 'x-dash-origen';
export const VALOR_PROPIO = 'juanito';

const origenesPermitidos = () =>
  (process.env.DASH_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// `headers` es el objeto de node:http (claves ya en minúscula).
// Devuelve null si el pedido pasa, o el motivo del rechazo (string) si no.
export function motivoRechazoCsrf(headers = {}) {
  if (String(headers[HEADER_PROPIO] || '').trim() !== VALOR_PROPIO) {
    return 'falta el header de origen del dashboard';
  }

  const tipo = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (tipo && tipo !== 'application/json') return `content-type no aceptado: ${tipo}`;

  const origin = String(headers.origin || '').trim();
  if (!origin) return null;

  let hostOrigin;
  try {
    hostOrigin = new URL(origin).host.toLowerCase();
  } catch {
    return `origin malformado: ${origin}`;
  }

  const propios = [headers.host, headers['x-forwarded-host']]
    .filter(Boolean)
    .map((h) => String(h).split(',')[0].trim().toLowerCase());
  if (propios.includes(hostOrigin)) return null;
  if (origenesPermitidos().includes(origin.toLowerCase())) return null;

  return `origin ajeno: ${origin}`;
}
