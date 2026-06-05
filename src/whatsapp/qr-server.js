// src/whatsapp/qr-server.js
// Servidor HTTP que sirve el QR de pairing como imagen PNG generada server-side.
// Sin dependencias de CDN ni JS del cliente.
// Activar: QR_PORT=3001 en .env + exponer el puerto en docker-compose.
// Desactivar (producción): dejar QR_PORT sin valor.

import { createServer } from 'http';
import QRCode from 'qrcode';

let currentQR = null;
let connected = false;

export function updateQR(qr) {
  currentQR = qr;
}

export function markConnected() {
  connected = true;
  currentQR = null;
}

export function startQRServer(port) {
  if (!port) return;

  const server = createServer(async (req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ connected, hasQR: !!currentQR }));
      return;
    }

    if (req.url?.startsWith('/qr.png')) {
      if (connected) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        res.end(Buffer.alloc(0));
        return;
      }
      if (!currentQR) {
        res.writeHead(204);
        res.end();
        return;
      }
      try {
        const png = await QRCode.toBuffer(currentQR, { width: 300, margin: 2 });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache, no-store' });
        res.end(png);
      } catch {
        res.writeHead(500);
        res.end();
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[QR] Abrí http://<IP-del-VPS>:${port} en tu navegador para escanear el QR`);
  });
}

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Juanito — Vincular WhatsApp</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
    .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 2px 16px rgba(0,0,0,.12); text-align: center; max-width: 340px; width: 100%; }
    h1 { margin: 0 0 .4rem; font-size: 1.3rem; }
    .hint { color: #777; font-size: .85rem; margin: 0 0 1.5rem; }
    #qr-img { width: 280px; height: 280px; border-radius: .5rem; display: block; margin: 0 auto; background: #eee; }
    #msg { margin-top: 1rem; font-size: .9rem; color: #555; min-height: 1.2em; }
    .ok { color: #25d366; font-weight: bold; font-size: 1.1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Vincular Juanito</h1>
    <p class="hint">WhatsApp → ⋮ → Dispositivos vinculados → Vincular un dispositivo</p>
    <img id="qr-img" alt="QR Code" />
    <p id="msg">Cargando QR...</p>
  </div>
  <script>
    const img = document.getElementById('qr-img');
    const msg = document.getElementById('msg');

    async function poll() {
      try {
        const { connected, hasQR } = await fetch('/status').then(r => r.json());
        if (connected) {
          img.style.display = 'none';
          msg.className = 'ok';
          msg.textContent = '\\u2705 \\u00a1Conectado! Pod\\u00e9s cerrar esta p\\u00e1gina.';
          return;
        }
        if (hasQR) {
          img.src = '/qr.png?t=' + Date.now();
          msg.textContent = 'QR activo \\u2014 escane\\u00e1lo (expira en ~20s, se refresca solo)';
        } else {
          msg.textContent = 'Esperando QR del servidor...';
        }
      } catch {
        msg.textContent = 'Reintentando...';
      }
      setTimeout(poll, 3000);
    }

    poll();
  </script>
</body>
</html>`;
