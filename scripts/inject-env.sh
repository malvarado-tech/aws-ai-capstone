#!/bin/bash
#
# Inject runtime environment configuration into frontend
# This script generates env-config.js from the template with actual values
#

set -e

# Function to display usage
usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Inject runtime environment configuration into frontend build"
    echo ""
    echo "Options:"
    echo "  -a, --api-url URL      API Gateway URL (required)"
    echo "  -d, --dist-dir DIR     Distribution directory (default: frontend/dist)"
    echo "  -o, --outputs-json F   Archivo con los Outputs del stack (opcional)."
    echo "                         Sustituye %%OutputKey%% adicionales: así las"
    echo "                         Function URLs de IA entran sin un flag por cada una."
    echo "  -h, --help             Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --api-url https://abc123.lambda-url.us-east-1.on.aws"
    echo "  $0 -a https://abc123.lambda-url.us-east-1.on.aws -d ./dist"
    echo "  $0 -a \$API -o /tmp/outputs.json        # + capacidades de IA"
    echo ""
    exit 1
}

# Default values
DIST_DIR="frontend/dist"
API_URL=""
OUTPUTS_JSON=""

# Mapa Output de CloudFormation -> token del template.
# Agregar una sesión = agregar una línea acá y otra en env-config.js.template.
AI_OUTPUT_KEYS="EnrichLabelsUrl:VITE_ENRICH_LABELS_URL
ModerateImageUrl:VITE_MODERATE_IMAGE_URL
AnalyzeSentimentUrl:VITE_ANALYZE_SENTIMENT_URL
TranslateCatalogUrl:VITE_TRANSLATE_CATALOG_URL
SynthesizeVoiceUrl:VITE_SYNTHESIZE_VOICE_URL
GenerateDescriptionUrl:VITE_GENERATE_DESCRIPTION_URL
IndexEmbeddingsUrl:VITE_INDEX_EMBEDDINGS_URL
SemanticSearchUrl:VITE_SEMANTIC_SEARCH_URL
ShoppingAssistantUrl:VITE_SHOPPING_ASSISTANT_URL"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -a|--api-url)
            API_URL="$2"
            shift 2
            ;;
        -d|--dist-dir)
            DIST_DIR="$2"
            shift 2
            ;;
        -o|--outputs-json)
            OUTPUTS_JSON="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Error: Unknown option $1"
            usage
            ;;
    esac
done

# Validate required parameters
if [ -z "$API_URL" ]; then
    echo "❌ Error: API URL is required"
    echo ""
    usage
fi

# Normalizar: la Lambda Function URL termina en '/'. La quitamos para evitar
# dobles slash en el frontend (${API_URL}/products).
API_URL="${API_URL%/}"

# Validate dist directory exists
if [ ! -d "$DIST_DIR" ]; then
    echo "❌ Error: Distribution directory not found: $DIST_DIR"
    echo ""
    echo "💡 Make sure you've built the frontend first:"
    echo "   npm run build (from frontend/ directory)"
    echo "   or"
    echo "   ./scripts/build-frontend.sh"
    exit 1
fi

# Check if template exists
TEMPLATE_FILE="frontend/public/env-config.js.template"
if [ ! -f "$TEMPLATE_FILE" ]; then
    echo "❌ Error: Template file not found: $TEMPLATE_FILE"
    exit 1
fi

echo "=========================================="
echo "  Runtime Environment Injection"
echo "=========================================="
echo ""
echo "📋 Configuration:"
echo "   API URL:  $API_URL"
echo "   Dist dir: $DIST_DIR"
echo ""

# Generate env-config.js from template
OUTPUT_FILE="$DIST_DIR/env-config.js"

echo "🔧 Generating runtime configuration..."
sed "s|%%VITE_API_URL%%|$API_URL|g" "$TEMPLATE_FILE" > "$OUTPUT_FILE"

# Capacidades de IA: cada Lambda tiene su propia Function URL, así que hay un
# token por sesión. Se leen de los Outputs del stack en vez de un flag por URL.
if [ -n "$OUTPUTS_JSON" ]; then
    if [ ! -f "$OUTPUTS_JSON" ]; then
        echo "❌ Error: Outputs file not found: $OUTPUTS_JSON"
        exit 1
    fi
    echo "🤖 Inyectando capacidades de IA desde $OUTPUTS_JSON..."
    echo "$AI_OUTPUT_KEYS" | while IFS=':' read -r out_key token; do
        [ -z "$out_key" ] && continue
        url=$(python3 -c "
import json,sys
try:
    data = json.load(open('$OUTPUTS_JSON'))
except Exception:
    sys.exit(0)
outs = data.get('Stacks', [{}])[0].get('Outputs', data) if isinstance(data, dict) else data
for o in outs or []:
    if o.get('OutputKey') == '$out_key':
        print((o.get('OutputValue') or '').rstrip('/'))
        break
" 2>/dev/null)
        if [ -n "$url" ]; then
            sed -i "s|%%${token}%%|${url}|g" "$OUTPUT_FILE"
            printf '   ✓ %-28s %s\n' "$out_key" "$url"
        else
            printf '   ⚠ %-28s (no está en los Outputs; capacidad apagada)\n' "$out_key"
        fi
    done
fi

# Cualquier token que quedó sin sustituir pasa a cadena vacía. Si dejáramos
# '%%VITE_X_URL%%' el cliente intentaría usarlo como URL; vacío se interpreta
# como capacidad no configurada y la UI la esconde.
if grep -q '%%[A-Z_]*%%' "$OUTPUT_FILE" 2>/dev/null; then
    echo "   ℹ Tokens sin valor → cadena vacía (capacidad no disponible en la UI):"
    grep -o '%%[A-Z_]*%%' "$OUTPUT_FILE" | sort -u | sed 's/^/     /'
    sed -i "s|%%[A-Z_]*%%||g" "$OUTPUT_FILE"
fi

# Verify the file was created
if [ ! -f "$OUTPUT_FILE" ]; then
    echo "❌ Error: Failed to create $OUTPUT_FILE"
    exit 1
fi

echo "✅ Runtime configuration injected successfully!"
echo ""
echo "📄 Generated file: $OUTPUT_FILE"
echo ""
echo "🔍 Content preview:"
cat "$OUTPUT_FILE"
echo ""
echo "=========================================="
echo ""
echo "💡 Next steps:"
echo "   1. Deploy to S3: aws s3 sync $DIST_DIR/ s3://your-bucket/"
echo "   2. Or use: ./scripts/deploy-frontend.sh"
echo ""
