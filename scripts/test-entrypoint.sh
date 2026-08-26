#!/bin/sh
# scripts/test-entrypoint.sh — verificación del backoff de entrypoint.sh SIN arrancar el bot.
#
# Por qué existe: `entrypoint.sh` es el archivo que CLAUDE.md prohíbe tocar sin entender el
# softban, y hasta ahora la única forma de comprobar su comportamiento era desplegarlo y
# esperar a que se cayera. Esto lo ejercita en segundos stubeando `node` y `sleep`.
#
# Las DOS propiedades que hay que conservar en cualquier cambio:
#   A. Un crash loop de verdad (el del softban: muere en segundos) escala 30→60→120→240→300
#      y se rinde a los 8 intentos.
#   B. Una caída aislada tras un arranque sano reinicia el contador, PERO igual espera antes
#      de reintentar. Si el caso B alguna vez imprime `sleep` vacío o no imprime ninguno, el
#      arreglo del contador se convirtió en el loop rápido que el script existe para evitar.
#
# Uso, desde la raíz del repo:
#   sh scripts/test-entrypoint.sh .
#
# Y bajo el shell REAL de producción (busybox, no el sh del Mac), que es donde vale:
#   docker run --rm -v "$PWD:/ep" -w /ep --entrypoint sh juanito-agent /ep/scripts/test-entrypoint.sh /ep
set -e
REPO=${1:-.}
BIN=$(mktemp -d)

# `node` falso: la migración pasa siempre; el bot "vive" FAKE_UPTIME segundos y crashea.
cat > "$BIN/node" <<'EOF'
#!/bin/sh
case "$1" in
  *migrate.js) exit 0 ;;
  *index.js)   [ "${FAKE_UPTIME:-0}" -gt 0 ] && /bin/sleep "$FAKE_UPTIME"; exit 1 ;;
esac
EOF

# `sleep` falso: imprime en vez de esperar, así el backoff se puede LEER sin tardar 20 minutos.
cat > "$BIN/sleep" <<'EOF'
#!/bin/sh
echo "[stub] sleep $1"
EOF

chmod +x "$BIN/node" "$BIN/sleep"
export PATH="$BIN:$PATH"
cd "$REPO"

echo "═══ A · crash loop (uptime 0s, umbral 5s): tiene que escalar y rendirse ═══"
FAKE_UPTIME=0 ENTRYPOINT_HEALTHY_SEC=5 sh ./entrypoint.sh || true

echo
echo "═══ B · caídas aisladas (uptime 2s, umbral 1s): el contador se reinicia siempre ═══"
echo "    (corre infinito a propósito — se cortan 24 líneas; sin el arreglo llegaría a 'Intento 8')"
FAKE_UPTIME=2 ENTRYPOINT_HEALTHY_SEC=1 sh ./entrypoint.sh 2>&1 | head -24 || true

rm -rf "$BIN"
