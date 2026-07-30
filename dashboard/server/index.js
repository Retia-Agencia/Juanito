// dashboard/server/index.js
// Servidor del dashboard. node:http a secas, sin frameworks — el repo tiene una regla
// de "no agregar dependencias sin justificación clara" y acá no hay ninguna.
//
// Corre en su PROPIO contenedor, aparte del bot: src/index.js hace process.exit(1)
// ante cualquier excepción no capturada y entrypoint.sh duerme 30-300s, así que un
// bug en un handler HTTP dentro del bot tumbaría WhatsApp hasta 5 minutos.
//
// En F1 la API es SOLO LECTURA: no hay una sola ruta que escriba. Las escrituras
// llegan en F2, tab por tab. Ver docs/DASHBOARD-ROADMAP.md.

import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

import * as Q from './queries.js';
import * as watchdog from './watchdog.js';

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
    escrituras: false, // F1 es read-only; F2 lo cambia
    uptimeSeg: Math.round(process.uptime()),
    ahora: new Date().toISOString(),
  };
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

// ─── Servidor ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ruta = url.pathname;

  try {
    if (ruta.startsWith('/api/')) {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'El dashboard es de solo lectura en F1' }));
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
  watchdog.start();
});
