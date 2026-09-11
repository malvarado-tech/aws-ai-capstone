"""
S6 · GENERATE DESCRIPTION  —  Descripciones de producto con IA generativa (Amazon Bedrock).

Flujo:
  POST /products/{id}/describe
    body (opcional): { "tone": "elegante", "save": true }

    1. Lee atributos del producto (name, category, price, aiLabels de S1).
    2. Construye un prompt y llama a un foundation model vía Bedrock Converse API.
    3. Devuelve la descripción generada; si save=true la guarda en aiDescription.

Servicio de IA: Amazon Bedrock (foundation models / IA generativa).
Dominio AIF-C01: D2 — Fundamentals of Generative AI (24%).

Nota: usamos la Converse API (boto3 bedrock-runtime.converse), que es agnóstica al
proveedor del modelo. Cambiar BEDROCK_MODEL_ID no requiere cambiar el código.
"""

import json
import os

import boto3

PRODUCTS_TABLE = os.environ["PRODUCTS_TABLE"]
# Verificá acceso al modelo en Bedrock > Model access, en la región del deploy.
# El ID es el de la integración `bedrock-runtime` (versionado, con sufijo -v1:0);
# NO sirve el alias de la Claude API (`claude-haiku-4-5` a secas).
# Con perfiles de inferencia cross-region el ID lleva prefijo "us."
# (us.anthropic.claude-haiku-4-5-20251001-v1:0) y hay que permitir el ARN
# inference-profile/* además de foundation-model/* (ver docs/IAM.md).
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-haiku-4-5-20251001-v1:0")
MAX_TOKENS = int(os.environ.get("BEDROCK_MAX_TOKENS", "300"))
TEMPERATURE = float(os.environ.get("BEDROCK_TEMPERATURE", "0.7"))
GUARDRAIL_ID = os.environ.get("BEDROCK_GUARDRAIL_ID")
GUARDRAIL_VERSION = os.environ.get("BEDROCK_GUARDRAIL_VERSION", "DRAFT")

bedrock = boto3.client("bedrock-runtime")
table = boto3.resource("dynamodb").Table(PRODUCTS_TABLE)


def _response(status, body):
    # CORS lo emite el FunctionUrlConfig.Cors del template (capa de plataforma).
    # Si el handler lo manda TAMBIEN, la respuesta lleva dos Access-Control-Allow-Origin
    # y el navegador la rechaza con "Failed to fetch". curl no lo nota: sin header Origin,
    # la Function URL no agrega el suyo y solo se ve uno.
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, ensure_ascii=False),
    }


# Las instrucciones van en el campo `system`, NO dentro del mensaje del usuario.
# Con el guardrail de S9 activo eso no es cosmético: el filtro PROMPT_ATTACK clasifica
# como inyección cualquier texto que dé órdenes al modelo ("Sos un redactor…",
# "No uses emojis") — que es literalmente la forma de una inyección. Con las
# instrucciones dentro del mensaje del usuario, el guardrail bloqueaba el 100 % de las
# descripciones: 3 de 3, con usage en 0 (se corta ANTES de invocar al modelo).
# Medido con apply-guardrail: sólo las instrucciones -> filters: [PROMPT_ATTACK];
# sólo los atributos -> NONE. Ver docs/TROUBLESHOOTING.md#20.
SYSTEM_PROMPT = (
    "Sos un redactor de e-commerce de moda. Escribí UNA descripción de producto en "
    "español, de 2 a 3 frases, atractiva y honesta: no inventes materiales ni datos que "
    "no estén en los atributos que te dan. No uses emojis. No repitas el precio. "
    "Respondé sólo con la descripción, sin preámbulo."
)


def _build_attrs(item):
    labels = ", ".join(item.get("aiLabels", []) or [])
    attrs = [
        f"Nombre: {item.get('name', '')}",
        f"Categoría: {item.get('category', '')}",
        f"Precio: {item.get('price', '')}",
    ]
    if labels:
        attrs.append(f"Atributos visuales detectados: {labels}")
    return "Atributos del producto:\n" + "\n".join(attrs)


def _build_messages(item, tone):
    """El tono lo elige quien llama (viene del body), así que es entrada NO confiable:
    va en un bloque `guardContent` para que el guardrail evalúe eso y no nuestro prompt.
    Los atributos salen de nuestra propia tabla, así que van como texto normal."""
    return [
        {
            "role": "user",
            "content": [
                {"text": _build_attrs(item)},
                {"text": "Tono pedido:"},
                {"guardContent": {"text": {"text": tone, "qualifiers": ["guard_content"]}}},
            ],
        }
    ]


def _path_id(event):
    """Extrae el productId tanto de eventos API Gateway (pathParameters) como de
    Lambda Function URL (rawPath: /products/<id>/...). Fallback: query string o body."""
    pp = event.get("pathParameters") or {}
    if pp.get("id"):
        return pp["id"]
    raw = event.get("rawPath") or ((event.get("requestContext") or {}).get("http") or {}).get("path") or ""
    parts = [p for p in raw.split("/") if p]
    if "products" in parts:
        i = parts.index("products")
        if i + 1 < len(parts):
            return parts[i + 1]
    qs = event.get("queryStringParameters") or {}
    if qs.get("id"):
        return qs["id"]
    try:
        b = json.loads(event.get("body") or "{}")
        return b.get("productId") or b.get("id")
    except (TypeError, json.JSONDecodeError):
        return None


def lambda_handler(event, context):
    print("Event:", json.dumps(event))
    product_id = _path_id(event)
    if not product_id:
        return _response(400, {"error": "Falta el productId en la ruta."})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "Body JSON inválido."})

    tone = body.get("tone", "elegante y cercano")
    save = bool(body.get("save", False))

    item = table.get_item(Key={"productId": product_id}).get("Item")
    if not item:
        return _response(404, {"error": f"Producto {product_id} no encontrado."})

    try:
        kwargs = {
            "modelId": MODEL_ID,
            "system": [{"text": SYSTEM_PROMPT}],
            "messages": _build_messages(item, tone),
            "inferenceConfig": {"maxTokens": MAX_TOKENS, "temperature": TEMPERATURE},
        }
        if GUARDRAIL_ID:
            kwargs["guardrailConfig"] = {
                "guardrailIdentifier": GUARDRAIL_ID,
                "guardrailVersion": GUARDRAIL_VERSION,
            }
        resp = bedrock.converse(**kwargs)
        text = resp["output"]["message"]["content"][0]["text"].strip()
        usage = resp.get("usage", {})
        # Cuando el guardrail interviene, Bedrock NO falla: devuelve 200 con el
        # blockedInputMessaging como si fuera la respuesta del modelo, y avisa sólo
        # por stopReason. Sin mirarlo, un bloqueo es indistinguible de una
        # descripción válida — y con save=true se guardaría en aiDescription.
        stop = resp.get("stopReason")
        blocked = stop == "guardrail_intervened"
    except Exception as e:  # noqa: BLE001
        print("Bedrock error:", repr(e))
        return _response(
            502,
            {
                "error": "Fallo al invocar el modelo",
                "detail": str(e),
                "hint": "¿Habilitaste acceso al modelo en Bedrock > Model access (us-east-1)?",
            },
        )

    saved = bool(save and not blocked)
    if saved:
        table.update_item(
            Key={"productId": product_id},
            UpdateExpression="SET aiDescription = :d, aiDescriptionModel = :m",
            ExpressionAttributeValues={":d": text, ":m": MODEL_ID},
        )

    return _response(
        200,
        {
            "productId": product_id,
            "model": MODEL_ID,
            "tone": tone,
            "saved": saved,
            "description": text,
            "stopReason": stop,          # 'end_turn' | 'max_tokens' | 'guardrail_intervened'
            "guardrailBlocked": blocked,  # S9: hace visible la intervención del guardrail
            "usage": usage,  # inputTokens / outputTokens -> útil para costos (S10)
        },
    )
