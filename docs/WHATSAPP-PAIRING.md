# Vinculación de WhatsApp (Juanito) — Qué hacer y qué NO

> Guía operativa para vincular el número del agente. Léela completa antes de
> tocar la conexión de WhatsApp. Ignorarla lleva al bloqueo de WhatsApp.

## ⛔ Regla de oro

**NUNCA vincular el número del agente directamente desde el VPS.**

WhatsApp **rechaza el registro de dispositivos nuevos desde IPs de datacenter**
(DigitalOcean, AWS, etc.). El teléfono muestra *"no se pueden conectar
dispositivos en este momento"* aunque el QR se escanee perfecto.

La vinculación se hace **siempre desde una IP residencial** (la máquina del jefe)
y luego se **copia la sesión autenticada** al VPS.

## Síntomas de que caíste en la trampa

- Teléfono: *"no se pueden conectar dispositivos en este momento"* tras escanear.
- Logs del VPS: `Error: QR refs attempts ended` + `Conexión cerrada — razón: 408`
  en loop, generando QR tras QR.
- **Mejorar cómo se muestra el QR (PNG, servidor web, etc.) NO sirve de nada** —
  el bloqueo es del lado del servidor de WhatsApp por la IP, no de escaneo.

## ✅ Procedimiento correcto para (re)vincular

Todo desde la **máquina local del jefe** (IP residencial):

1. Instalar dependencias sin compilar nativos (better-sqlite3 no compila en
   Windows y el pairing no lo necesita):
   ```
   npm install --ignore-scripts
   ```
2. Correr el script de pairing standalone (solo Baileys, sin DB ni Claude):
   ```
   node scripts/pair-local.js
   ```
   Genera `data/wa-session/` (la sesión) y `data/wa-qr.png` (el QR como imagen).
3. Abrir `data/wa-qr.png` y escanearlo con el teléfono de Juanito
   (WhatsApp → ⋮ → Dispositivos vinculados → Vincular un dispositivo).
   El QR rota cada ~20s; el script regenera la imagen sola.
4. Cuando el script imprime `✅ VINCULADO OK` y sale con código 0, copiar
   `data/wa-session/` al volumen `juanito_agent-data` del VPS:
   - Parar el contenedor: `docker compose stop`
   - Reemplazar `wa-session` dentro del volumen por la carpeta local
     (vía `pscp` + un contenedor `alpine` throwaway con `cp -a`).
   - Levantar: `docker compose up -d`
5. Verificar en los logs del VPS: debe aparecer `[WhatsApp] Conectado ✅`
   **sin** generar QR. Reconecta como dispositivo ya vinculado.

**Por qué funciona:** WhatsApp solo escruta el *registro inicial* del dispositivo
companion. Un dispositivo ya vinculado reconecta desde cualquier IP (incluida la
del datacenter) sin que WhatsApp lo cuestione.

## ❌ Qué NO hacer

- **NO** escanear el QR que genera el contenedor del VPS (ni terminal ni web).
- **NO** correr `scripts/pair-local.js` ni el app local mientras el VPS esté
  conectado: dos clientes con la misma sesión **rompen la conexión** y pueden
  forzar un re-login.
- **NO** exponer puertos en `docker-compose.yml` (Baileys es conexión saliente).
  Un intento previo dejó `QR_PORT=3001` + `ports: "3001:3001"`; ya fue removido.
- **NO** reiniciar el proceso en loop rápido. Ver `entrypoint.sh` y la historia
  del softban en `CLAUDE.md`.

## Infra (datos no obvios)

- VPS DigitalOcean, IP fija `157.230.152.202`. El código vive en `/root/juanito`
  y **NO es un repo git** — se copió manualmente. Para desplegar cambios se usa
  `pscp`, no `git pull`.
- Acceso SSH al VPS: **solo por contraseña** (no hay llave en `~/.ssh`). Desde
  Windows usar `plink`/`pscp` de PuTTY (`C:\Program Files\PuTTY\`) con `-pw`.
- El volumen Docker con la sesión y la DB es `juanito_agent-data`, montado en
  `/app/data` dentro del contenedor.
