#!/bin/sh
# entrypoint.sh — backoff exponencial entre reinicios del agente.
# Evita el loop rápido de reconexiones que trigerea la detección de WhatsApp.
# Docker aplica su propio delay después de MAX_FAILS salidas consecutivas.

ATTEMPT=0
MAX_FAILS=8
DELAYS="30 60 120 240 300"

run() {
  node src/db/migrate.js && node src/index.js
  return $?
}

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "[entrypoint] Intento $ATTEMPT de $MAX_FAILS"

  run
  EXIT=$?

  # Salida limpia (ej: loggedOut con exit 2, o señal de stop)
  if [ $EXIT -eq 0 ] || [ $EXIT -eq 2 ]; then
    echo "[entrypoint] Proceso terminó con exit $EXIT — sin reintentos automáticos"
    exit $EXIT
  fi

  if [ $ATTEMPT -ge $MAX_FAILS ]; then
    echo "[entrypoint] $MAX_FAILS fallos consecutivos — cediendo control a Docker (restart policy)"
    exit 1
  fi

  # Índice del delay: cap en el último valor de la lista
  IDX=$((ATTEMPT > 5 ? 5 : ATTEMPT))
  DELAY=$(echo "$DELAYS" | tr ' ' '\n' | sed -n "${IDX}p")
  echo "[entrypoint] Crash (exit $EXIT), esperando ${DELAY}s antes de reintentar..."
  sleep "$DELAY"
done
