#!/bin/sh
# scripts/deploy-setteo.sh — despliegue del setteo del closer (§18.AZ) al VPS.
# Corre EN el VPS: sh /root/juanito/scripts/deploy-setteo.sh
# (La copia que ya corrió allá se llama deploy-18AV.sh: §18.AV era el número de la sección
#  antes del merge con main, donde esa letra ya estaba tomada por otra cosa.)
#
# Despliega el código con la feature APAGADA. No prende nada: SETTEO_CAPTURE_ENABLED
# no se toca acá, se prende aparte después de verificar.
#
# ⚠️ El paso caro no es el build, es la RECONEXIÓN de WhatsApp. Por eso el guard: si hay un
# push por entregar en los próximos 10 min, se aborta. Un Push 3 es un recordatorio precall
# —sale 15 min antes de la llamada— y perderlo por un rebuild es un closer sin aviso.
# Historia del softban: no encadenar reconexiones. Ver CLAUDE.md y §18.AT/AU.

set -e
cd /root/juanito

echo "═══ Deploy §18.AZ — $(date -u '+%Y-%m-%d %H:%M:%S') UTC ═══"

# ── Guard de ventana ─────────────────────────────────────────────────────────
PENDIENTES=$(docker exec juanito-agent node -e "
const db=require('better-sqlite3')('/app/data/brain.sqlite',{readonly:true});
console.log(db.prepare(\"SELECT COUNT(*) c FROM calendly_pushes WHERE status='scheduled' AND due_at BETWEEN datetime('now') AND datetime('now','+10 minutes')\").get().c);
" 2>/dev/null || echo "?")

if [ "$PENDIENTES" = "?" ]; then
  echo "⚠️  No pude consultar los pushes pendientes (¿contenedor caído?). Revisá antes de seguir."
  exit 1
fi
if [ "$PENDIENTES" != "0" ]; then
  echo "❌ ABORTADO: $PENDIENTES push(es) por entregar en los próximos 10 min."
  echo "   Un rebuild acá deja a un closer sin su recordatorio precall. Esperá al hueco."
  exit 1
fi
echo "✅ Guard: sin pushes en los próximos 10 min."

# ── Estado previo, para poder comparar después ───────────────────────────────
echo "── Antes ──"
docker inspect juanito-agent --format '  imagen: {{.Image}}'
echo "  uptime: $(docker ps --filter name=juanito-agent --format '{{.Status}}')"

# ── Rebuild ──────────────────────────────────────────────────────────────────
echo "── Rebuild (1 reconexión de WA) ──"
docker compose up -d --build

echo "── Esperando a que reconecte (hasta 90s) ──"
i=0
while [ $i -lt 18 ]; do
  sleep 5
  i=$((i + 1))
  if docker logs juanito-agent --tail 60 2>&1 | grep -q "opened connection to WA"; then
    echo "✅ WA reconectado en ~$((i * 5))s"
    break
  fi
  if docker logs juanito-agent --tail 60 2>&1 | grep -qi "scan the qr\|QR refs"; then
    echo "🔴 PIDIÓ QR — la sesión se perdió. NO sigas: revertí con la imagen juanito-agent:pre-18AV-20260803"
    exit 1
  fi
done

# ── Verificación ─────────────────────────────────────────────────────────────
echo ""
echo "── Verificación ──"

VARS=$(docker compose config 2>/dev/null | grep -cE "SETTEO_CAPTURE_ENABLED|SETTEO_CAPTURE_CLOSERS|SETTEO_AI_FALLBACK|SETTEO_AI_MODEL|SETTEO_AI_TIMEOUT_MS|SETTEO_CUOTA_POR_HORA|SETTEO_JORNADA_INICIO|SETTEO_JORNADA_FIN|SETTEO_MINUTOS_POR_CALL|CLOSER_DAILY_LIMIT")
echo "  vars nuevas en el contenedor: $VARS/10 $([ "$VARS" = "10" ] && echo '✅' || echo '❌ ← el bug de siempre: falta alguna en el environment: del compose')"

TABLA=$(docker exec juanito-agent node -e "
const db=require('better-sqlite3')('/app/data/brain.sqlite',{readonly:true});
const t=db.prepare(\"SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='setteos'\").get().c;
const i=db.prepare(\"SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_setteos_closer_fecha'\").get().c;
console.log(t+'/'+i);
" 2>/dev/null)
echo "  tabla setteos / índice: $TABLA $([ "$TABLA" = "1/1" ] && echo '✅' || echo '❌')"

CAPTURA=$(docker exec juanito-agent printenv SETTEO_CAPTURE_ENABLED 2>/dev/null || echo "vacía")
echo "  SETTEO_CAPTURE_ENABLED: $CAPTURA $([ "$CAPTURA" = "false" ] || [ "$CAPTURA" = "vacía" ] && echo '✅ (apagada, como debe estar)' || echo '⚠️ PRENDIDA sin verificar')"

echo ""
echo "  Jobs y conexión:"
docker logs juanito-agent --tail 40 2>&1 | grep -E "Conectado ✅|Jobs activos|Job de|error|Error" | sed 's/^/    /' | tail -12

echo ""
echo "═══ Deploy terminado. La feature sigue APAGADA. ═══"
echo "Para prender el piloto (2 closers), en /root/juanito/.env:"
echo "  SETTEO_CAPTURE_ENABLED=true"
echo "  SETTEO_CAPTURE_CLOSERS=sebastian@30x.com,pablo.lozano@30x.com"
echo "y aplicar SOLO env (sin --build, 1 sola reconexión):  docker compose up -d"
echo ""
echo "⚠️ Sin SETTEO_CAPTURE_CLOSERS explícito hereda CALENDLY_PUSH4_CLOSERS = 6 closers, no 2."
echo "Rollback:  docker compose down && docker tag juanito-agent:pre-18AV-20260803 juanito-agent && docker compose up -d"
