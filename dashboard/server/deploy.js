// dashboard/server/deploy.js
// El botón Deploy: dispara `.github/workflows/deploy.yml` por la API de GitHub
// (workflow_dispatch). Último pendiente de F1.
//
// Por qué la API de GitHub y no ejecutar nada acá: montar el socket de Docker en el
// contenedor del dashboard es dar root en el host. El pipeline es el único camino que
// toca el droplet, y así GitHub queda además como audit log de quién desplegó qué.
//
// Apagado por default: sin `DASH_GITHUB_TOKEN` la ruta no existe y la UI no dibuja el
// botón. El token es un PAT con permiso `actions:write` sobre el repo — es un secreto
// del CONTENEDOR (va al .env del VPS), no un Repository secret de GitHub.

import { fetchConDeadline } from '../../src/common/http.js';

const REPO = process.env.DASH_GITHUB_REPO || 'Agencia-Dani/Juanito';
const RAMA = process.env.DASH_GITHUB_REF || 'main';
const TOKEN = () => (process.env.DASH_GITHUB_TOKEN || '').trim();

export const habilitado = () => !!TOKEN();

export async function disparar(alcance) {
  if (!habilitado()) throw new Error('sin DASH_GITHUB_TOKEN: el botón Deploy está apagado');
  // El alcance define si esto reconecta Baileys. No se acepta nada fuera de la lista.
  if (alcance !== 'dash' && alcance !== 'todo') throw new Error("alcance debe ser 'dash' o 'todo'");

  const r = await fetchConDeadline(
    `https://api.github.com/repos/${REPO}/actions/workflows/deploy.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: RAMA, inputs: { alcance } }),
    }
  );

  // 204 sin cuerpo es el éxito. Cualquier otra cosa la devolvemos tal cual: el mensaje
  // de GitHub ("Resource not accessible by personal access token") es más útil que
  // cualquier traducción nuestra.
  if (r.status !== 204) {
    const detalle = await r.text().catch(() => '');
    throw new Error(`GitHub respondió ${r.status}: ${detalle.slice(0, 300)}`);
  }
  return { alcance, repo: REPO, rama: RAMA, url: `https://github.com/${REPO}/actions/workflows/deploy.yml` };
}
