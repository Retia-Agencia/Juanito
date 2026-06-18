// src/sheets/client.js
// IMPURO. Lector del Google Sheet de leads vía Sheets API v4. Es el ÚNICO archivo
// del módulo que toca la red; el resto (parse/window/aggregate/report) es puro.
//
// Autenticación: service account con JWT RS256 firmado con `crypto` nativo (SIN
// dependencias nuevas — no usamos `googleapis`). Flujo OAuth 2.0 server-to-server:
//   1. firmamos un JWT con la private_key del SA,
//   2. lo canjeamos por un access_token en oauth2.googleapis.com/token,
//   3. llamamos GET …/v4/spreadsheets/{id}/values/{tab} con ese token.
//
// Credenciales por env GOOGLE_SA_KEY, que acepta (en este orden):
//   - el JSON del service account como texto (empieza con '{'),
//   - una ruta a un archivo .json (lo lee del disco),
//   - el JSON codificado en base64.

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export const LEADS_ID = () =>
  process.env.SHEETS_LEADS_ID || '1pg3cP9w9ag7Re8QF5ZM8S2ktNwMRZDCihE7UYJmtlV4';

export const LEADS_TAB = () => process.env.SHEETS_LEADS_TAB || 'IA para abogados _ EstadoX';

export const SETTEO_TAB = () => process.env.SHEETS_SETTEO_TAB || '📞 Setteo Pendiente';

// Resuelve GOOGLE_SA_KEY a las credenciales del service account.
export function loadCredentials(raw = process.env.GOOGLE_SA_KEY) {
  if (!raw || !String(raw).trim()) {
    throw new Error('[sheets] falta GOOGLE_SA_KEY (JSON, ruta al .json, o base64). Ver §18.B.');
  }
  let text = String(raw).trim();
  if (!text.startsWith('{')) {
    if (existsSync(text)) {
      text = readFileSync(text, 'utf8');
    } else {
      // último intento: base64 → JSON
      try {
        text = Buffer.from(text, 'base64').toString('utf8');
      } catch {
        /* cae al parse de abajo, que lanzará un error claro */
      }
    }
  }
  const creds = JSON.parse(text);
  if (!creds.client_email || !creds.private_key) {
    throw new Error('[sheets] GOOGLE_SA_KEY sin client_email/private_key — ¿es la key JSON correcta?');
  }
  return creds;
}

const b64url = (input) => Buffer.from(input).toString('base64url');

// Firma un JWT y lo canjea por un access_token de Google.
async function getAccessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: SCOPE,
      aud: creds.token_uri || TOKEN_URI,
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(creds.private_key);
  const jwt = `${signingInput}.${b64url(signature)}`;

  const res = await fetch(creds.token_uri || TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`[sheets] token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()).access_token;
}

// Lee TODO un tab y devuelve sus filas crudas (arreglo de arreglos de celdas),
// encabezado incluido. Los agregadores toleran el encabezado (no parsea como fecha →
// fuera de ventana). Cada llamada canjea su propio token (el reporte corre 1×/día).
async function fetchTab(tab, id) {
  const creds = loadCredentials();
  const token = await getAccessToken(creds);
  // Rango = título de la pestaña entre comillas simples (tiene espacios) → todo el tab.
  const range = encodeURIComponent(`'${tab}'`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`[sheets] valores ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()).values || [];
}

// Filas del tab de leads (postulaciones del Form).
export async function fetchLeadRows({ id = LEADS_ID(), tab = LEADS_TAB() } = {}) {
  return fetchTab(tab, id);
}

// Filas del tab "📞 Setteo Pendiente" (fuente del conteo de self-checkout).
export async function fetchSetteoRows({ id = LEADS_ID(), tab = SETTEO_TAB() } = {}) {
  return fetchTab(tab, id);
}

// Lector genérico: filas crudas de CUALQUIER spreadsheet/pestaña (mismo service
// account). Lo usa el reporte de métricas de desempeño (§18.N), que vive en otro
// archivo. El dueño debe compartir ese spreadsheet con el email del SA.
export async function fetchSheetValues({ id, tab }) {
  return fetchTab(tab, id);
}
