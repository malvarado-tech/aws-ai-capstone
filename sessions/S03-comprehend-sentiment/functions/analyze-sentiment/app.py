"""
S3 · ANALYZE SENTIMENT  —  Sentimiento de reseñas con Amazon Comprehend.

Flujo:
  POST /sentiment
    body: { "text": "..." }                         -> sentimiento de un texto
       o: { "reviews": ["...", "..."], "productId": "abc" }  -> agrega y guarda

    1. Detecta el idioma dominante (DetectDominantLanguage).
    2. Analiza el sentimiento (DetectSentiment) en ese idioma.
    3. Si vienen varias reseñas + productId, calcula el agregado y lo guarda en el producto.

Servicio de IA: Amazon Comprehend (NLP preentrenado).
Dominio AIF-C01: D1 — Fundamentals of AI and ML (procesamiento de lenguaje natural).
"""

import json
import os
from collections import Counter
from decimal import Decimal

import boto3

PRODUCTS_TABLE = os.environ["PRODUCTS_TABLE"]
# Comprehend DetectSentiment soporta un set acotado de idiomas; ajustamos al detectado.
SUPPORTED = {"es", "en", "fr", "de", "it", "pt", "ar", "hi", "ja", "ko", "zh", "zh-TW"}

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


def _detect_language(text):
    resp = comprehend.detect_dominant_language(Text=text)
    langs = resp.get("Languages", [])
    code = langs[0]["LanguageCode"] if langs else "en"
    # Comprehend usa "es","en"... pero DetectSentiment no acepta variantes regionales raras.
    return code if code in SUPPORTED else "en"


def _analyze_one(text):
    lang = _detect_language(text)
    s = comprehend.detect_sentiment(Text=text, LanguageCode=lang)
    return {
        "text": text,
        "language": lang,
        "sentiment": s["Sentiment"],            # POSITIVE | NEGATIVE | NEUTRAL | MIXED
        "scores": {k: round(v, 4) for k, v in s["SentimentScore"].items()},
    }


def _aggregate(results):
    """Sentimiento agregado del producto, promediando los SCORES (no contando etiquetas).

    Por qué no `Counter(...).most_common(1)`, que era la version anterior: con dos reseñas,
    una POSITIVE y una NEGATIVE, hay empate 1-1 y `most_common` devuelve la primera que se
    insertó — o sea que **el veredicto lo decidía el ORDEN de las reseñas**. Medido: las
    mismas dos reseñas del bolso dan POSITIVE si la buena va primera y NEGATIVE si va
    segunda. Un producto al que se le descosió el asa aparecía como POSITIVE.

    Promediar los scores usa la información que la etiqueta tira a la basura: una reseña
    NEGATIVE con 0.9998 pesa más que una POSITIVE con 0.51, que es justo lo que uno quiere
    para priorizar qué producto necesita atención.

    El desempate sigue la misma lógica de gobernanza que el umbral de S2: ante la duda,
    preferimos la etiqueta que llama a una persona antes que la que tranquiliza.
    """
    keys = ("Positive", "Negative", "Neutral", "Mixed")
    n = len(results) or 1
    avg = {k: sum(r["scores"].get(k, 0.0) for r in results) / n for k in keys}
    mejor = max(avg.values())
    # Desempate explícito y determinista: primero lo que exige atención.
    for k in ("Negative", "Mixed", "Positive", "Neutral"):
        if avg[k] == mejor:
            return k.upper(), {k2: round(v, 4) for k2, v in avg.items()}
    return "NEUTRAL", {k: round(v, 4) for k, v in avg.items()}


def lambda_handler(event, context):
    print("Event:", json.dumps(event))
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "Body JSON inválido."})

    texts = []
    if body.get("text"):
        texts = [body["text"]]
    elif body.get("reviews"):
        texts = [t for t in body["reviews"] if isinstance(t, str) and t.strip()]

    if not texts:
        return _response(400, {"error": "Enviá 'text' o 'reviews' (lista de strings)."})

    results = [_analyze_one(t) for t in texts]

    tally = Counter(r["sentiment"] for r in results)
    overall, avg = _aggregate(results)

    product_id = body.get("productId")
    if product_id and len(results) > 0:
        try:
            # DynamoDB NO acepta float -> los promedios van como Decimal. Mismo caso que
            # S1 y S2; acá tampoco se ve venir, porque reviewSentimentCounts son enteros
            # y sólo los scores promediados son float.
            avg_ddb = {k: Decimal(str(v)) for k, v in avg.items()}
            table.update_item(
                Key={"productId": product_id},
                UpdateExpression=(
                    "SET reviewSentiment = :s, reviewSentimentCounts = :c, "
                    "reviewSentimentScores = :a"
                ),
                ExpressionAttributeValues={":s": overall, ":c": dict(tally), ":a": avg_ddb},
            )
        except Exception as e:  # noqa: BLE001
            print("DDB update warn:", repr(e))

    return _response(
        200,
        {
            "count": len(results),
            "overallSentiment": overall,
            # distribution = cuántas reseñas de cada clase (para mostrar).
            # averageScores = en qué se basa overallSentiment (para justificarlo).
            "distribution": dict(tally),
            "averageScores": avg,
            "results": results,
        },
    )
