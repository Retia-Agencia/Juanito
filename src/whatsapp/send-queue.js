// src/whatsapp/send-queue.js
// Cola FIFO de envío con throttle global Y espaciado por destino — ANTI-BAN
// (§18.D P1-a + ritmo por grupo).
//
// Por qué existe: el rate-limit por-remitente frena a UN usuario spammeando, pero
// 300 personas distintas mencionando al bot en el mismo minuto producen una ráfaga
// de ~300 envíos legítimos casi simultáneos desde IP de datacenter — justo el patrón
// que disparó el softban anterior. Esta cola serializa TODOS los envíos del socket
// con un intervalo mínimo + jitter entre uno y otro (gap GLOBAL).
//
// Además, para que el bot no parezca una ametralladora dentro de UN mismo grupo, los
// envíos que llevan `key` (= group_id) se separan entre sí ≥ `perKeyGap` (+ jitter):
// dos respuestas al MISMO grupo nunca salen pegadas, pero un grupo saturado NO bloquea
// a otros grupos ni a los DMs (planificador justo: toma el primer job ELEGIBLE en
// orden FIFO; si ninguno lo es, duerme hasta que el más cercano lo sea).
//
// Módulo PURO: sin Baileys, sin DB, sin env — todo se inyecta. Testeable nativo en
// Windows con un `wait`/`now` falsos.

/**
 * @param {object} opts
 * @param {number} opts.minGapMs       intervalo mínimo GLOBAL entre fin de un envío e inicio del siguiente
 * @param {number} opts.jitterMs       jitter aleatorio adicional sobre el gap global [0, jitterMs)
 * @param {number} opts.maxQueue       tamaño máximo de la cola; al excederse, enqueue rechaza
 * @param {number} [opts.perKeyGapMs]  separación mínima entre dos envíos con la MISMA key (default 0 = off)
 * @param {number} [opts.perKeyJitterMs] jitter aleatorio adicional sobre el gap por-key [0, perKeyJitterMs)
 * @param {function} [opts.wait]       (ms) => Promise — inyectable para tests
 * @param {function} [opts.random]     () => [0,1) — inyectable para tests
 * @param {function} [opts.now]        () => ms — reloj inyectable para tests (default Date.now)
 */
export function createSendQueue({
  minGapMs,
  jitterMs,
  maxQueue,
  perKeyGapMs,
  perKeyJitterMs,
  wait,
  random,
  now,
} = {}) {
  const gap = Number.isFinite(minGapMs) ? minGapMs : 1000;
  const jitter = Number.isFinite(jitterMs) ? jitterMs : 500;
  const max = Number.isFinite(maxQueue) ? maxQueue : 200;
  const perKeyGap = Number.isFinite(perKeyGapMs) ? perKeyGapMs : 0;
  const perKeyJitter = Number.isFinite(perKeyJitterMs) ? perKeyJitterMs : 0;
  const sleep = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rnd = random || Math.random;
  const clock = now || Date.now;

  const queue = [];
  // key → timestamp (ms) a partir del cual esa key puede volver a enviar.
  const nextAllowedByKey = new Map();
  let draining = false;

  // Índice del primer job ELEGIBLE en orden FIFO. Si ninguno lo es, devuelve el ms que
  // falta para que el más cercano lo sea (para dormir esa cantidad y reintentar).
  function pickEligible() {
    if (perKeyGap <= 0) return { idx: 0 }; // sin espaciado por key → FIFO puro
    const t = clock();
    let earliestWait = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i].key;
      if (!k) return { idx: i }; // sin key → siempre elegible
      const next = nextAllowedByKey.get(k);
      if (next === undefined || t >= next) return { idx: i };
      earliestWait = Math.min(earliestWait, next - t);
    }
    return { idx: -1, wait: Number.isFinite(earliestWait) ? earliestWait : 0 };
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const { idx, wait: toWait } = pickEligible();
        if (idx === -1) {
          // Ningún job elegible todavía: dormir hasta que el más cercano lo sea.
          await sleep(toWait);
          continue;
        }
        const job = queue.splice(idx, 1)[0];
        try {
          const result = await job.fn();
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }
        // Marcar el próximo turno de esta key (gap por-grupo + jitter, fijado al enviar).
        if (job.key && perKeyGap > 0) {
          nextAllowedByKey.set(job.key, clock() + perKeyGap + Math.floor(rnd() * perKeyJitter));
        }
        // Pausa GLOBAL SIEMPRE (aun con la cola vacía y tras fallos): así un envío que
        // entre justo después de drenar igual queda a >= gap del anterior.
        await sleep(gap + Math.floor(rnd() * jitter));
      }
    } finally {
      draining = false;
      // Si entró algo mientras soltábamos el lock, re-drenar.
      if (queue.length > 0) drain();
    }
  }

  return {
    /**
     * Encola un envío. Resuelve cuando el envío realmente salió.
     * Rechaza inmediatamente si la cola está llena (descarte anti-flood).
     * @param {function} fn        () => Promise — el envío real
     * @param {object}   [opts]
     * @param {string}   [opts.key] destino para el espaciado por-key (= group_id)
     */
    enqueue(fn, { key = null } = {}) {
      if (queue.length >= max) {
        return Promise.reject(
          new Error(`send-queue llena (${queue.length}/${max}) — envío descartado`)
        );
      }
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject, key });
        drain();
      });
    },
    size() {
      return queue.length;
    },
  };
}
