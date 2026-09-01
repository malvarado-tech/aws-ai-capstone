#!/usr/bin/env bash
# ============================================================================
# capture.sh — Genera la EVIDENCIA local de que las sesiones del capstone se
# ejecutaron de verdad contra AWS.
#
# Por qué existe: la rúbrica (instructor/EVALUATION_RUBRIC.md) pide evidencia de
# pruebas exitosas. Capturas de pantalla no se pueden versionar ni verificar; la
# salida real de los comandos sí — se puede leer, diffear y volver a generar.
#
# Uso:
#   bash evidence/capture.sh              # todas las sesiones desplegadas
#   bash evidence/capture.sh S00          # solo una
#   STACK_NAME=otro-stack bash evidence/capture.sh
#
# Cada sesión sólo se captura si sus recursos existen en el stack: correr esto
# después de S01 no falla por S02–S08 sin desplegar, las marca como pendientes.
#
# ⚠️ NO es de sólo lectura al 100%:
#   - el bloque CRUD crea un producto de prueba y lo borra al final;
#   - el bloque S01 vuelve a llamar a Rekognition (se cobra POR IMAGEN, centavos)
#     y reescribe aiLabels con el mismo valor.
# Nada queda modificado de forma permanente.
# ============================================================================
set -uo pipefail

REGION="${AWS_REGION:-us-east-1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EV="$ROOT/evidence"
ONLY="${1:-}"
cd "$ROOT" || exit 1

# ---------------------------------------------------------------------------
# Resolver el stack: hay tres fuentes que pueden discrepar ($STACK_NAME del entorno,
# samconfig.toml, el default de la doc) y acá discrepan de verdad. La lógica vive en
# scripts/lib/resolve-stack.sh — una sola copia, compartida con validate-all.sh, status.sh y
# logs.sh, porque tres resolvers distintos era exactamente el bug (ver TROUBLESHOOTING #8).
# ---------------------------------------------------------------------------
. "$ROOT/scripts/lib/resolve-stack.sh"
STACK=""
[ "$STACK_FOUND" -eq 1 ] && STACK="$STACK_NAME"   # vacío = ninguno de los tres existe
SAMCFG="$STACK_SAMCFG"; FUENTE="$STACK_FUENTE"

if [ -z "$STACK" ]; then
  echo "✗ Ningún stack candidato existe en $REGION:"
  echo "    \$STACK_NAME      = ${STACK_ASIGNADO:-<vacío>}"
  echo "    samconfig.toml   = ${SAMCFG:-<sin samconfig.toml>}"
  echo "    default          = techmoda-ai"
  echo "  Desplegá primero:  bash scripts/deploy-all.sh"
  exit 1
fi
# El aviso de discrepancia entre fuentes lo imprime resolve-stack.sh (a stderr).

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  \033[33m-\033[0m %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Escribe la salida de un comando en un archivo, con encabezado reproducible.
cap() {
  local out="$1"; shift
  mkdir -p "$(dirname "$out")"
  {
    echo "# $STAMP  ·  stack=$STACK  region=$REGION"
    # El comando puede ser MULTILÍNEA (bash -c '...', python3 -c '...'). Hay que
    # comentar TODAS sus líneas: si sólo se comenta la primera, el resto del código
    # queda indistinguible del contenido y cualquier parseo posterior que descarte
    # líneas '#' se traga el código fuente como si fueran datos.
    printf '%s\n' "$*" | sed 's/^/# $ /'
    echo "# ---------------------------------------------------------------------------"
    "$@" 2>&1
  } > "$out"
  ok "$(basename "$(dirname "$out")")/$(basename "$out")"
}

out() {  # un output del stack, sin barra final
  local v
  v=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null)
  printf '%s' "${v%/}"
}

API="$(out ApiUrl)"
if [ -z "$API" ]; then
  echo "✗ No pude resolver ApiUrl del stack '$STACK' en $REGION."
  echo "  Desplegá primero:  bash scripts/deploy-all.sh"
  exit 1
fi

echo "▶ Capturando evidencia  ·  $STAMP"
echo "  stack=$STACK  region=$REGION  (fuente del nombre: $FUENTE)"

# ======================================================== ENTORNO ===========
if [ -z "$ONLY" ] || [ "$ONLY" = "env" ]; then
head_ "00 · Entorno y herramientas"
  D="$EV/00-entorno"
  cap "$D/identidad-aws.txt"  aws sts get-caller-identity
  cap "$D/versiones.txt"      bash -c 'sam --version; aws --version; node --version; python3 --version; python3 -m pip --version'
  cap "$D/stack-resources.txt" aws cloudformation describe-stack-resources \
        --stack-name "$STACK" --region "$REGION" \
        --query 'StackResources[].[LogicalResourceId,ResourceType,PhysicalResourceId,ResourceStatus]' --output text
  cap "$D/stack-outputs.json" aws cloudformation describe-stacks \
        --stack-name "$STACK" --region "$REGION" --query 'Stacks[0].Outputs' --output json
  cap "$D/stack-estado.txt"   aws cloudformation describe-stacks \
        --stack-name "$STACK" --region "$REGION" \
        --query 'Stacks[0].[StackName,StackStatus,CreationTime,LastUpdatedTime]' --output text
fi

# ============================================================ S00 ===========
if [ -z "$ONLY" ] || [ "$ONLY" = "S00" ]; then
head_ "S00 · Base CRUD serverless"
  D="$EV/S00-base"

  cap "$D/01-lambda-router.json" aws lambda get-function-configuration \
        --function-name "$STACK-Router" --region "$REGION" \
        --query '{FunctionName:FunctionName,Runtime:Runtime,Handler:Handler,MemorySize:MemorySize,Timeout:Timeout,Architectures:Architectures,Tracing:TracingConfig.Mode,CodeSize:CodeSize,Env:Environment.Variables,Role:Role}' --output json

  cap "$D/02-function-url.json" aws lambda get-function-url-config \
        --function-name "$STACK-Router" --region "$REGION" \
        --query '{Url:FunctionUrl,AuthType:AuthType,Cors:Cors}' --output json

  cap "$D/03-dynamodb-tabla.json" aws dynamodb describe-table \
        --table-name "$STACK-Products" --region "$REGION" \
        --query 'Table.{Name:TableName,Status:TableStatus,Billing:BillingModeSummary.BillingMode,Keys:KeySchema,Attrs:AttributeDefinitions,ItemCountCache:ItemCount}' --output json

  # ItemCount de DescribeTable se refresca cada ~6 h: el conteo real es un Scan.
  cap "$D/04-dynamodb-conteo-real.txt" aws dynamodb scan \
        --table-name "$STACK-Products" --region "$REGION" --select COUNT \
        --query '{Count:Count,Scanned:ScannedCount}' --output json

  # Rol de mínimo privilegio que SAM generó (el punto pedagógico de D5).
  RROLE=$(aws lambda get-function-configuration --function-name "$STACK-Router" \
            --region "$REGION" --query Role --output text); RROLE=${RROLE##*/}
  cap "$D/05-iam-rol-router.json" aws iam get-role --role-name "$RROLE" \
        --query 'Role.{Name:RoleName,Boundary:PermissionsBoundary.PermissionsBoundaryArn,Trust:AssumeRolePolicyDocument.Statement[0].Principal.Service}' --output json
  cap "$D/06-iam-politicas-router.json" aws iam get-role-policy \
        --role-name "$RROLE" --policy-name RouterFunctionRolePolicy0 \
        --query 'PolicyDocument.Statement' --output json
  cap "$D/07-iam-managed-router.txt" aws iam list-attached-role-policies \
        --role-name "$RROLE" --query 'AttachedPolicies[].PolicyName' --output text

  # CRUD end-to-end por la Function URL del router.
  cap "$D/08-crud-e2e.txt" bash -c "
    set -u
    API='$API'
    echo '--- GET /products'
    curl -s \"\$API/products\" | python3 -m json.tool | head -30
    echo
    echo '--- POST /products'
    NEW=\$(curl -s -X POST \"\$API/products\" -H 'Content-Type: application/json' \
      -d '{\"name\":\"__evidencia__\",\"price\":19.9,\"stock\":7,\"category\":\"Ropa\",\"imageUrl\":\"https://example.com/x.jpg\"}')
    echo \"\$NEW\" | python3 -m json.tool
    PID=\$(echo \"\$NEW\" | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"productId\"])')
    echo
    echo \"--- GET /products/\$PID\"
    curl -s \"\$API/products/\$PID\" | python3 -m json.tool
    echo
    echo \"--- PUT /products/\$PID  (price -> 24.5)\"
    curl -s -X PUT \"\$API/products/\$PID\" -H 'Content-Type: application/json' -d '{\"price\":24.5}' | python3 -m json.tool
    echo
    echo \"--- DELETE /products/\$PID\"
    curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X DELETE \"\$API/products/\$PID\"
    echo '--- (producto de prueba eliminado; el catálogo queda como estaba)'
  "

  # CORS como lo ve un navegador: hay que MANDAR Origin, si no el bug es invisible.
  CFURL="$(out FrontendUrl)"
  cap "$D/09-cors-headers.txt" bash -c "
    echo '--- GET /products CON Origin (lo que hace el navegador)'
    curl -s -D - -o /dev/null -H 'Origin: ${CFURL:-https://example.com}' '$API/products' | grep -iE '^HTTP|access-control|vary'
    echo
    echo '--- preflight OPTIONS'
    curl -s -D - -o /dev/null -X OPTIONS '$API/products' -H 'Origin: ${CFURL:-https://example.com}' \
      -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' | grep -iE '^HTTP|access-control'
    echo
    echo '--- conteo de Access-Control-Allow-Origin (debe ser 1; 2 = navegador rechaza)'
    curl -s -D - -o /dev/null -H 'Origin: ${CFURL:-https://example.com}' '$API/products' | grep -ci 'access-control-allow-origin'
    echo '--- SIN Origin: debe dar 0 (la Function URL solo emite CORS si hay Origin,'
    echo '    y el handler ya no emite ninguno). ANTES del fix daba 1, el * del handler:'
    echo '    por eso todos los curl sin Origin daban verde con el frontend roto.'
    curl -s -D - -o /dev/null '$API/products' | grep -ci 'access-control-allow-origin'
  "

  # Frontend: S3 + CloudFront + config en runtime.
  cap "$D/10-s3-inventario.txt" aws s3 ls "s3://$STACK-frontend/" --recursive --human-readable --summarize
  cap "$D/11-s3-politica-publica.json" aws s3api get-bucket-policy \
        --bucket "$STACK-frontend" --query Policy --output text
  if [ -n "$CFURL" ]; then
    cap "$D/12-frontend-http.txt" bash -c "
      echo '--- index.html por CloudFront'
      curl -s -D - -o /dev/null '$CFURL/' | grep -iE '^HTTP|content-type|x-cache'
      echo
      echo '--- env-config.js (configuración inyectada en RUNTIME, no en el bundle)'
      curl -s '$CFURL/env-config.js'
      echo '--- imágenes de producto'
      for f in vestido-floral chaqueta-denim tenis-blancos bolso-tote; do
        curl -s -o /dev/null -w \"  \$f.jpg  HTTP %{http_code}  %{content_type}  %{size_download} bytes\n\" \"$CFURL/products/\$f.jpg\"
      done
    "
    cap "$D/13-cloudfront.json" aws cloudfront list-distributions \
      --query "DistributionList.Items[?DomainName=='${CFURL#https://}'].{Id:Id,Status:Status,Domain:DomainName,Origin:Origins.Items[0].DomainName,Protocol:DefaultCacheBehavior.ViewerProtocolPolicy,ErrorPages:CustomErrorResponses.Items[].[ErrorCode,ResponseCode,ResponsePagePath]}" --output json
  else
    info "sin FrontendUrl en este stack (template.sandbox.yaml no crea CloudFront)"
  fi

  cap "$D/14-cloudwatch-loggroups.txt" aws logs describe-log-groups \
        --log-group-name-prefix "/aws/lambda/$STACK" --region "$REGION" \
        --query 'logGroups[].[logGroupName,retentionInDays,storedBytes]' --output text

  # X-Ray: la rúbrica pide evidencia de trazas. Tracing: Active está en Globals.
  #
  # ⚠️ HAY QUE FILTRAR POR SERVICIO. X-Ray es por CUENTA, no por stack, y esta cuenta
  # la comparte toda la cohorte: sin --filter-expression el conteo mezcla las trazas
  # de los stacks de los compañeros (se detectó un 502 que resultó ser de
  # techmoda-ai-li-EnrichLabels, no nuestro). Un número así invalida la evidencia.
  cap "$D/15-xray-trazas.txt" bash -c "
    DESDE=\$(( \$(date -u +%s) - 3600 )); HASTA=\$(date -u +%s)
    for FN in '$STACK-Router' '$STACK-EnrichLabels'; do
      echo \"--- \$FN (última hora, sólo NUESTRO servicio)\"
      aws xray get-trace-summaries --region '$REGION' --start-time \$DESDE --end-time \$HASTA \
        --filter-expression \"service(\\\"\$FN\\\")\" \
        --query '{Trazas:length(TraceSummaries),Fallos:length(TraceSummaries[?to_string(Http.HttpStatus)>=\`\"400\"\`])}' --output json 2>/dev/null
      aws xray get-trace-summaries --region '$REGION' --start-time \$DESDE --end-time \$HASTA \
        --filter-expression \"service(\\\"\$FN\\\")\" \
        --query 'TraceSummaries[0:8].{Id:Id,Duracion:Duration,Status:Http.HttpStatus}' --output table 2>/dev/null
    done
    echo '--- comparación: trazas de TODA la cuenta (incluye stacks de la cohorte)'
    aws xray get-trace-summaries --region '$REGION' --start-time \$DESDE --end-time \$HASTA \
      --query 'length(TraceSummaries)' --output text
  "
fi

# ============================================================ S01 ===========
S01URL="$(out EnrichLabelsUrl)"
if { [ -z "$ONLY" ] || [ "$ONLY" = "S01" ]; } && [ -n "$S01URL" ]; then
head_ "S01 · Rekognition DetectLabels"
  D="$EV/S01-rekognition-labels"

  cap "$D/01-lambda-config.json" aws lambda get-function-configuration \
        --function-name "$STACK-EnrichLabels" --region "$REGION" \
        --query '{FunctionName:FunctionName,Runtime:Runtime,Handler:Handler,MemorySize:MemorySize,Timeout:Timeout,Tracing:TracingConfig.Mode,Env:Environment.Variables,Role:Role}' --output json
  cap "$D/02-function-url.txt" bash -c "echo 'EnrichLabelsUrl = $S01URL/'"

  # Las TRES políticas: DynamoDB por tabla, Rekognition por ACCIÓN, S3 por bucket.
  EROLE=$(aws lambda get-function-configuration --function-name "$STACK-EnrichLabels" \
            --region "$REGION" --query Role --output text); EROLE=${EROLE##*/}
  cap "$D/03-iam-minimo-privilegio.txt" bash -c "
    echo 'rol: $EROLE'
    aws iam get-role --role-name '$EROLE' --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text
    for p in \$(aws iam list-role-policies --role-name '$EROLE' --query 'PolicyNames[]' --output text); do
      echo
      echo \"--- \$p\"
      aws iam get-role-policy --role-name '$EROLE' --policy-name \"\$p\" --query 'PolicyDocument.Statement[].{Action:Action,Resource:Resource}' --output json
    done
    echo
    echo '--- managed'
    aws iam list-attached-role-policies --role-name '$EROLE' --query 'AttachedPolicies[].PolicyName' --output text
  "

  # DetectLabels real sobre cada producto. La salida es la evidencia.
  cap "$D/04-detect-labels-por-producto.json" python3 -c "
import json, urllib.request, sys
api, url = '$API', '$S01URL'
res = {}
for p in json.load(urllib.request.urlopen(api + '/products'))['products']:
    if p['name'].startswith('__'): continue
    req = urllib.request.Request(url + '/products/' + p['productId'] + '/labels',
                                 data=b'{}', headers={'Content-Type':'application/json'}, method='POST')
    res[p['name']] = json.load(urllib.request.urlopen(req))
json.dump(res, sys.stdout, indent=2, ensure_ascii=False)
"

  # Ojo: el .json de arriba lleva 3 líneas de encabezado '#'. NO se puede buscar el
  # primer '{' para saltarlas — el comando citado en el encabezado también trae llaves
  # ({'Content-Type': ...}) y el parseo explota con "Extra data". Se descartan por prefijo.
  cap "$D/05-detect-labels-resumen.txt" python3 -c "
import json, pathlib
lines = pathlib.Path('$D/04-detect-labels-por-producto.json').read_text().splitlines()
data = json.loads('\n'.join(l for l in lines if not l.startswith('#')))
for name, r in data.items():
    print('%s  (imageSource=%s, minConfidence=%s)' % (name, r.get('imageSource'), r.get('minConfidence')))
    for l in r.get('labels', []):
        print('    %-24s %6.2f' % (l['name'], l['confidence']))
    print()
"

  # El write-back: aiLabels (strings) + aiLabelsRaw (confidence como Number).
  cap "$D/06-dynamodb-ailabels.json" aws dynamodb scan \
        --table-name "$STACK-Products" --region "$REGION" \
        --filter-expression "attribute_exists(aiLabels)" \
        --projection-expression "productId,#n,aiLabels,aiLabelsRaw" \
        --expression-attribute-names '{"#n":"name"}' --output json

  cap "$D/07-cobertura-ailabels.txt" bash -c "
    echo -n 'productos con aiLabels: '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' \
      --filter-expression 'attribute_exists(aiLabels)' --select COUNT --query Count --output text
    echo -n 'productos totales:      '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' --select COUNT --query Count --output text
  "

  cap "$D/08-cloudwatch-logs.txt" bash -c "
    aws logs describe-log-groups --log-group-name-prefix '/aws/lambda/$STACK-EnrichLabels' \
      --region '$REGION' --query 'logGroups[].[logGroupName,retentionInDays]' --output text
    echo '--- últimos eventos'
    LG='/aws/lambda/$STACK-EnrichLabels'
    aws logs filter-log-events --log-group-name \"\$LG\" --region '$REGION' \
      --start-time \$(( (\$(date -u +%s) - 3600) * 1000 )) \
      --query 'events[-25:].message' --output text 2>/dev/null | cut -c1-200
  "
elif [ -z "$ONLY" ] || [ "$ONLY" = "S01" ]; then
  info "S01 no está desplegada en este stack (falta el output EnrichLabelsUrl)"
fi

# ============================================================ S02 ===========
S02URL="$(out ModerateImageUrl)"
if { [ -z "$ONLY" ] || [ "$ONLY" = "S02" ]; } && [ -n "$S02URL" ]; then
head_ "S02 · Moderación de contenido + alt-text"
  D="$EV/S02-moderation-alttext"

  cap "$D/01-lambda-config.json" aws lambda get-function-configuration \
        --function-name "$STACK-ModerateImage" --region "$REGION" \
        --query '{FunctionName:FunctionName,Runtime:Runtime,Handler:Handler,MemorySize:MemorySize,Timeout:Timeout,Tracing:TracingConfig.Mode,Env:Environment.Variables,Role:Role}' --output json
  cap "$D/02-function-url.txt" bash -c "echo 'ModerateImageUrl = $S02URL/'"

  # El punto de D5 de esta sesión: DOS acciones de Rekognition, no rekognition:*.
  # Comparar con S01/03-: ese rol NO puede moderar. Mismo servicio, límites distintos.
  MROLE=$(aws lambda get-function-configuration --function-name "$STACK-ModerateImage" \
            --region "$REGION" --query Role --output text); MROLE=${MROLE##*/}
  cap "$D/03-iam-dos-acciones.txt" bash -c "
    echo 'rol: $MROLE'
    aws iam get-role --role-name '$MROLE' --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text
    for p in \$(aws iam list-role-policies --role-name '$MROLE' --query 'PolicyNames[]' --output text); do
      echo
      echo \"--- \$p\"
      aws iam get-role-policy --role-name '$MROLE' --policy-name \"\$p\" --query 'PolicyDocument.Statement[].{Action:Action,Resource:Resource}' --output json
    done
    echo
    echo '--- managed'
    aws iam list-attached-role-policies --role-name '$MROLE' --query 'AttachedPolicies[].PolicyName' --output text
  "

  # Moderación real de los 4 productos, con el umbral de gobernanza (60).
  cap "$D/04-moderate-por-producto.json" python3 -c "
import json, urllib.request, sys
api, url = '$API', '$S02URL'
res = {}
for p in json.load(urllib.request.urlopen(api + '/products'))['products']:
    if p['name'].startswith('__'): continue
    req = urllib.request.Request(url + '/products/' + p['productId'] + '/moderate',
                                 data=b'{}', headers={'Content-Type':'application/json'}, method='POST')
    res[p['name']] = json.load(urllib.request.urlopen(req))
json.dump(res, sys.stdout, indent=2, ensure_ascii=False)
"

  cap "$D/05-veredictos-y-alttext.txt" python3 -c "
import json, pathlib
lines = pathlib.Path('$D/04-moderate-por-producto.json').read_text().splitlines()
data = json.loads('\n'.join(l for l in lines if not l.startswith('#')))
for name, r in data.items():
    print('%-32s %s  (flags: %d)' % (name, r.get('moderationStatus'), len(r.get('moderationFlags', []))))
    print('    altText: %s' % r.get('altText'))
    for f in r.get('moderationFlags', []):
        print('    FLAG %-46s %6.2f  (padre: %s)' % (f['name'], f['confidence'], f['parent'] or '-'))
    print()
"

  # La taxonomía COMPLETA de moderación y qué puntúa cada foto. Con MinConfidence=0
  # la API devuelve las 52 categorías, así se ve cuán lejos del umbral (60) estamos.
  cap "$D/06-taxonomia-moderacion-umbral-0.txt" python3 -c "
import boto3, urllib.request
rek = boto3.client('rekognition', region_name='$REGION')
for n in ['vestido-floral','chaqueta-denim','tenis-blancos','bolso-tote']:
    b = urllib.request.urlopen('$(out FrontendUrl)/products/%s.jpg' % n, timeout=15).read()
    r = rek.detect_moderation_labels(Image={'Bytes': b}, MinConfidence=0)
    ml = r['ModerationLabels']
    print('%-16s modelo=%s  categorias=%d  max=%.2f%%  (umbral vigente: 60)'
          % (n, r.get('ModerationModelVersion'), len(ml), max(m['Confidence'] for m in ml)))
    for m in sorted(ml, key=lambda x: -x['Confidence'])[:5]:
        print('    %-52s %6.2f' % (m['Name'], m['Confidence']))
    print()
"

  # El write-back: moderationStatus + altText + moderationFlags.
  cap "$D/07-dynamodb-moderacion.json" aws dynamodb scan \
        --table-name "$STACK-Products" --region "$REGION" \
        --filter-expression "attribute_exists(moderationStatus)" \
        --projection-expression "productId,#n,moderationStatus,moderationFlags,altText" \
        --expression-attribute-names '{"#n":"name"}' --output json

  cap "$D/08-cobertura-moderacion.txt" bash -c "
    echo -n 'productos con moderationStatus: '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' \
      --filter-expression 'attribute_exists(moderationStatus)' --select COUNT --query Count --output text
    echo -n 'productos con altText:          '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' \
      --filter-expression 'attribute_exists(altText)' --select COUNT --query Count --output text
    echo -n 'productos totales:              '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' --select COUNT --query Count --output text
  "

  cap "$D/09-cloudwatch-logs.txt" bash -c "
    aws logs describe-log-groups --log-group-name-prefix '/aws/lambda/$STACK-ModerateImage' \
      --region '$REGION' --query 'logGroups[].[logGroupName,retentionInDays]' --output text
    echo '--- últimos eventos'
    LG='/aws/lambda/$STACK-ModerateImage'
    aws logs filter-log-events --log-group-name \"\$LG\" --region '$REGION' \
      --start-time \$(( (\$(date -u +%s) - 3600) * 1000 )) \
      --query 'events[-25:].message' --output text 2>/dev/null | cut -c1-200
  "
elif [ -z "$ONLY" ] || [ "$ONLY" = "S02" ]; then
  info "S02 no está desplegada en este stack (falta el output ModerateImageUrl)"
fi

# ============================================================ S03 ===========
S03URL="$(out AnalyzeSentimentUrl)"
if { [ -z "$ONLY" ] || [ "$ONLY" = "S03" ]; } && [ -n "$S03URL" ]; then
head_ "S03 · Comprehend DetectSentiment"
  D="$EV/S03-comprehend-sentiment"

  cap "$D/01-lambda-config.json" aws lambda get-function-configuration \
        --function-name "$STACK-AnalyzeSentiment" --region "$REGION" \
        --query '{FunctionName:FunctionName,Runtime:Runtime,Handler:Handler,MemorySize:MemorySize,Timeout:Timeout,Tracing:TracingConfig.Mode,Env:Environment.Variables,Role:Role}' --output json
  cap "$D/02-function-url.txt" bash -c "echo 'AnalyzeSentimentUrl = $S03URL/'"

  # DOS acciones de Comprehend: el snippet original traía sólo DetectSentiment y la
  # primera llamada moría con AccessDeniedException, porque el handler es un pipeline.
  SROLE=$(aws lambda get-function-configuration --function-name "$STACK-AnalyzeSentiment" \
            --region "$REGION" --query Role --output text); SROLE=${SROLE##*/}
  cap "$D/03-iam-pipeline-dos-acciones.txt" bash -c "
    echo 'rol: $SROLE'
    aws iam get-role --role-name '$SROLE' --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text
    for p in \$(aws iam list-role-policies --role-name '$SROLE' --query 'PolicyNames[]' --output text); do
      echo
      echo \"--- \$p\"
      aws iam get-role-policy --role-name '$SROLE' --policy-name \"\$p\" --query 'PolicyDocument.Statement[].{Action:Action,Resource:Resource}' --output json
    done
  "

  # Casos que prueban el comportamiento del modelo, no sólo que la llamada ande.
  cap "$D/04-casos-de-sentimiento.txt" python3 -c "
import json, urllib.request
url = '$S03URL/sentiment'
casos = [
  ('positiva es',      'Me encantó la tela y el corte, llegó rapidísimo. Lo volvería a comprar.'),
  ('negativa en',      'The fabric feels cheap and it arrived three weeks late. Very disappointed.'),
  ('negacion',         'No está nada mal.'),
  ('mixta',            'Excelente calidad pero el envío tardó tres semanas y llegó sucio.'),
  ('factual',          'El paquete llegó el martes.'),
]
for etiqueta, t in casos:
    req = urllib.request.Request(url, data=json.dumps({'text': t}).encode(),
                                 headers={'Content-Type':'application/json'}, method='POST')
    r = json.load(urllib.request.urlopen(req))['results'][0]
    s = r['scores']
    print('%-12s %-9s lang=%-3s P=%.4f N=%.4f Neu=%.4f Mix=%.4f' % (
        etiqueta, r['sentiment'], r['language'], s['Positive'], s['Negative'], s['Neutral'], s['Mixed']))
    print('             %s' % t)
"

  # El agregado por producto, con las 8 reseñas del seed.
  cap "$D/05-agregado-por-producto.json" python3 -c "
import json, urllib.request, sys
api, url = '$API', '$S03URL'
seed = json.load(open('ai/seed/seed-products.json'))
seed = seed if isinstance(seed, list) else seed.get('products', seed)
reviews = {p['name']: p.get('reviews', []) for p in seed}
res = {}
for p in json.load(urllib.request.urlopen(api + '/products'))['products']:
    rv = reviews.get(p['name'], [])
    if not rv: continue
    req = urllib.request.Request(url + '/sentiment',
            data=json.dumps({'productId': p['productId'], 'reviews': rv}).encode(),
            headers={'Content-Type':'application/json'}, method='POST')
    res[p['name']] = json.load(urllib.request.urlopen(req))
json.dump(res, sys.stdout, indent=2, ensure_ascii=False)
"

  # La prueba que encontró el bug: el veredicto NO debe depender del orden.
  cap "$D/06-agregado-independiente-del-orden.txt" python3 -c "
import json, urllib.request
url = '$S03URL/sentiment'
pos = 'Espacioso y bonito, ideal para el día a día.'
neg = 'La costura del asa se descosió a la semana, decepcionante.'
print('Las MISMAS dos reseñas en los dos ordenes posibles.')
print('Con el agregado viejo (Counter.most_common) esto daba POSITIVE y NEGATIVE:')
print('el empate 1-1 lo desempataba el ORDEN de las reseñas.')
print()
for etiqueta, orden in [('positiva primero', [pos, neg]), ('negativa primero', [neg, pos])]:
    req = urllib.request.Request(url, data=json.dumps({'reviews': orden}).encode(),
                                 headers={'Content-Type':'application/json'}, method='POST')
    d = json.load(urllib.request.urlopen(req))
    a = d['averageScores']
    print('%-18s -> %-9s  P=%.4f N=%.4f Neu=%.4f Mix=%.4f  conteo=%s' % (
        etiqueta, d['overallSentiment'], a['Positive'], a['Negative'], a['Neutral'], a['Mixed'], d['distribution']))
"

  cap "$D/07-dynamodb-sentimiento.json" aws dynamodb scan \
        --table-name "$STACK-Products" --region "$REGION" \
        --filter-expression "attribute_exists(reviewSentiment)" \
        --projection-expression "productId,#n,reviewSentiment,reviewSentimentCounts,reviewSentimentScores" \
        --expression-attribute-names '{"#n":"name"}' --output json

  cap "$D/08-cobertura-sentimiento.txt" bash -c "
    echo -n 'productos con reviewSentiment: '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' \
      --filter-expression 'attribute_exists(reviewSentiment)' --select COUNT --query Count --output text
    echo -n 'productos totales:             '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' --select COUNT --query Count --output text
  "

  cap "$D/09-cloudwatch-logs.txt" bash -c "
    aws logs describe-log-groups --log-group-name-prefix '/aws/lambda/$STACK-AnalyzeSentiment' \
      --region '$REGION' --query 'logGroups[].[logGroupName,retentionInDays]' --output text
    echo '--- últimos eventos'
    aws logs filter-log-events --log-group-name '/aws/lambda/$STACK-AnalyzeSentiment' --region '$REGION' \
      --start-time \$(( (\$(date -u +%s) - 3600) * 1000 )) \
      --query 'events[-25:].message' --output text 2>/dev/null | cut -c1-200
  "
elif [ -z "$ONLY" ] || [ "$ONLY" = "S03" ]; then
  info "S03 no está desplegada en este stack (falta el output AnalyzeSentimentUrl)"
fi

# ============================================================ S04 ===========
S04URL="$(out TranslateCatalogUrl)"
if { [ -z "$ONLY" ] || [ "$ONLY" = "S04" ]; } && [ -n "$S04URL" ]; then
head_ "S04 · Amazon Translate (catálogo ES/EN)"
  D="$EV/S04-translate-multilang"

  cap "$D/01-lambda-config.json" aws lambda get-function-configuration \
        --function-name "$STACK-TranslateCatalog" --region "$REGION" \
        --query '{FunctionName:FunctionName,Runtime:Runtime,Handler:Handler,MemorySize:MemorySize,Timeout:Timeout,Tracing:TracingConfig.Mode,Env:Environment.Variables,Role:Role}' --output json
  cap "$D/02-function-url.txt" bash -c "echo 'TranslateCatalogUrl = $S04URL/'"

  # translate:TranslateText + comprehend:DetectDominantLanguage. La segunda no es
  # opcional: Translate llama a Comprehend por dentro con ESTE rol.
  TROLE=$(aws lambda get-function-configuration --function-name "$STACK-TranslateCatalog" \
            --region "$REGION" --query Role --output text); TROLE=${TROLE##*/}
  cap "$D/03-iam-dependencia-downstream.txt" bash -c "
    echo 'rol: $TROLE'
    aws iam get-role --role-name '$TROLE' --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text
    for p in \$(aws iam list-role-policies --role-name '$TROLE' --query 'PolicyNames[]' --output text); do
      echo
      echo \"--- \$p\"
      aws iam get-role-policy --role-name '$TROLE' --policy-name \"\$p\" --query 'PolicyDocument.Statement[].{Action:Action,Resource:Resource}' --output json
    done
  "

  # La detección de idioma que motivó el umbral: los nombres cortos se detectan MAL.
  cap "$D/04-deteccion-de-idioma.txt" python3 -c "
import boto3, json, urllib.request
c = boto3.client('comprehend', region_name='$REGION')
print('Confianza de DetectDominantLanguage sobre el catálogo real.')
print('El umbral de la Lambda es MIN_LANG_CONFIDENCE=0.60.')
print()
print('%-34s %-16s %s' % ('producto', 'solo name', 'name + description'))
for p in json.load(urllib.request.urlopen('$API/products'))['products']:
    n, d = p['name'], p.get('description','')
    a = c.detect_dominant_language(Text=n)['Languages'][0]
    b = c.detect_dominant_language(Text=(n + '. ' + d))['Languages'][0]
    print('  %-32s %s %.4f        %s %.4f' % (n[:32], a['LanguageCode'], a['Score'], b['LanguageCode'], b['Score']))
print()
print('Ojo: mas texto NO arregla el vestido, sube la confianza en la respuesta EQUIVOCADA.')
"

  # ES->EN y ES->ES sobre los 4 productos, con la transparencia del origen.
  cap "$D/05-traducciones.json" python3 -c "
import json, urllib.request, sys
api, tr = '$API', '$S04URL'
res = {}
for p in json.load(urllib.request.urlopen(api + '/products'))['products']:
    if p['name'].startswith('__'): continue
    res[p['name']] = {}
    for target in ('en', 'es'):
        req = urllib.request.Request(tr + '/products/' + p['productId'] + '/translate',
                data=json.dumps({'target': target}).encode(),
                headers={'Content-Type':'application/json'}, method='POST')
        res[p['name']][target] = json.load(urllib.request.urlopen(req))
json.dump(res, sys.stdout, indent=2, ensure_ascii=False)
"

  cap "$D/06-resumen-traducciones.txt" python3 -c "
import json, pathlib
lines = pathlib.Path('$D/05-traducciones.json').read_text().splitlines()
data = json.loads('\n'.join(l for l in lines if not l.startswith('#')))
for name, porlang in data.items():
    print(name)
    for target, d in porlang.items():
        print('  -> %-3s src=%s conf=%-7s fallback=%-5s omitido=%-5s' % (
            target, d['sourceLanguage'], d['sourceConfidence'],
            d['sourceFromCatalogDefault'], d['translationSkipped']))
        print('       %s' % d['translation']['name'])
        print('       %s' % d['translation']['description'][:76])
    print()
"

  cap "$D/07-dynamodb-translations.json" aws dynamodb scan \
        --table-name "$STACK-Products" --region "$REGION" \
        --filter-expression "attribute_exists(translations)" \
        --projection-expression "productId,#n,translations" \
        --expression-attribute-names '{"#n":"name"}' --output json

  # El invariante que el bug rompia: translations.es tiene que ser IGUAL al name.
  cap "$D/08-invariante-es-sin-reescribir.txt" python3 -c "
import boto3
d = boto3.client('dynamodb', region_name='$REGION')
items = d.scan(TableName='$STACK-Products',
               ProjectionExpression='#n,translations',
               ExpressionAttributeNames={'#n':'name'})['Items']
print('translations.es NO debe diferir de name: el original no se reescribe.')
print('Antes del arreglo, el vestido volvia como \"Vestido midi con estampado floral\".')
print()
malos = 0
for it in items:
    n = it['name']['S']
    tr = it.get('translations', {}).get('M', {})
    es = tr.get('es', {}).get('M', {}).get('name', {}).get('S')
    if es is None: continue
    estado = 'ok' if es == n else 'REESCRITO'
    malos += es != n
    print('  %-9s %-34s es=%s' % (estado, n[:34], es))
print()
print('reescritos: %d' % malos)
"

  cap "$D/09-cobertura-translations.txt" bash -c "
    echo -n 'productos con translations: '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' \
      --filter-expression 'attribute_exists(translations)' --select COUNT --query Count --output text
    echo -n 'productos totales:          '
    aws dynamodb scan --table-name '$STACK-Products' --region '$REGION' --select COUNT --query Count --output text
  "

  cap "$D/10-cloudwatch-logs.txt" bash -c "
    aws logs describe-log-groups --log-group-name-prefix '/aws/lambda/$STACK-TranslateCatalog' \
      --region '$REGION' --query 'logGroups[].[logGroupName,retentionInDays]' --output text
    echo '--- últimos eventos'
    aws logs filter-log-events --log-group-name '/aws/lambda/$STACK-TranslateCatalog' --region '$REGION' \
      --start-time \$(( (\$(date -u +%s) - 3600) * 1000 )) \
      --query 'events[-25:].message' --output text 2>/dev/null | cut -c1-200
  "
elif [ -z "$ONLY" ] || [ "$ONLY" = "S04" ]; then
  info "S04 no está desplegada en este stack (falta el output TranslateCatalogUrl)"
fi

# ================================================ SESIONES PENDIENTES =======
if [ -z "$ONLY" ]; then
head_ "Sesiones pendientes"
  for pair in "S02:ModerateImageUrl" "S03:AnalyzeSentimentUrl" "S04:TranslateCatalogUrl" \
              "S05:SynthesizeVoiceUrl" "S06:GenerateDescriptionUrl" "S07:IndexEmbeddingsUrl" \
              "S08:ShoppingAssistantUrl"; do
    S="${pair%%:*}"; O="${pair##*:}"
    [ -z "$(out "$O")" ] && info "$S sin desplegar (falta output $O)"
  done
fi

# =========================================================== GATE ===========
head_ "Validación completa del paquete"
  D="$EV/00-entorno"
  mkdir -p "$D"
  {
    echo "# $STAMP  ·  stack=$STACK  region=$REGION"
    echo "# \$ bash scripts/validate-all.sh"
    echo "# ---------------------------------------------------------------------------"
    STACK_NAME="$STACK" AWS_REGION="$REGION" bash scripts/validate-all.sh 2>&1 \
      | sed -r 's/\x1B\[[0-9;]*[mK]//g'
  } > "$D/validate-all.txt"
  ok "00-entorno/validate-all.txt"
  tail -5 "$D/validate-all.txt" | sed 's/^/    /'

printf '\n\033[1mEvidencia en %s\033[0m\n' "$EV"
echo "Índice y explicación: evidence/README.md"
