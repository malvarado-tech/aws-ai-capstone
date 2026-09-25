#!/bin/bash
set -e

# Get stack name from samconfig.toml or use default
STACK_NAME="techmoda-ai"
if [ -f "samconfig.toml" ]; then
    STACK_NAME=$(grep 'stack_name' samconfig.toml | cut -d'"' -f2 || echo "techmoda-ai")
fi

echo "Deploying frontend to S3..."

# Get bucket name from CloudFormation outputs
BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`FrontendBucketName`].OutputValue' \
    --output text)

if [ -z "$BUCKET_NAME" ]; then
    echo "Error: Could not find frontend bucket. Deploy the SAM template first."
    exit 1
fi

# Get API URL
API_URL=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
    --output text)

echo "Bucket: $BUCKET_NAME"
echo "API URL: $API_URL"
echo ""

# Todos los Outputs una sola vez: inject-env.sh saca de acá las Function URLs de
# IA (una por sesión, cada una en otro host) sin necesitar un flag por cada una.
OUTPUTS_FILE=$(mktemp)
trap 'rm -f "$OUTPUTS_FILE"' EXIT
aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs' \
    --output json > "$OUTPUTS_FILE"

# Inject runtime environment configuration
echo "🔧 Injecting runtime configuration..."
./scripts/inject-env.sh --api-url "$API_URL" --dist-dir frontend/dist \
    --outputs-json "$OUTPUTS_FILE"
echo ""

# Sync to S3
aws s3 sync frontend/dist/ s3://$BUCKET_NAME/ --delete

# Invalidar CloudFront. SIN ESTO EL DEPLOY PARECE NO HACER NADA: la distribución
# tiene DefaultTTL 86400, así que index.html y env-config.js se sirven de caché
# hasta 24 h y el navegador sigue viendo el bundle viejo.
DIST_ID=$(aws cloudformation describe-stack-resource \
    --stack-name "$STACK_NAME" \
    --logical-resource-id FrontendDistribution \
    --query 'StackResourceDetail.PhysicalResourceId' \
    --output text 2>/dev/null || true)

if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
    echo ""
    echo "🧹 Invalidando caché de CloudFront ($DIST_ID)..."
    INVALIDATION_ID=$(aws cloudfront create-invalidation \
        --distribution-id "$DIST_ID" \
        --paths '/*' \
        --query 'Invalidation.Id' \
        --output text)
    echo "   Invalidación $INVALIDATION_ID creada (tarda unos minutos en propagar)."
else
    echo ""
    echo "⚠  No se encontró FrontendDistribution en el stack: no se invalidó nada."
    echo "   Si el sitio no refleja los cambios, es la caché."
fi

echo ""
echo "Frontend deployed successfully!"
echo "CloudFront URL: https://$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`FrontendUrl`].OutputValue' \
    --output text | sed 's/https:\/\///')"
