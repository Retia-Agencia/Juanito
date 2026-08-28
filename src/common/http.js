// src/common/http.js
// `fetch` con fecha de vencimiento. Un módulo entero para una línea, por una razón concreta.
//
// EL PROBLEMA (auditoría 2026-08-26, hallazgo 10): ni Calendly, ni HubSpot, ni Stripe, ni
// Sheets le ponían deadline a sus `fetch()`. El `fetch` de Node NO tiene timeout por defecto:
// si el otro lado acepta la conexión y después se calla, la promesa queda colgada para
// siempre. Y esto no cuelga una request suelta — cuelga el JOB entero, porque los pollers
// hacen `await` en serie dentro del tick del cron. El resultado es la forma exacta del hueco
// de §18.AT: el proceso NO crashea, así que `entrypoint.sh` no lo reinicia; el contenedor
// sigue "healthy"; los logs no dicen nada porque nadie llegó a la línea del error. Un Juanito
// vivo, verde y mudo.
//
// Un `AbortSignal.timeout` convierte ese cuelgue silencioso en un error normal, que cada
// cliente ya sabe manejar (todos tienen su try/catch y su reintento). El bug se vuelve
// ruidoso, que es todo lo que se le pide.
//
// ⚠️ El deadline es POR INTENTO, no por operación. Los tres clientes reintentan ante 429 con
// backoff, así que un `AbortSignal` compartido entre intentos mataría el reintento antes de
// empezarlo. Por eso la señal se crea adentro, en cada llamada.

// Techo generoso a propósito: estas APIs a veces tardan de verdad (una página de 100 meetings
// de HubSpot, un tab entero de Sheets). Lo que se quiere cortar es el cuelgue infinito, no la
// lentitud. Ajustable por si alguna vez hace falta subirlo sin tocar código.
export const HTTP_TIMEOUT_MS = () => Number(process.env.HTTP_TIMEOUT_MS || 30000);

// Mismo contrato que `fetch`, más el deadline. `init.signal` propio se respeta: si el caller
// ya trae su señal, esa manda y no se le pisa (nadie lo hace hoy, pero fallar en silencio
// sobre la señal de otro sería justo el tipo de sorpresa que esto viene a evitar).
export async function fetchConDeadline(url, init = {}, { timeoutMs = HTTP_TIMEOUT_MS() } = {}) {
  const propia = !init.signal; // ¿el deadline es NUESTRO o el caller trajo el suyo?
  const signal = init.signal || AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    // El abort de `AbortSignal.timeout` llega como TimeoutError. Sin este re-etiquetado el log
    // dice "The operation was aborted", que no le dice a nadie que fue el deadline ni cuánto
    // esperó — y averiguarlo cuesta una tarde. Solo se re-etiqueta el abort PROPIO: poner
    // "timeout de 50ms" sobre la señal de otro es inventar una causa que no fue.
    if (propia && (err?.name === 'TimeoutError' || err?.name === 'AbortError')) {
      const host = (() => {
        try {
          return new URL(String(url)).host;
        } catch {
          return String(url).slice(0, 60);
        }
      })();
      const e = new Error(`timeout de ${timeoutMs}ms hablando con ${host}`);
      e.name = 'TimeoutError';
      e.cause = err;
      throw e;
    }
    throw err;
  }
}
