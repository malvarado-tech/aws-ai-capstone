#!/bin/bash
#
# resolve-stack.sh — resuelve CUÁL es el stack del capstone. Se hace `source`, no se ejecuta.
#
#   . "$(dirname "$0")/lib/resolve-stack.sh"    # define STACK_NAME, STACK_FUENTE, STACK_FOUND
#
# ── Por qué existe ──────────────────────────────────────────────────────────────────────
# El nombre del stack tiene TRES fuentes que pueden discrepar, y cada script del repo elegía
# una distinta:
#
#   1. $STACK_NAME        — el entorno del workshop lo ASIGNA desde /etc/profile.d/.
#                           Ojo: viene de un profile, así que está VACÍO en shells no
#                           interactivos (cron, hooks, `bash script.sh` desde un editor).
#   2. samconfig.toml     — lo que `sam deploy` usa de verdad, o sea lo que realmente existe.
#   3. techmoda-ai        — el default de la documentación, que en una cuenta compartida
#                           suele estar tomado por otro participante.
#
# Elegir a ciegas da el peor de los fallos: el comando corre bien y reporta sobre el stack
# equivocado (o sobre ninguno). Así que probamos los tres EN ORDEN y nos quedamos con el
# primero que EXISTE en CloudFormation, diciendo cuál fue.
#
# Los scripts de BORRADO (delete.sh, delete-all.sh, fix-failed-delete.sh) NO usan esto a
# propósito: resolver automáticamente hacia `techmoda-ai` en una cuenta compartida podría
# apuntar un `delete` al stack de otra persona. Ahí el nombre se pasa explícito.
#
# Historia: capstone/docs/TROUBLESHOOTING.md#8
# ────────────────────────────────────────────────────────────────────────────────────────

STACK_REGION="${AWS_REGION:-us-east-1}"

# ¿Existe el stack? describe-stacks devuelve error si no, o si está en DELETE_COMPLETE.
_stack_existe() {
  aws cloudformation describe-stacks --stack-name "$1" --region "$STACK_REGION" \
    --query 'Stacks[0].StackName' --output text >/dev/null 2>&1
}

STACK_SAMCFG=""
if [ -f samconfig.toml ]; then
  # Sólo líneas que EMPIEZAN con stack_name: un comentario que mencione el token daría una
  # segunda línea y `cut` devolvería dos valores pegados. Pasó de verdad, ver el #3 del doc.
  STACK_SAMCFG="$(grep -E '^[[:space:]]*stack_name' samconfig.toml | head -1 | cut -d'"' -f2)"
fi

STACK_ASIGNADO="${STACK_NAME:-}"     # lo que traía el entorno, antes de que lo sobreescribamos
STACK_FUENTE=""
STACK_FOUND=0

for _cand in "$STACK_ASIGNADO" "$STACK_SAMCFG" "techmoda-ai"; do
  [ -z "$_cand" ] && continue
  if _stack_existe "$_cand"; then
    STACK_NAME="$_cand"
    STACK_FOUND=1
    case "$_cand" in
      "$STACK_ASIGNADO") STACK_FUENTE='$STACK_NAME (asignado por el entorno)' ;;
      "$STACK_SAMCFG")   STACK_FUENTE='samconfig.toml' ;;
      *)                 STACK_FUENTE='default de la documentación' ;;
    esac
    break
  fi
done

# Ninguno existe: dejamos el mejor candidato para que el caller imprima SU mensaje de error
# (status.sh y validate-all.sh ya tienen uno bueno, con el comando de deploy).
if [ "$STACK_FOUND" -eq 0 ]; then
  STACK_NAME="${STACK_ASIGNADO:-${STACK_SAMCFG:-techmoda-ai}}"
  STACK_FUENTE='ninguno existe (candidato sin verificar)'
fi

# Avisar cuando las fuentes discrepan. No es fatal — pero es la diferencia entre "mi comando
# no anda" y "mi comando anda y me está mintiendo sobre otro stack".
if [ -n "$STACK_ASIGNADO" ] && [ -n "$STACK_SAMCFG" ] && [ "$STACK_ASIGNADO" != "$STACK_SAMCFG" ]; then
  printf '\033[33m⚠ $STACK_NAME (%s) y samconfig.toml (%s) no coinciden.\033[0m\n' \
    "$STACK_ASIGNADO" "$STACK_SAMCFG" >&2
  printf '  Usando el que existe: %s  (fuente: %s)\n' "$STACK_NAME" "$STACK_FUENTE" >&2
fi

export STACK_NAME STACK_REGION STACK_FUENTE STACK_FOUND STACK_SAMCFG STACK_ASIGNADO
