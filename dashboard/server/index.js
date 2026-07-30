// dashboard/server/index.js
// Servidor del dashboard. node:http a secas, sin frameworks — el repo tiene una regla
// de "no agregar dependencias sin justificación clara" y acá no hay ninguna.
//
// Corre en su PROPIO contenedor, aparte del bot: src/index.js hace process.exit(1)
// ante cualquier excepción no capturada y entrypoint.sh duerme 30-300s, así que un
// bug en un handler HTTP dentro del bot tumbaría WhatsApp hasta 5 minutos.
//
// Los GET son de lectura pura (F1). Los POST escriben, y solo los tabs listados en
// `DASH_WRITES` los aceptan: sin esa variable el dashboard es exactamente el read-only
// de F1. Ver F2 en docs/DASHBOARD-ROADMAP.md.

import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

import * as Q from './queries.js';
import * as watchdog from './watchdog.js';
import * as A from './actions.js';
import * as deploy from './deploy.js';

const RAIZ = fileURLToPath(new URL('..', import.meta.url)); // dashboard/
const DIST = join(RAIZ, 'dist');
const PUERTO = Number(process.env.DASH_PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// ─── Rutas de la API (todas GET, todas de lectura) ────────────────────────────

const RUTAS = {
  '/api/salud': () => Q.salud(),
  '/api/aprobaciones': () => Q.aprobaciones(),
  '/api/grupos': () => Q.grupos(),
  '/api/programados': () => Q.programados(),
  '/api/outreach': () => Q.outreach(),
  '/api/tareas': () => Q.tareas(),
  '/api/negocio': () => Q.negocio(),
  '/api/recordatorios': () => Q.recordatorios(),
  '/api/calls': () => Q.calls(),
  '/api/optins': () => Q.optins(),
  '/api/toggles': () => Q.toggles(),
  '/api/registries': () => Q.registries(),
  '/api/alertas': () => watchdog.historial(),
  '/api/meta': () => meta(),
};

// Identidad del despliegue. El pipeline escribe DEPLOYED_SHA en la raíz del proyecto;
// sin él, `desconocido` (que es el estado de hoy, y por eso existe el archivo).
async function meta() {
  let sha = 'desconocido';
  try {
    sha = (await readFile(join(RAIZ, '..', 'DEPLOYED_SHA'), 'utf8')).trim();
  } catch {
    /* sin desplegar por pipeline todavía */
  }
  return {
    sha,
    tz: process.env.TZ || 'America/Bogota',
    alertasWhatsapp: process.env.DASH_ALERTS_WHATSAPP === 'true',
    // Qué tabs pueden escribir y qué acciones piden confirmación (F2). Lista vacía =
    // read-only, que es el default.
    escrituras: A.catalogo(),
    deploy: deploy.habilitado(),
    uptimeSeg: Math.round(process.uptime()),
    ahora: new Date().toISOString(),
  };
}

// ─── Cuerpo de los POST ───────────────────────────────────────────────────────

const LIMITE_CUERPO = 64 * 1024; // ninguna acción manda más que un texto de WhatsApp

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    let cortado = false;
    req.on('data', (c) => {
      if (cortado) return;
      bruto += c;
      if (bruto.length > LIMITE_CUERPO) {
        // Cortar acumulando, no destruir el socket: la respuesta 400 todavía tiene que
        // poder salir por ahí.
        cortado = true;
        reject(new A.MalaPeticion('cuerpo demasiado grande'));
      }
    });
    req.on('end', () => {
      if (cortado) return;
      if (!bruto.trim()) return resolve({});
      try {
        resolve(JSON.parse(bruto));
      } catch {
        reject(new A.MalaPeticion('cuerpo inválido: se esperaba JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ─── Estáticos ────────────────────────────────────────────────────────────────

async function servirEstatico(res, urlPath) {
  // normalize + prefijo obligatorio: sin esto, `GET /../../etc/passwd` sale del DIST.
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath);
  const archivo = join(DIST, rel);
  if (!archivo.startsWith(DIST)) return false;

  try {
    const s = await stat(archivo);
    if (!s.isFile()) return false;
    const buf = await readFile(archivo);
    res.writeHead(200, {
      'Content-Type': MIME[extname(archivo)] || 'application/octet-stream',
      // El bundle de Vite lleva hash en el nombre; el index.html nunca se cachea.
      'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=31536000',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

// ─── Escrituras (F2) ──────────────────────────────────────────────────────────
//
//   POST /api/w/<tab>/<accion>   → una función de src/db/index.js
//   POST /api/deploy             → workflow_dispatch en GitHub
//
// Cada escritura queda en `docker logs`. El rastro que sobrevive a recrear el
// contenedor es la columna de auditoría que escribe cada acción (`decided_by` y
// compañía = 'dashboard').

const json = (res, codigo, cuerpo) => {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(cuerpo));
};

async function manejarEscritura(req, res, ruta) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpo(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  if (ruta === '/api/deploy') {
    try {
      const r = await deploy.disparar(cuerpo.alcance);
      console.log(`[Dash] deploy disparado · alcance=${r.alcance}`);
      return json(res, 200, { ok: true, ...r });
    } catch (err) {
      console.error('[Dash] deploy falló:', err.message);
      return json(res, 400, { error: err.message });
    }
  }

  const m = /^\/api\/w\/([a-z]+)\/([a-z.]+)$/.exec(ruta);
  if (!m) return json(res, 404, { error: 'ruta de escritura desconocida' });

  const [, tab, accion] = m;
  try {
    const r = A.ejecutar(tab, accion, cuerpo);
    console.log(`[Dash] escritura ${tab}/${accion} → ${r.n} fila(s) · ${JSON.stringify(cuerpo).slice(0, 200)}`);
    return json(res, 200, r);
  } catch (err) {
    // Validación y tab apagado son culpa del pedido (400); lo demás explota arriba y
    // se registra como error del servidor.
    if (err instanceof A.MalaPeticion) return json(res, 400, { error: err.message });
    throw err;
  }
}

// ─── Servidor ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ruta = url.pathname;

  try {
    if (ruta.startsWith('/api/')) {
      if (req.method === 'POST') return await manejarEscritura(req, res, ruta);
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'método no permitido' }));
      }
      const handler = RUTAS[ruta];
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'ruta desconocida' }));
      }
      const datos = await handler();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(datos));
    }

    if (await servirEstatico(res, ruta)) return;
    // Fallback de SPA: cualquier ruta desconocida devuelve el index.
    if (await servirEstatico(res, '/index.html')) return;

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Sin build del frontend. Corré `npm run build` en dashboard/.');
  } catch (err) {
    // Un error acá NO puede escalar: este proceso es el que te deja ver qué pasa
    // cuando algo más está roto.
    console.error(`[Dash] error en ${ruta}:`, err.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.on('error', (err) => console.error('[Dash] error del servidor:', err.message));
process.on('unhandledRejection', (err) =>
  console.error('[Dash] promesa sin manejar:', err?.message || err)
);

server.listen(PUERTO, () => {
  console.log(`[Dash] escuchando en :${PUERTO} · DB=${process.env.DB_PATH || './data/brain.sqlite'}`);
  const w = A.tabsHabilitados();
  console.log(
    `[Dash] escrituras: ${w.length ? w.join(', ') : 'ninguna (solo lectura)'} · ` +
      `deploy ${deploy.habilitado() ? 'ON' : 'OFF (sin DASH_GITHUB_TOKEN)'}`
  );
  watchdog.start();
});
