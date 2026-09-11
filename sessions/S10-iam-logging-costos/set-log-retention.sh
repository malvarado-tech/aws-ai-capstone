#!/usr/bin/env bash
# S10 · Fija la retención de los log groups del stack (FinOps + privacidad, dominio D5).
#
# ¿Por qué un script y no el template? Porque Lambda crea
# /aws/lambda/<función> SOLO, en la primera invocación, y nace con
# retentionInDays = None (retención INFINITA). Declararlo como AWS::Logs::LogGroup en
# el template después de que ya existe hace fallar el deploy con "already exists": el
# recurso no lo maneja CloudFormation. Las dos salidas son declarar el log group ANTES
# de la primera invocación (o sea, en el template desde el día 0) o arreglarlo aparte,
# como acá.
#
# Por qué importa, medido en esta cuenta: el log group de invocaciones de Bedrock que
# otro participante habilitó a nivel cuenta/región está en `None` y ya lleva ~69 MB de
# prompts y respuestas de 11 identidades distintas. Los logs de IA guardan el texto que
# el usuario escribió: retención infinita es a la vez costo que crece para siempre y
# datos personales que nunca se borran (GDPR/LFPDPPP: minimización y limitación del
# plazo de conservación).
set -uo pipefail

REGION="${AWS_REGION:-us-east-1}"
DAYS="${RETENTION_DAYS:-30}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# El nombre del stack tiene tres fuentes que discrepan: se usa el resolver compartido.
. "$ROOT/scripts/lib/resolve-stack.sh"
if [ "${STACK_FOUND:-0}" -ne 1 ]; then
  echo "✗ No encontré el stack en $REGION. Desplegá primero." >&2
  exit 1
fi
STACK="$STACK_NAME"

echo "▶ Fijando retención de $DAYS días  ·  stack=$STACK  region=$REGION"

n=0
for lg in $(aws logs describe-log-groups \
              --log-group-name-prefix "/aws/lambda/$STACK" --region "$REGION" \
              --query 'logGroups[].logGroupName' --output text) \
          $(aws logs describe-log-groups \
              --log-group-name-prefix "/techmoda/$STACK" --region "$REGION" \
              --query 'logGroups[].logGroupName' --output text); do
  actual=$(aws logs describe-log-groups --log-group-name-prefix "$lg" --region "$REGION" \
             --query "logGroups[?logGroupName=='$lg'].retentionInDays" --output text)
  if [ "$actual" = "$DAYS" ]; then
    printf '  = %-72s ya en %s\n' "$lg" "$DAYS"
    continue
  fi
  if aws logs put-retention-policy --log-group-name "$lg" \
       --retention-in-days "$DAYS" --region "$REGION" 2>/dev/null; then
    printf '  \033[32m✓\033[0m %-72s %s -> %s\n' "$lg" "${actual:-None}" "$DAYS"
    n=$((n+1))
  else
    printf '  \033[31m✗\033[0m %-72s (sin permiso logs:PutRetentionPolicy)\n' "$lg"
  fi
done

echo "✓ $n log group(s) actualizados."
echo "  Verificá:  aws logs describe-log-groups --log-group-name-prefix /aws/lambda/$STACK \\"
echo "               --region $REGION --query 'logGroups[].[logGroupName,retentionInDays]' --output table"
