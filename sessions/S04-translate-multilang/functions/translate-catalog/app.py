"""
S4 · TRANSLATE CATALOG  —  Catálogo bilingüe ES<->EN con Amazon Translate.

Flujo:
  POST /products/{id}/translate
    body: { "target": "en" }    (o "es")

    1. Lee name + description del producto.
    2. Amazon Translate los traduce al idioma destino (source auto-detectado).
    3. Guarda translations.<lang>.{name,description} en el producto.
    4. Devuelve la traducción.

Servicio de IA: Amazon Translate (traducción automática neuronal preentrenada).
Dominio AIF-C01: D1 — Fundamentals of AI and ML.
"""

import json
import os

import boto3

PRODUCTS_TABLE = os.environ["PRODUCTS_TABLE"]
ALLOWED_TARGETS = {"en", "es"}
# Idioma en el que está AUTORADO el catálogo. Es el fallback cuando la detección
# automática no es confiable (ver _detect_source).
CATALOG_SOURCE_LANG = os.environ.get("CATALOG_SOURCE_LANG", "es")
# Confianza mínima para creerle a la detección de idioma. Medido: los nombres cortos
# se detectan mal y el error es SILENCIOSO porque igual devuelven una traducción.
MIN_LANG_CONFIDENCE = float(os.environ.get("MIN_LANG_CONFIDENCE", "0.60"))

translate = boto3.client("translate")
comprehend = boto3.client("comprehend")
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


def _detect_source(*textos):
    """Idioma de origen del producto, con umbral de confianza y fallback explícito.

    Por qué NO usamos SourceLanguageCode="auto" y listo: con "auto", Translate llama a
    Comprehend por dentro, se queda con el idioma más probable **sin importar cuán
    probable sea**, y traduce. Medido sobre nuestro catálogo:

        "Vestido midi floral"                      -> pt 0.4481  (¡portugués!)
        "Vestido midi floral. Vestido midi de ..."  -> pt 0.5093
        "Bolso tote de lona"                       -> es 0.7975
        "Chaqueta de mezclilla oversize"            -> es 0.9795

    O sea que el vestido se traducía pt->es y volvía como "Vestido midi con estampado
    floral": el nombre canónico en español quedaba **reescrito por la máquina**, en
    silencio, sin que la respuesta indicara nada raro. Más texto no lo arregla: el
    nombre + descripción sube la confianza en la respuesta EQUIVOCADA.

    Detectamos nosotros para poder ver el score y decidir: si no llega al umbral, el
    catálogo manda (CATALOG_SOURCE_LANG). Los aciertos dan 0.79-0.98 y los errores
    0.45-0.51, así que 0.60 los separa limpio.
    """
    muestra = " ".join(t for t in textos if t).strip()
    if not muestra:
        return CATALOG_SOURCE_LANG, None, True
    langs = comprehend.detect_dominant_language(Text=muestra).get("Languages", [])
    if not langs:
        return CATALOG_SOURCE_LANG, None, True
    top = max(langs, key=lambda l: l["Score"])
    score = round(top["Score"], 4)
    if score < MIN_LANG_CONFIDENCE:
        return CATALOG_SOURCE_LANG, score, True     # no le creemos: manda el catálogo
    return top["LanguageCode"], score, False


def _translate(text, source, target):
    if not text:
        return ""
    resp = translate.translate_text(
        Text=text, SourceLanguageCode=source, TargetLanguageCode=target
    )
    return resp["TranslatedText"]


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

    target = (body.get("target") or "en").lower()
    if target not in ALLOWED_TARGETS:
        return _response(400, {"error": f"target debe ser uno de {sorted(ALLOWED_TARGETS)}"})

    item = table.get_item(Key={"productId": product_id}).get("Item")
    if not item:
        return _response(404, {"error": f"Producto {product_id} no encontrado."})

    nombre = item.get("name", "")
    desc = item.get("description", "")

    try:
        # Un solo detect para los dos campos: más texto, mejor señal (aunque no infalible).
        source, score, fallback = _detect_source(nombre, desc)
        if source == target:
            # Nada que traducir. Antes esto igual llamaba a Translate y podía DEVOLVER
            # UN TEXTO DISTINTO (paráfrasis), reescribiendo el original. Y se pagaba.
            translated_name, translated_desc, omitido = nombre, desc, True
        else:
            translated_name = _translate(nombre, source, target)
            translated_desc = _translate(desc, source, target)
            omitido = False
    except Exception as e:  # noqa: BLE001
        print("Translate error:", repr(e))
        return _response(502, {"error": "Fallo al traducir", "detail": str(e)})

    # Guardamos bajo translations.<lang> usando un mapa anidado.
    table.update_item(
        Key={"productId": product_id},
        UpdateExpression="SET translations = if_not_exists(translations, :empty)",
        ExpressionAttributeValues={":empty": {}},
    )
    table.update_item(
        Key={"productId": product_id},
        UpdateExpression="SET translations.#lang = :t",
        ExpressionAttributeNames={"#lang": target},
        ExpressionAttributeValues={":t": {"name": translated_name, "description": translated_desc}},
    )

    return _response(
        200,
        {
            "productId": product_id,
            "target": target,
            # Transparencia: qué idioma se asumió, con cuánta confianza, si se usó el
            # fallback del catálogo y si se omitió la llamada. Sin esto, una detección
            # equivocada es indistinguible de una traducción correcta.
            "sourceLanguage": source,
            "sourceConfidence": score,
            "sourceFromCatalogDefault": fallback,
            "translationSkipped": omitido,
            "translation": {"name": translated_name, "description": translated_desc},
        },
    )
