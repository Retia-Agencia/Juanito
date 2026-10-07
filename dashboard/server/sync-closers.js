// dashboard/server/sync-closers.js
// Manda los outcomes post-call de 30X (`call_outcomes`) al Dashboard de Closers de 30X
// (repo `dashboard-closers`, Supabase). Allá son la fuente de show/no-show por closer:
// HubSpot casi nunca trae el outcome de la reunión, y lo que el closer le contó a Juanito
// sí. Cruza con la cita por `event_uuid` (el mismo uuid de Calendly).
//
// Por qué vive en el contenedor `dash` y no en el scheduler del bot: solo LEE la DB y hace
// un POST saliente. Acá un bug no tumba WhatsApp, y desplegarlo es `alcance: dash`, que no
// reconecta Baileys.
//
// Qué se manda: SOLO programas de la empresa 30X (Retia y EstadoX no son de ese dashboard),
// y sin teléfonos ni texto crudo del closer. Al arrancar va el histórico completo (el
// upsert es idempotente); después, cada CLOSERS_SYNC_MIN minutos, lo de los últimos 14 días.
//
// Destino: la función RPC `ingest_juanito` de Supabase, con la llave PUBLICABLE + un secreto
// compartido. Juanito no tiene la service role de ese proyecto.
//
// Se autodesactiva si falta CLOSERS_SYNC_URL, CLOSERS_SYNC_KEY o CLOSERS_SYNC_SECRET.

import { fetchConDeadline } from '../../src/common/http.js';
import { PROGRAMS } from '../../src/calendly/programs.js';

const LOTE = 500;
const DIAS_INCREMENTAL = 14;

// ─── Puro (test/dashboard.sync-closers.test.js) ─────────────────────────────

export const programas30x = () =>
  Object.values(PROGRAMS).filter((p) => p.company === '30x').map((p) => p.key);

// 'YYYY-MM-DD HH:MM:SS' (UTC en este esquema) → ISO con Z. Postgres lo leería como hora
// local del servidor si no lleva zona.
export function utcIso(v) {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
}

export function filaParaDashboard(r) {
  return {
    event_uuid: r.event_uuid,
    program: r.program,
    closer_email: r.closer_email,
    closer_name: r.closer_name,
    lead_name: r.lead_name,
    call_start: utcIso(r.call_start),
    asistencia: r.asistencia,
    resultado: r.resultado,
    status: r.status,
    answered_at: utcIso(r.answered_at),
  };
}

export function syncConfigurado() {
  return Boolean(process.env.CLOSERS_SYNC_URL && process.env.CLOSERS_SYNC_KEY && process.env.CLOSERS_SYNC_SECRET);
}

// Manda en lotes. Devuelve cuántas filas aceptó el dashboard; lanza si una respuesta no es 2xx.
export async function enviar(filas) {
  const url = `${process.env.CLOSERS_SYNC_URL.replace(/\/$/, '')}/rest/v1/rpc/ingest_juanito`;
  let total = 0;
  for (let i = 0; i < filas.length; i += LOTE) {
    const res = await fetchConDeadline(url, {
      method: 'POST',
      headers: {
        apikey: process.env.CLOSERS_SYNC_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ secreto: process.env.CLOSERS_SYNC_SECRET, filas: filas.slice(i, i + LOTE) }),
    });
    if (!res.ok) throw new Error(`ingest_juanito → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    total += Number(await res.json()) || 0;
  }
  return total;
}

// ─── Con DB ──────────────────────────────────────────────────────────────────

async function leer({ completo }) {
  // Import diferido: el módulo se puede testear sin better-sqlite3 (Windows).
  const { default: db } = await import('../../src/db/index.js');
  const progs = programas30x();
  const ventana = completo
    ? ''
    : `AND (call_start >= datetime('now', '-${DIAS_INCREMENTAL} days')
            OR answered_at >= datetime('now', '-${DIAS_INCREMENTAL} days'))`;
  return db
    .prepare(
      `SELECT event_uuid, program, closer_email, closer_name, lead_name, call_start,
              asistencia, resultado, status, answered_at
         FROM call_outcomes
        WHERE program IN (${progs.map(() => '?').join(',')}) ${ventana}`
    )
    .all(...progs)
    .map(filaParaDashboard);
}

async function sincronizar(completo) {
  const filas = await leer({ completo });
  const n = await enviar(filas);
  console.log(`[Dash] sync dashboard-closers: ${n}/${filas.length} outcomes${completo ? ' (histórico completo)' : ''}`);
}

export function start() {
  if (!syncConfigurado()) {
    console.log('[Dash] sync dashboard-closers OFF (sin CLOSERS_SYNC_URL/KEY/SECRET)');
    return;
  }
  const minutos = Number(process.env.CLOSERS_SYNC_MIN || 60);
  // Igual que el watchdog: un rejection sin manejar no puede tumbar el proceso del dashboard.
  const tick = (completo) =>
    sincronizar(completo).catch((err) => console.error('[Dash] sync dashboard-closers falló:', err.message));
  tick(true);
  setInterval(() => tick(false), minutos * 60000).unref();
  console.log(`[Dash] sync dashboard-closers cada ${minutos} min`);
}
