// src/whatsapp/send-queue.js
// Cola FIFO de envío con throttle global — ANTI-BAN (§18.D P1-a del handoff).
//
// Por qué existe: el rate-limit por-remitente frena a UN usuario spammeando, pero
// 300 personas distintas mencionando al bot en el mismo minuto producen una ráfaga
// de ~300 envíos legítimos casi simultáneos desde IP de datacenter — justo el patrón
// que disparó el softban anterior. Esta cola serializa TODOS los envíos del socket
// con un intervalo mínimo + jitter entre uno y otro.
//
// Módulo PURO: sin Baileys, sin DB, sin env — todo se inyecta. Testeable nativo en
// Windows con un `wait` falso.

/**
 * @param {object} opts
 * @param {number} opts.minGapMs   intervalo mínimo entre fin de un envío e inicio del siguiente
 * @param {number} opts.jitterMs   jitter aleatorio adicional [0, jitterMs)
 * @param {number} opts.maxQueue   tamaño máximo de la cola; al excederse, enqueue rechaza
 * @param {function} [opts.wait]   (ms) => Promise — inyectable para tests
 * @param {function} [opts.random] () => [0,1) — inyectable para tests
 */
export function createSendQueue({ minGapMs, jitterMs, maxQueue, wait, random } = {}) {
  const gap = Number.isFinite(minGapMs) ? minGapMs : 1000;
  const jitter = Number.isFinite(jitterMs) ? jitterMs : 500;
  const max = Number.isFinite(maxQueue) ? maxQueue : 200;
  const sleep = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rnd = random || Math.random;

  const queue = [];
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        try {
          const result = await job.fn();
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }
        // Pausa SIEMPRE (aun con la cola vacía y tras fallos): así un envío que
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
     */
    enqueue(fn) {
      if (queue.length >= max) {
        return Promise.reject(
          new Error(`send-queue llena (${queue.length}/${max}) — envío descartado`)
        );
      }
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        drain();
      });
    },
    size() {
      return queue.length;
    },
  };
}
