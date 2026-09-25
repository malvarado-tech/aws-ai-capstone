/**
 * Cliente de las nueve Lambdas de IA (S1–S8).
 *
 * POR QUÉ ESTE ARCHIVO EXISTE SEPARADO DE api.ts
 * ----------------------------------------------
 * `api.ts` habla con el router CRUD, que es UNA Function URL. Cada Lambda de IA
 * tiene su propia Function URL en otro host, así que `${API_URL}/assistant` no
 * llega a ningún lado. Cada capacidad necesita su propia base.
 *
 * TRES COSAS QUE SE VERIFICARON CONTRA LOS HANDLERS Y NO SON OBVIAS
 * ----------------------------------------------------------------
 * 1. Un bloqueo de guardrail devuelve HTTP **200**, no 4xx. El texto de rechazo
 *    viene en `description` / `reply` y sólo `guardrailBlocked` lo distingue de
 *    una respuesta real. Nunca muestres el texto sin mirar ese flag.
 * 2. Los handlers NO decodifican `isBase64Encoded`. Si no mandamos
 *    `Content-Type: application/json`, la Function URL codifica el body en
 *    base64 y el handler muere con 400 "Body JSON inválido".
 * 3. Los errores traen `{error, detail, hint}`. `api.ts` los descarta y sólo
 *    reporta el status; acá los preservamos porque el `hint` de S6/S7/S8 dice
 *    literalmente qué falta configurar (acceso a modelos, correr el indexador).
 */

import type { Product } from './types';

// ---------------------------------------------------------------------------
// Resolución de URLs
// ---------------------------------------------------------------------------

type AiUrlKey =
  | 'VITE_ENRICH_LABELS_URL'
  | 'VITE_MODERATE_IMAGE_URL'
  | 'VITE_ANALYZE_SENTIMENT_URL'
  | 'VITE_TRANSLATE_CATALOG_URL'
  | 'VITE_SYNTHESIZE_VOICE_URL'
  | 'VITE_GENERATE_DESCRIPTION_URL'
  | 'VITE_INDEX_EMBEDDINGS_URL'
  | 'VITE_SEMANTIC_SEARCH_URL'
  | 'VITE_SHOPPING_ASSISTANT_URL';

/**
 * Se resuelve en cada llamada, no al importar el módulo: así los tests pueden
 * cambiar `window.__ENV` entre casos, y una URL que falta se detecta como
 * capacidad apagada en vez de romper el bundle al cargar.
 */
function baseUrl(key: AiUrlKey): string | null {
  const runtime = typeof window !== 'undefined' ? window.__ENV?.[key] : undefined;
  const buildTime = import.meta.env[key] as string | undefined;
  const raw = runtime || buildTime || '';
  if (!raw || raw.startsWith('%%')) {
    // '%%TOKEN%%' = el inyector no sustituyó esta clave.
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/** Qué capacidades están configuradas. La UI esconde lo que no puede llamar. */
export function aiCapabilities() {
  return {
    labels: baseUrl('VITE_ENRICH_LABELS_URL') !== null,
    moderation: baseUrl('VITE_MODERATE_IMAGE_URL') !== null,
    sentiment: baseUrl('VITE_ANALYZE_SENTIMENT_URL') !== null,
    translate: baseUrl('VITE_TRANSLATE_CATALOG_URL') !== null,
    voice: baseUrl('VITE_SYNTHESIZE_VOICE_URL') !== null,
    describe: baseUrl('VITE_GENERATE_DESCRIPTION_URL') !== null,
    index: baseUrl('VITE_INDEX_EMBEDDINGS_URL') !== null,
    search: baseUrl('VITE_SEMANTIC_SEARCH_URL') !== null,
    assistant: baseUrl('VITE_SHOPPING_ASSISTANT_URL') !== null,
  };
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/**
 * Error de un endpoint de IA, con el payload del handler preservado.
 * `hint` viene de S6/S7/S8 y suele ser la instrucción exacta que falta.
 */
export class AiError extends Error {
  readonly status: number;
  readonly detail?: string;
  readonly hint?: string;

  constructor(status: number, message: string, detail?: string, hint?: string) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.detail = detail;
    this.hint = hint;
  }
}

/** Capacidad no configurada: falta la URL en window.__ENV. */
export class AiNotConfiguredError extends AiError {
  constructor(key: AiUrlKey) {
    super(0, `Capacidad de IA no configurada (falta ${key}).`);
    this.name = 'AiNotConfiguredError';
  }
}

async function request<T>(
  key: AiUrlKey,
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const base = baseUrl(key);
  if (base === null) {
    throw new AiNotConfiguredError(key);
  }

  const method = init?.method ?? 'GET';
  const hasBody = method === 'POST';

  const response = await fetch(`${base}${path}`, {
    method,
    // Content-Type obligatorio en POST: sin él la Function URL manda el body en
    // base64 y el handler Python no lo decodifica (400 "Body JSON inválido").
    ...(hasBody ? { headers: { 'Content-Type': 'application/json' } } : {}),
    ...(hasBody ? { body: JSON.stringify(init?.body ?? {}) } : {}),
  });

  // El handler siempre responde JSON, pero un 502 de la plataforma puede no
  // traerlo. Parseamos defensivamente para no perder el status real.
  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message =
      (typeof payload.error === 'string' && payload.error) ||
      (typeof payload.message === 'string' && payload.message) ||
      `Error ${response.status}: ${response.statusText}`;
    throw new AiError(
      response.status,
      message,
      typeof payload.detail === 'string' ? payload.detail : undefined,
      typeof payload.hint === 'string' ? payload.hint : undefined,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// S1 · Rekognition DetectLabels
// ---------------------------------------------------------------------------

export interface LabelsResult {
  productId: string;
  imageSource: 's3' | 'url';
  minConfidence: number;
  labels: { name: string; confidence: number }[];
}

/**
 * Escribe aiLabels + aiLabelsRaw SIEMPRE (no hay flag de guardado).
 * 422 si el producto todavía tiene el imageUrl de placeholder.
 */
export function enrichLabels(productId: string): Promise<LabelsResult> {
  return request('VITE_ENRICH_LABELS_URL', `/products/${productId}/labels`, {
    method: 'POST',
    body: {},
  });
}

// ---------------------------------------------------------------------------
// S2 · Rekognition moderación + alt-text
// ---------------------------------------------------------------------------

export interface ModerationResult {
  productId: string;
  moderationStatus: 'APPROVED' | 'FLAGGED';
  moderationFlags: { name: string; parent: string; confidence: number }[];
  altText: string;
}

/** Dos llamadas a Rekognition (moderación + labels para el alt-text). ~2-4 s. */
export function moderateImage(productId: string): Promise<ModerationResult> {
  return request('VITE_MODERATE_IMAGE_URL', `/products/${productId}/moderate`, {
    method: 'POST',
    body: {},
  });
}

// ---------------------------------------------------------------------------
// S3 · Comprehend
// ---------------------------------------------------------------------------

export interface SentimentResult {
  count: number;
  /**
   * Derivado del PROMEDIO de scores, no de la mayoría de etiquetas: puede
   * discrepar legítimamente de `distribution`. No los presentes como si uno
   * implicara al otro.
   */
  overallSentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED';
  /** Claves en MAYÚSCULA. */
  distribution: Record<string, number>;
  /** Claves Capitalizadas. Sí, distinto de `distribution`. */
  averageScores: { Positive?: number; Negative?: number; Neutral?: number; Mixed?: number };
  results: {
    text: string;
    language: string;
    sentiment: string;
    scores: { Positive?: number; Negative?: number; Neutral?: number; Mixed?: number };
  }[];
}

/**
 * Dos llamadas a Comprehend POR TEXTO, en serie (detectar idioma + sentimiento).
 * N reseñas = 2N round trips sin batch, y el handler timeoutea a los 30 s:
 * limitá el array desde la UI (~10 como máximo).
 *
 * Sin `productId` es de sólo lectura. Con `productId` persiste
 * reviewSentiment / reviewSentimentCounts / reviewSentimentScores — y si ese
 * guardado falla, el handler igual devuelve 200 sin avisar.
 */
export function analyzeSentiment(input: {
  text?: string;
  reviews?: string[];
  productId?: string;
}): Promise<SentimentResult> {
  return request('VITE_ANALYZE_SENTIMENT_URL', '/sentiment', {
    method: 'POST',
    body: input,
  });
}

// ---------------------------------------------------------------------------
// S4 · Translate
// ---------------------------------------------------------------------------

export interface TranslateResult {
  productId: string;
  target: 'en' | 'es';
  sourceLanguage: string;
  sourceConfidence: number | null;
  sourceFromCatalogDefault: boolean;
  /** true = origen == destino: `translation` trae los ORIGINALES, no una traducción. */
  translationSkipped: boolean;
  translation: { name: string; description: string };
}

export function translateProduct(
  productId: string,
  target: 'en' | 'es',
): Promise<TranslateResult> {
  return request('VITE_TRANSLATE_CATALOG_URL', `/products/${productId}/translate`, {
    method: 'POST',
    body: { target },
  });
}

// ---------------------------------------------------------------------------
// S5 · Polly
// ---------------------------------------------------------------------------

export interface VoiceResult {
  productId: string;
  lang: string;
  voice: 'Lupe' | 'Joanna';
  /** Prefirmada, vive `expiresIn` segundos y NO se persiste. */
  audioUrl: string;
  expiresIn: number;
}

/**
 * El handler NO valida `lang`: cualquier valor cae en la voz española sin error.
 * Por eso el tipo lo restringe acá.
 *
 * `lang: 'en'` lee translations.en si existe; si no, hace que una voz inglesa
 * lea el texto español. Corré S4 antes para que tenga sentido.
 */
export function synthesizeVoice(productId: string, lang: 'es' | 'en'): Promise<VoiceResult> {
  return request('VITE_SYNTHESIZE_VOICE_URL', `/products/${productId}/voice`, {
    method: 'POST',
    body: { lang },
  });
}

// ---------------------------------------------------------------------------
// S6 · Bedrock Converse
// ---------------------------------------------------------------------------

export interface DescribeResult {
  productId: string;
  model: string;
  tone: string;
  saved: boolean;
  /** Si guardrailBlocked es true, esto es el mensaje de rechazo, NO una descripción. */
  description: string;
  stopReason: 'end_turn' | 'max_tokens' | 'guardrail_intervened' | string;
  guardrailBlocked: boolean;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * Generativo: segundos de latencia (timeout 60 s). Requiere spinner.
 *
 * Dos trampas del handler, ya evitadas por esta firma:
 *  - `tone: null` explícito rompe el converse con ValidationException → 502.
 *    Por eso `tone` es opcional y se omite en vez de mandarse nulo.
 *  - `save` se evalúa con bool(), así que el STRING "false" guardaría igual.
 *    Acá es boolean de verdad.
 *
 * `stopReason === 'max_tokens'` significa cortado a mitad de frase (límite 300).
 */
export function generateDescription(
  productId: string,
  opts?: { tone?: string; save?: boolean },
): Promise<DescribeResult> {
  const body: { tone?: string; save: boolean } = { save: opts?.save === true };
  if (opts?.tone) {
    body.tone = opts.tone;
  }
  return request('VITE_GENERATE_DESCRIPTION_URL', `/products/${productId}/describe`, {
    method: 'POST',
    body,
  });
}

// ---------------------------------------------------------------------------
// S7 · Titan Embeddings — indexador
// ---------------------------------------------------------------------------

export interface IndexResult {
  indexed: number;
  skipped: number;
  total: number;
  model: string;
}

/**
 * EL ENDPOINT MÁS CARO Y LENTO DEL CAPSTONE. Recorre TODA la tabla, una llamada
 * a Bedrock + un update_item por producto, en serie (timeout 120 s). Mutá con
 * confirmación explícita del usuario; nunca lo disparés al cargar la página.
 *
 * No tiene camino de error 4xx: los fallos por producto se cuentan en `skipped`
 * y devuelve 200 igual. `indexed: 0` con `skipped > 0` es la señal de "no hay
 * acceso a los modelos de Bedrock", y hay que detectarla mirando los números.
 *
 * Es prerequisito duro de searchProducts() y askAssistant().
 */
export function indexEmbeddings(): Promise<IndexResult> {
  return request('VITE_INDEX_EMBEDDINGS_URL', '/search/index', {
    method: 'POST',
    body: {},
  });
}

// ---------------------------------------------------------------------------
// S7 · Búsqueda semántica
// ---------------------------------------------------------------------------

export interface SearchResult {
  query: string;
  results: {
    productId: string;
    name: string;
    category: string;
    price: number | null;
    score: number;
  }[];
  /** Sólo presente cuando no se pudo puntuar nada: "¿Corriste POST /search/index primero?" */
  hint?: string;
}

/**
 * Sólo lectura, pero CADA llamada es un embedding de Bedrock: hacé debounce.
 *
 * El coseno no tiene piso de relevancia: una vez que hay algo indexado siempre
 * devuelve hasta 5 resultados, incluso para una consulta sin sentido. `score`
 * es la única señal — mostralo o filtrá por umbral en el cliente.
 *
 * Sólo acepta `?q=` en la query string: un POST con {q} se ignora y da 400.
 */
export function searchProducts(query: string): Promise<SearchResult> {
  return request('VITE_SEMANTIC_SEARCH_URL', `/search?q=${encodeURIComponent(query)}`, {
    method: 'GET',
  });
}

// ---------------------------------------------------------------------------
// S8 · Asistente de compras (RAG)
// ---------------------------------------------------------------------------

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantResult {
  /** Si guardrailBlocked es true, esto es el mensaje de rechazo. */
  reply: string;
  /** Vacío = ningún producto tenía embedding → hay que correr el indexador. */
  retrieved: { productId: string; name: string }[];
  model: string;
  stopReason: string;
  guardrailBlocked: boolean;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/** Turnos de historial que enviamos como máximo (el handler no tiene tope propio). */
export const ASSISTANT_HISTORY_LIMIT = 8;

/**
 * Dos llamadas a Bedrock (embedding + converse) más un scan completo. Timeout
 * 60 s y NO hay streaming (usa `converse`, no `converse_stream`): lo máximo
 * honesto es un indicador de "escribiendo…".
 *
 * El historial lo administra el frontend — el handler no lo persiste. Bedrock
 * exige roles alternados empezando en `user`, y un historial mal formado da
 * ValidationException → 502; por eso recortamos a los últimos turnos.
 */
export function askAssistant(
  message: string,
  history: AssistantTurn[] = [],
): Promise<AssistantResult> {
  return request('VITE_SHOPPING_ASSISTANT_URL', '/assistant', {
    method: 'POST',
    body: {
      message,
      history: history.slice(-ASSISTANT_HISTORY_LIMIT),
    },
  });
}

// ---------------------------------------------------------------------------
// Utilidad de catálogo
// ---------------------------------------------------------------------------

/**
 * Saca `embedding` de un producto. GET /products devuelve el item completo sin
 * ProjectionExpression, así que cada producto arrastra ~8-20 KB de vector en
 * JSON que la UI no usa nunca. Arreglarlo del lado del backend requeriría tocar
 * la Lambda, que está fuera de alcance.
 */
export function stripEmbedding(product: Product): Product {
  if (product.embedding === undefined) {
    return product;
  }
  // Copiar y borrar en vez de destructurar y descartar: el eslint del repo no
  // tiene varsIgnorePattern, así que un `const { embedding: _x, ...rest }` da
  // error de variable sin usar.
  const copy = { ...product };
  delete copy.embedding;
  return copy;
}
