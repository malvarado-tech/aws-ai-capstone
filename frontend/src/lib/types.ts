/**
 * Contrato de datos del catálogo.
 *
 * IMPORTANTE: estos nombres de campo deben coincidir EXACTAMENTE con lo que
 * guarda el backend en DynamoDB (camelCase). La fuente de verdad es:
 *   - la PK de la tabla:            productId   (template.yaml)
 *   - lo que persiste create-item:  functions/create-item/index.js
 *   - lo que escriben las Lambdas de IA (sessions/S0N/functions/.../app.py)
 *
 * Si agregás un campo acá, agregalo también en create-item y update-item, o se
 * descarta en silencio (el handler arma un objeto explícito, no hace passthrough).
 */
export interface Product {
  productId: string;
  name: string;
  description: string;
  price: number;
  category: string;
  stock: number;
  imageUrl: string;
  createdAt?: string;
  updatedAt?: string;

  // ---- Campos que agregan las sesiones de IA (opcionales) ----
  //
  // Estos nombres se verificaron UNO POR UNO contra el `update_item` de cada
  // handler (sessions/S0N/functions/*/app.py). Antes había cinco inventados
  // (aiModeration, aiAltText, aiSentiment, aiTranslations, aiAudioUrl,
  // aiEmbedding) que el backend nunca escribió: como son opcionales, TypeScript
  // no se quejaba y los componentes leían `undefined` en silencio.
  // Si agregás uno, copiá el nombre del `SET ...` del handler, no lo deduzcas.

  // S1 · Rekognition DetectLabels → SET aiLabels, aiLabelsRaw
  aiLabels?: string[];
  aiLabelsRaw?: { name: string; confidence: number }[];

  // S2 · Rekognition moderación + alt-text → SET moderationStatus, moderationFlags, altText
  moderationStatus?: 'APPROVED' | 'FLAGGED';
  moderationFlags?: { name: string; parent: string; confidence: number }[];
  altText?: string;

  // S3 · Comprehend → SET reviewSentiment, reviewSentimentCounts, reviewSentimentScores
  // (sólo si el POST /sentiment llevaba productId)
  reviewSentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED';
  reviewSentimentCounts?: Record<string, number>;
  reviewSentimentScores?: { Positive?: number; Negative?: number; Neutral?: number; Mixed?: number };

  // S5 · Polly → SET audioKey (NO audioUrl).
  // La URL prefirmada vive 3600 s y NUNCA se persiste: para reproducir hay que
  // volver a llamar al endpoint. El bucket es privado, así que audioKey por sí
  // solo no sirve en el browser.
  audioKey?: string;

  // S6 · Bedrock Converse → SET aiDescription, aiDescriptionModel (sólo si save:true)
  aiDescription?: string;
  aiDescriptionModel?: string;

  // S7 · Titan Embeddings → SET embedding, embeddingModel, embeddingDim
  // OJO: `embedding` es un STRING (json.dumps del vector), no number[]. Son
  // ~8-20 KB por producto y GET /products los devuelve enteros: descartalos en
  // el cliente antes de guardar el producto en estado.
  embedding?: string;
  embeddingModel?: string;
  embeddingDim?: number;

  // ---- Traducciones estructuradas (del backend, S04) ----
  translations?: {
    es?: {
      name?: string;
      description?: string;
    };
    en?: {
      name?: string;
      description?: string;
    };
  };
}
