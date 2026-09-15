#!/usr/bin/env bash
# scripts/vps.sh — único punto de entrada para hablarle al VPS.
#
# Existe por dos razones concretas:
#
# 1. LA CONTRASEÑA NO VIAJA EN LA LÍNEA DE COMANDO. Antes cada operación se escribía como
#    `plink -pw "<VPS_KEY>" …`, y cuando se aprueba un permiso para ese comando, la regla
#    guardada en .claude/settings.local.json queda con la contraseña EN TEXTO PLANO. Acá la
#    clave se lee del .env adentro del script y nunca aparece en el comando ni en los logs.
#
# 2. REGLAS DE PERMISO ANGOSTAS. Con un único ejecutable, autorizar el acceso al VPS es una
#    sola regla (`Bash(bash scripts/vps.sh *)`) en vez de un glob suelto sobre plink/pscp.
#
# Multiplataforma como pide CLAUDE.md: plink/pscp en Windows (no hay clave pública cargada),
# sshpass en Mac/Linux.
#
# Uso:
#   scripts/vps.sh run  "<comando remoto>"        ejecuta y devuelve la salida
#   scripts/vps.sh put  <local> <remoto>          sube un archivo
#   scripts/vps.sh get  <remoto> <local>          baja un archivo
#
# Ejemplos:
#   scripts/vps.sh run "docker ps --format '{{.Names}} {{.Status}}'"
#   scripts/vps.sh put scripts/refire-digest.js /root/refire-digest.js

set -euo pipefail

VPS_HOST="${VPS_HOST:-root@157.230.152.202}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "vps.sh: no encuentro $ENV_FILE (de ahí sale VPS_KEY)" >&2
  exit 1
fi

# `tr -d '\r'` no es cosmético: el .env editado en Windows trae CRLF y sin esto la clave se
# manda con un \r pegado. Falla como si la contraseña fuera incorrecta, que manda a depurar
# al lado equivocado.
VPS_KEY="$(grep -E '^VPS_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
if [[ -z "$VPS_KEY" ]]; then
  echo "vps.sh: VPS_KEY vacía en $ENV_FILE" >&2
  exit 1
fi

PLINK="/c/Program Files/PuTTY/plink.exe"
PSCP="/c/Program Files/PuTTY/pscp.exe"
usar_putty() { [[ -x "$PLINK" ]]; }

accion="${1:-}"
shift || true

case "$accion" in
  run)
    [[ $# -ge 1 ]] || { echo "uso: vps.sh run \"<comando>\"" >&2; exit 1; }
    if usar_putty; then
      "$PLINK" -ssh -batch -pw "$VPS_KEY" "$VPS_HOST" "$1"
    else
      SSHPASS="$VPS_KEY" sshpass -e ssh -o StrictHostKeyChecking=accept-new "$VPS_HOST" "$1"
    fi
    ;;
  put)
    [[ $# -ge 2 ]] || { echo "uso: vps.sh put <local> <remoto>" >&2; exit 1; }
    if usar_putty; then
      "$PSCP" -batch -pw "$VPS_KEY" "$1" "$VPS_HOST:$2"
    else
      SSHPASS="$VPS_KEY" sshpass -e scp -o StrictHostKeyChecking=accept-new "$1" "$VPS_HOST:$2"
    fi
    ;;
  get)
    [[ $# -ge 2 ]] || { echo "uso: vps.sh get <remoto> <local>" >&2; exit 1; }
    if usar_putty; then
      "$PSCP" -batch -pw "$VPS_KEY" "$VPS_HOST:$1" "$2"
    else
      SSHPASS="$VPS_KEY" sshpass -e scp -o StrictHostKeyChecking=accept-new "$VPS_HOST:$1" "$2"
    fi
    ;;
  *)
    echo "uso: vps.sh {run|put|get} …  (ver el encabezado del script)" >&2
    exit 1
    ;;
esac
