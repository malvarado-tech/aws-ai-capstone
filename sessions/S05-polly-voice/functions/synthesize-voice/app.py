"""
S5 · SYNTHESIZE VOICE  —  Descripción por voz (accesibilidad) con Amazon Polly.

Flujo:
  POST /products/{id}/voice
    body (opcional): { "lang": "es" }   # "es" (default) o "en"

    1. Lee name + description del producto (usa la traducción si pide "en" y existe).
    2. Amazon Polly convierte el texto a audio MP3 (voz neuronal).
    3. Sube el MP3 a un bucket de audio y genera una URL prefirmada (1 h).
    4. Guarda **audioKey** (la clave S3) en el producto y devuelve la URL prefirmada.

    OJO: la URL prefirmada NO se persiste — vive 3600 s y después no sirve. En
    DynamoDB queda sólo `audioKey`, y el bucket es privado, así que esa clave por
    sí sola no se puede reproducir desde el browser: para volver a escuchar el
    audio hay que llamar de nuevo a este endpoint. (Además la regla de ciclo de
    vida del bucket borra el MP3 a los 7 días, así que `audioKey` puede apuntar a
    un objeto que ya no existe.)

Servicio de IA: Amazon Polly (texto a voz neuronal).
Dominio AIF-C01: D1 (capacidad) + D4 (accesibilidad).
"""

import json
import os

import boto3

PRODUCTS_TABLE = os.environ["PRODUCTS_TABLE"]
AUDIO_BUCKET = os.environ["AUDIO_BUCKET"]
# Voces neuronales por idioma (verificar disponibilidad de la voz/engine en us-east-1).
VOICES = {"es": "Lupe", "en": "Joanna"}

polly = boto3.client("polly")
s3 = boto3.client("s3")
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


def _text_for(item, lang):
    name = item.get("name", "")
    desc = item.get("description", "")
    if lang == "en":
        tr = (item.get("translations") or {}).get("en") or {}
        name = tr.get("name", name)
        desc = tr.get("description", desc)
    return f"{name}. {desc}".strip()


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

    lang = (body.get("lang") or "es").lower()
    voice = VOICES.get(lang, VOICES["es"])

    item = table.get_item(Key={"productId": product_id}).get("Item")
    if not item:
        return _response(404, {"error": f"Producto {product_id} no encontrado."})

    text = _text_for(item, lang)
    if not text:
        return _response(422, {"error": "El producto no tiene texto para sintetizar."})

    try:
        audio = polly.synthesize_speech(
            Text=text, OutputFormat="mp3", VoiceId=voice, Engine="neural"
        )
        data = audio["AudioStream"].read()
        key = f"audio/{product_id}-{lang}.mp3"
        s3.put_object(Bucket=AUDIO_BUCKET, Key=key, Body=data, ContentType="audio/mpeg")
        audio_url = s3.generate_presigned_url(
            "get_object", Params={"Bucket": AUDIO_BUCKET, "Key": key}, ExpiresIn=3600
        )
    except Exception as e:  # noqa: BLE001
        print("Polly/S3 error:", repr(e))
        return _response(502, {"error": "Fallo al generar el audio", "detail": str(e)})

    table.update_item(
        Key={"productId": product_id},
        UpdateExpression="SET audioKey = :k",
        ExpressionAttributeValues={":k": key},
    )

    return _response(
        200,
        {"productId": product_id, "lang": lang, "voice": voice, "audioUrl": audio_url, "expiresIn": 3600},
    )
