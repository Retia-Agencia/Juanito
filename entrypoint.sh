#!/bin/sh
# entrypoint.sh — backoff exponencial entre reinicios del agente.
# Evita el loop rápido de reconexiones que trigerea la detección de WhatsApp.
# Docker aplica su propio delay después de MAX_FAILS salidas consecutivas.

ATTEMPT=0
MAX_FAILS=8
DELAYS="30 60 120 240 300"

# Uptime que convierte una caída en AISLADA en vez de parte de la racha anterior.
#
# Por qué hace falta (medido 2026-08-26, §18.BN): `ATTEMPT` solo subía. El bot corría sano 4
# horas, se le caía el socket de WhatsApp (razón 428, transitoria y rutinaria), y el contador
# seguía escalando igual. En 13 horas llegó a "Intento 5 de 8" sin que hubiera existido nunca un
# crash loop. A los 8 este script se rinde y le cede el control a la restart policy de Docker,
# QUE NO TIENE BACKOFF — o sea que ocho caídas sueltas repartidas en un día sacaban al bot del
# único mecanismo que lo protege del softban. Exactamente al revés de para lo que existe.
#
# ⚠️ Esto NO afloja el backoff, y esa es la propiedad que hay que conservar al tocarlo. Un crash
# loop de verdad (el del softban: el proceso muere en segundos y el supervisor lo relanza) jamás
# alcanza este umbral, así que sigue escalando 30→60→120→240→300 y sigue rindiéndose a los 8
# intentos, idéntico a antes. Lo único que cambia es el caso que NO es un loop.
#
# 10 min: más que cualquier arranque fallido plausible (migración + vinculación + primer
# connection.update tardan segundos) y mucho menos que el tiempo entre caídas 428 reales, que
# fueron de 45 min a 4 h.
#
# El env existe para bajarlo en una PRUEBA (ver scripts/test-entrypoint.sh), no para operarlo:
# a propósito NO está en el `environment:` de docker-compose ni en .env.example, así que ponerlo
# en el `.env` del VPS no hace nada. Si algún día hay que ajustarlo en producción, se agrega al
# compose en el mismo cambio — un env documentado que no llega al contenedor es una trampa.
HEALTHY_SEC=${ENTRYPOINT_HEALTHY_SEC:-600}

run() {
  node src/db/migrate.js && node src/index.js
  return $?
}

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "[entrypoint] Intento $ATTEMPT de $MAX_FAILS"

  START=$(date +%s)
  run
  EXIT=$?
  UPTIME=$(($(date +%s) - START))

  # Salida limpia (ej: loggedOut con exit 2, o señal de stop)
  if [ $EXIT -eq 0 ] || [ $EXIT -eq 2 ]; then
    echo "[entrypoint] Proceso terminó con exit $EXIT — sin reintentos automáticos"
    exit $EXIT
  fi

  # Corrió sano el tiempo suficiente ⇒ esta caída no es continuación de la anterior: la racha
  # se corta acá. Va ANTES del corte por MAX_FAILS a propósito, que es todo el punto del
  # arreglo: un arranque sano tiene que poder devolverle al bot sus 8 intentos.
  if [ "$UPTIME" -ge "$HEALTHY_SEC" ]; then
    echo "[entrypoint] Corrió ${UPTIME}s (≥ ${HEALTHY_SEC}s) antes de caerse: caída aislada, reinicio el contador."
    ATTEMPT=0
  fi

  if [ $ATTEMPT -ge $MAX_FAILS ]; then
    echo "[entrypoint] $MAX_FAILS fallos consecutivos — cediendo control a Docker (restart policy)"
    exit 1
  fi

  # Índice del delay: cap en el último valor de la lista. El piso en 1 es por el reset de
  # arriba: con ATTEMPT=0, `sed -n "0p"` no devuelve NADA y `sleep ""` revienta — el bot se
  # reiniciaría sin ninguna espera, que es justo el loop rápido que este script existe para
  # evitar. Tras un reset la espera es la primera de la lista (30s), y la vuelta siguiente
  # imprime "Intento 1 de 8".
  IDX=$((ATTEMPT > 5 ? 5 : ATTEMPT))
  [ "$IDX" -lt 1 ] && IDX=1
  DELAY=$(echo "$DELAYS" | tr ' ' '\n' | sed -n "${IDX}p")
  echo "[entrypoint] Crash (exit $EXIT), esperando ${DELAY}s antes de reintentar..."
  sleep "$DELAY"
done
