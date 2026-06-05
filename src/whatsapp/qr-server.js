// src/whatsapp/qr-server.js
// Servidor HTTP mínimo que sirve el QR de pairing como página web.
// Activar: QR_PORT=3001 en .env + exponer el puerto en docker-compose.
// Desactivar (producción): dejar QR_PORT sin valor.

import { createServer } from 'http';

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

  const server = createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ qr: currentQR, connected }));
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
    .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 2px 16px rgba(0,0,0,.12); text-align: center; }
    h1 { margin: 0 0 .4rem; font-size: 1.3rem; }
    .hint { color: #777; font-size: .85rem; margin: 0 0 1.5rem; }
    canvas { border-radius: .5rem; display: block; margin: 0 auto; }
    #msg { margin-top: 1rem; font-size: .9rem; color: #555; min-height: 1.2em; }
    .ok { color: #25d366; font-weight: bold; font-size: 1.1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Vincular Juanito</h1>
    <p class="hint">WhatsApp → ⋮ → Dispositivos vinculados → Vincular un dispositivo</p>
    <canvas id="qr" width="280" height="280"></canvas>
    <p id="msg">Cargando QR...</p>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
  <script>
    const canvas = document.getElementById('qr');
    const msg = document.getElementById('msg');

    async function poll() {
      try {
        const { qr, connected } = await fetch('/status').then(r => r.json());
        if (connected) {
          canvas.style.display = 'none';
          msg.className = 'ok';
          msg.textContent = '✅ ¡Conectado! Podés cerrar esta página.';
          return;
        }
        if (qr) {
          QRCode.toCanvas(canvas, qr, { width: 280, margin: 2 });
          msg.textContent = 'QR activo — escanealo (expira en ~20s, se refresca solo)';
        } else {
          msg.textContent = 'Esperando QR del servidor...';
        }
      } catch {
        msg.textContent = 'Error conectando al servidor, reintentando...';
      }
      setTimeout(poll, 3000);
    }

    poll();
  </script>
</body>
</html>`;
