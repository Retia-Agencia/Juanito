// Poll horario al CRM de Retia. El CRM decide programas, horas y métricas; Juanito solo
// entrega esa respuesta al grupo de RETIA_SEMAFORO_GRUPO, uno solo para todos los programas
// (ticket 268 de retia-metrics). Juanito pregunta cada hora en punto y el CRM dice si a esa hora toca algo. La última configuración buena permite avisar cuando
// el CRM cae, sin inventar cifras ni escribirle a grupos que no correspondían a esa hora.

import { CronJob } from 'cron';
import { zonedNowParts } from './recurring-logic.js';

// DB (nativa), red y WhatsApp se resuelven perezosamente para que el núcleo se pruebe con
// dobles sin cargar better-sqlite3 ni abrir conexiones reales.
async function realDeps() {
  const [http, db, wa] = await Promise.all([
    import('../common/http.js'),
    import('../db/index.js'),
    import('../whatsapp/index.js'),
  ]);
  return {
    fetchConDeadline: http.fetchConDeadline,
    sendMessage: wa.sendMessage,
    getSetting: db.getSetting,
    setSetting: db.setSetting,
  };
}

const CONFIG_KEY = 'semaforo_retia_config';
const TZ = () => process.env.TZ || 'America/Bogota';
const GRUPO = () => process.env.RETIA_SEMAFORO_GRUPO;
const CRON = () => process.env.SEMAFORO_RETIA_CRON || '0 * * * *';

export function semaforoRetiaHabilitado(env = process.env) {
  return Boolean(env.RETIA_SEMAFORO_URL && env.RETIA_SEMAFORO_SECRETO && env.RETIA_SEMAFORO_GRUPO);
}

async function avisarCaida({ now, deps }) {
  let configuracion;
  try {
    configuracion = JSON.parse(deps.getSetting(CONFIG_KEY));
    if (!Array.isArray(configuracion)) throw new Error('configuración no es un arreglo');
  } catch (err) {
    console.error('[SemaforoRetia] CRM caído y sin configuración guardada válida:', err.message);
    return 0;
  }

  const hora = `${zonedNowParts(now, TZ()).hm.slice(0, 2)}:00`;
  let enviados = 0;
  for (const item of configuracion) {
    if (!item.horas?.includes(hora) && item.horaCierre !== hora) continue;
    const mensaje = `⚠️ Semáforo de pauta · ${item.programa} · ${hora}\nEl CRM no respondió, así que esta hora no hay datos. Lo reviso y vuelvo a intentar a la próxima hora.`;
    try {
      await deps.sendMessage(GRUPO(), mensaje);
      enviados++;
    } catch (err) {
      console.error('[SemaforoRetia] fallo enviando un aviso de caída:', err.message);
    }
  }
  return enviados;
}

// Núcleo sin cron: una respuesta que no cumpla el contrato cuenta igual que una caída.
export async function runSemaforoRetia({ now = new Date(), deps = null } = {}) {
  const d = deps || (await realDeps());
  let respuesta;
  try {
    const res = await d.fetchConDeadline(process.env.RETIA_SEMAFORO_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-semaforo-secreto': process.env.RETIA_SEMAFORO_SECRETO,
      },
      body: '{}',
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    respuesta = await res.json();
    if (!Array.isArray(respuesta?.envios) || !Array.isArray(respuesta?.configuracion)) {
      throw new Error('respuesta incompleta');
    }
  } catch (err) {
    console.error('[SemaforoRetia] CRM no disponible:', err.message);
    return { enviados: await avisarCaida({ now, deps: d }), modo: 'caido' };
  }

  d.setSetting(CONFIG_KEY, JSON.stringify(respuesta.configuracion));
  let enviados = 0;
  // El texto lo arma el CRM (ticket 267 de retia-metrics): la vista previa de Programa › General y este
  // mensaje salen de la misma función. Un envío sin texto no se inventa: se loguea y se salta.
  for (const envio of respuesta.envios) {
    if (typeof envio.texto !== 'string' || envio.texto.trim() === '') {
      console.error('[SemaforoRetia] envío sin texto del CRM:', envio.programa);
      continue;
    }
    try {
      await d.sendMessage(GRUPO(), envio.texto);
      enviados++;
    } catch (err) {
      console.error('[SemaforoRetia] fallo enviando un semáforo:', err.message);
    }
  }
  return { enviados, modo: 'ok' };
}

export function startSemaforoRetiaJob() {
  if (!semaforoRetiaHabilitado()) {
    console.warn('[SemaforoRetia] sin URL, secreto o grupo → semáforo desactivado');
    return;
  }
  new CronJob(
    CRON(),
    () => runSemaforoRetia().catch((err) => console.error('[SemaforoRetia]', err.message)),
    null,
    true,
    TZ()
  );
  console.log(`[SemaforoRetia] Semáforo activo ✅ (cron "${CRON()}")`);
}
