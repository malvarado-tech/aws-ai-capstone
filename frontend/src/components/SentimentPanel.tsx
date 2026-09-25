/**
 * S03 · Amazon Comprehend — sentimiento de las reseñas de un producto.
 *
 * Dominio AIF-C01: D1 — Fundamentals of AI and ML (NLP preentrenado: detección de
 * idioma + análisis de sentimiento como servicio administrado).
 *
 * QUÉ COMPORTAMIENTO DEL BACKEND DEFIENDE ESTE COMPONENTE
 * ------------------------------------------------------
 * 1. SON 2N LLAMADAS EN SERIE, SIN BATCH. Por cada texto el handler hace
 *    DetectDominantLanguage y después DetectSentiment, uno atrás del otro, y la
 *    Lambda corta a los 30 s. Diez reseñas ya son veinte round trips: el tope de
 *    10 se aplica ACÁ, en el cliente, porque el backend no lo aplica y el síntoma
 *    de pasarse es un timeout, no un 400 legible.
 * 2. DOS CONVENCIONES DE MAYÚSCULAS EN EL MISMO PAYLOAD. `distribution` viene en
 *    MAYÚSCULA (`POSITIVE`) porque sale de un Counter sobre las etiquetas de
 *    Comprehend; `averageScores` y `results[].scores` vienen Capitalizados
 *    (`Positive`) porque son las claves de `SentimentScore` de la API. Cada
 *    objeto se lee con SUS claves — lo único compartido es la etiqueta en
 *    castellano que mostramos, y la conversión está en un solo lugar explícito.
 * 3. `overallSentiment` SALE DEL PROMEDIO DE SCORES, NO DE LA MAYORÍA. El handler
 *    dejó de usar `Counter.most_common` a propósito (con 1 POSITIVE y 1 NEGATIVE
 *    el veredicto lo decidía el ORDEN de las reseñas) y desempata prefiriendo lo
 *    que exige atención: Negative → Mixed → Positive → Neutral. Por eso el
 *    general puede discrepar de la etiqueta más frecuente, y cuando discrepa lo
 *    explicamos en vez de esconderlo.
 * 4. CON `productId` ESTO MUTA DYNAMODB. Es un botón, nunca un efecto de montaje.
 *    Y si ese `update_item` falla el handler loguea el warning pero devuelve 200
 *    igual: el cliente NO puede afirmar que se guardó. Decimos "se analizó",
 *    avisamos de la duda y llamamos a `onAnalyzed` para que el padre refetchee y
 *    muestre lo que quedó de verdad.
 * 5. `distribution` OMITE LAS CLASES EN CERO (es un Counter): dos reseñas pueden
 *    dar `{POSITIVE: 1, NEGATIVE: 1}` sin claves NEUTRAL/MIXED. Renderizamos las
 *    claves presentes, no las cuatro fijas.
 */
import { useState } from 'react';
import { AlertCircle, Loader2, MessageSquareQuote } from 'lucide-react';
import { AiError, AiNotConfiguredError, aiCapabilities, analyzeSentiment } from '../lib/ai';
import type { SentimentResult } from '../lib/ai';
import type { Product } from '../lib/types';

interface SentimentPanelProps {
  product: Product;
  onAnalyzed?: (productId: string) => void;
  className?: string;
}

interface ErrorDeSentimiento {
  mensaje: string;
  detalle?: string;
  hint?: string;
}

/**
 * Tope de reseñas por llamada. 10 textos = 20 llamadas a Comprehend en serie;
 * medido en el capstone eso entra cómodo en los 30 s de la Lambda, 20 reseñas no.
 */
const MAX_RESENAS = 10;

/** Claves Capitalizadas de `averageScores` / `results[].scores`. */
const ORDEN_SCORES = ['Positive', 'Negative', 'Neutral', 'Mixed'] as const;
type ClaveScore = (typeof ORDEN_SCORES)[number];

/** Orden de presentación de `distribution`, cuyas claves son MAYÚSCULAS. */
const ORDEN_DISTRIBUCION = ['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED'] as const;

/**
 * El ÚNICO puente entre las dos convenciones, y es sólo para la etiqueta visible:
 * normalizamos a mayúsculas para buscar el texto en castellano. Los VALORES nunca
 * se buscan así — cada objeto se indexa con sus propias claves.
 */
function etiquetaEs(clave: string): string {
  switch (clave.toUpperCase()) {
    case 'POSITIVE':
      return 'Positivo';
    case 'NEGATIVE':
      return 'Negativo';
    case 'NEUTRAL':
      return 'Neutral';
    case 'MIXED':
      return 'Mixto';
    default:
      return clave;
  }
}

/** POSITIVE verde, NEGATIVE rojo, NEUTRAL gris, MIXED ámbar. */
function clasesPill(clave: string): string {
  switch (clave.toUpperCase()) {
    case 'POSITIVE':
      return 'bg-green-50 text-green-700 border border-green-200';
    case 'NEGATIVE':
      return 'bg-red-50 text-red-700 border border-red-200';
    case 'MIXED':
      return 'bg-amber-50 text-amber-700 border border-amber-200';
    default:
      return 'bg-gray-100 text-gray-700 border border-gray-200';
  }
}

function claseBarra(clave: string): string {
  switch (clave.toUpperCase()) {
    case 'POSITIVE':
      return 'bg-green-500';
    case 'NEGATIVE':
      return 'bg-red-500';
    case 'MIXED':
      return 'bg-amber-500';
    default:
      return 'bg-gray-400';
  }
}

/**
 * Anchos en doceavos. No usamos `style={{ width }}`: la regla del repo es
 * Tailwind inline, y Tailwind sólo genera las clases que aparecen LITERALES en el
 * source, así que la escalera tiene que estar escrita a mano (un `w-[${n}%]`
 * armado en runtime no existiría en el CSS compilado).
 */
const ANCHOS = [
  'w-0',
  'w-1/12',
  'w-2/12',
  'w-3/12',
  'w-4/12',
  'w-5/12',
  'w-6/12',
  'w-7/12',
  'w-8/12',
  'w-9/12',
  'w-10/12',
  'w-11/12',
  'w-full',
] as const;

function anchoDeFraccion(fraccion: number): string {
  const acotada = Math.min(Math.max(fraccion, 0), 1);
  return ANCHOS[Math.round(acotada * 12)];
}

/**
 * De una etiqueta MAYÚSCULA a la clave Capitalizada del score correspondiente.
 * Switch explícito en vez de un `sent[0] + sent.slice(1).toLowerCase()`: si
 * mañana Comprehend agrega una clase, queremos `null` y no una clave inventada.
 */
function claveScoreDe(sentimiento: string): ClaveScore | null {
  switch (sentimiento.toUpperCase()) {
    case 'POSITIVE':
      return 'Positive';
    case 'NEGATIVE':
      return 'Negative';
    case 'NEUTRAL':
      return 'Neutral';
    case 'MIXED':
      return 'Mixed';
    default:
      return null;
  }
}

function porcentaje(valor: number): string {
  return `${(valor * 100).toFixed(1)}%`;
}

function plural(n: number): string {
  return n === 1 ? '1 reseña' : `${n} reseñas`;
}

/**
 * Etiqueta más frecuente de `distribution`, o `null` si hay empate. El empate no
 * se resuelve a propósito: es exactamente el caso que hizo que el backend deje de
 * contar etiquetas.
 */
function etiquetaMasFrecuente(distribution: Record<string, number>): string | null {
  const entradas = Object.entries(distribution);
  if (entradas.length === 0) {
    return null;
  }
  const maximo = Math.max(...entradas.map(([, n]) => n));
  const empatadas = entradas.filter(([, n]) => n === maximo);
  return empatadas.length === 1 ? empatadas[0][0] : null;
}

/** `AiNotConfiguredError` primero: extiende `AiError`, al revés nunca entraría. */
function describirError(err: unknown): ErrorDeSentimiento {
  if (err instanceof AiNotConfiguredError) {
    return {
      mensaje: 'El análisis de sentimiento no está configurado en este entorno.',
      hint: 'Falta la Function URL de S03 (VITE_ANALYZE_SENTIMENT_URL) en env-config.js.',
    };
  }
  if (err instanceof AiError) {
    return {
      mensaje: err.status ? `${err.message} (HTTP ${err.status})` : err.message,
      detalle: err.detail,
      hint: err.hint,
    };
  }
  return { mensaje: 'No pudimos analizar las reseñas. Probá de nuevo en un momento.' };
}

export function SentimentPanel({ product, onAnalyzed, className = '' }: SentimentPanelProps) {
  const [texto, setTexto] = useState('');
  const [resultado, setResultado] = useState<SentimentResult | null>(null);
  const [guardoPedido, setGuardoPedido] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<ErrorDeSentimiento | null>(null);

  const sentimientoDisponible = aiCapabilities().sentiment;

  // Una reseña por línea; las vacías se descartan acá porque el handler también
  // las filtra y no queremos que cuenten para el tope.
  const resenas = texto
    .split('\n')
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0);

  const excedeTope = resenas.length > MAX_RESENAS;
  const puedeAnalizar =
    resenas.length > 0 && !excedeTope && !cargando && sentimientoDisponible;

  const analizar = async (guardar: boolean) => {
    if (!puedeAnalizar) {
      return;
    }
    setError(null);
    setResultado(null);
    setGuardoPedido(guardar);
    setCargando(true);
    try {
      // Sin `productId` la llamada es de sólo lectura: no se manda la clave en vez
      // de mandarla en undefined, para que el body no la lleve nunca.
      const respuesta = guardar
        ? await analyzeSentiment({ reviews: resenas, productId: product.productId })
        : await analyzeSentiment({ reviews: resenas });
      setResultado(respuesta);
      if (guardar) {
        // El padre refetchea: es la única forma de saber si el update_item anduvo.
        onAnalyzed?.(product.productId);
      }
    } catch (err) {
      setError(describirError(err));
    } finally {
      setCargando(false);
    }
  };

  const idTextarea = `sentiment-reviews-${product.productId}`;
  const idGuardado = `sentiment-guardado-${product.productId}`;
  const idResultado = `sentiment-resultado-${product.productId}`;

  const contadoresGuardados = product.reviewSentimentCounts ?? {};
  const totalGuardado = Object.values(contadoresGuardados).reduce((a, b) => a + b, 0);
  const mayoritaria = resultado ? etiquetaMasFrecuente(resultado.distribution) : null;
  const discrepa = resultado !== null && mayoritaria !== resultado.overallSentiment;
  const totalResultado = resultado
    ? Object.values(resultado.distribution).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div className={`bg-white rounded-lg shadow-md p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <MessageSquareQuote className="w-5 h-5 text-blue-600" aria-hidden="true" />
          Sentimiento de las reseñas
        </h3>
        <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
          S03 · Comprehend
        </span>
      </div>

      {/* ---- Lo que ya está guardado en el producto (S03 con productId) ---- */}
      {product.reviewSentiment ? (
        <section aria-labelledby={idGuardado} className="mb-4">
          <h4 id={idGuardado} className="text-xs font-semibold text-gray-500 uppercase mb-2">
            Sentimiento guardado
          </h4>
          {/* El prefijo visible (en vez de un aria-label en un span sin rol) es lo
              que hace que la pastilla se entienda sola leída por voz. */}
          <p className="text-sm text-gray-700">
            Sentimiento general guardado:{' '}
            <span
              className={`inline-block text-xs px-2 py-1 rounded-full font-medium ${clasesPill(
                product.reviewSentiment
              )}`}
            >
              {etiquetaEs(product.reviewSentiment)}
            </span>
          </p>

          {Object.keys(contadoresGuardados).length > 0 && (
            <ul className="mt-3 space-y-2">
              {/* `reviewSentimentCounts`: claves MAYÚSCULAS. */}
              {ORDEN_DISTRIBUCION.filter((clave) => clave in contadoresGuardados).map((clave) => (
                <li key={clave}>
                  <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                    <span>{etiquetaEs(clave)}</span>
                    <span>{plural(contadoresGuardados[clave])}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full" aria-hidden="true">
                    <div
                      className={`h-2 rounded-full ${claseBarra(clave)} ${anchoDeFraccion(
                        totalGuardado === 0 ? 0 : contadoresGuardados[clave] / totalGuardado
                      )}`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {product.reviewSentimentScores && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {/* `reviewSentimentScores`: claves Capitalizadas. Otro objeto, otras claves. */}
              {ORDEN_SCORES.filter(
                (clave) => product.reviewSentimentScores?.[clave] !== undefined
              ).map((clave) => (
                <li
                  key={clave}
                  className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium"
                >
                  {etiquetaEs(clave)} {porcentaje(product.reviewSentimentScores?.[clave] ?? 0)}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <p className="mb-4 text-xs text-gray-500">
          Este producto todavía no tiene sentimiento guardado. Analizá unas reseñas para
          calcularlo.
        </p>
      )}

      {/* ---- Formulario ---- */}
      <div>
        <label htmlFor={idTextarea} className="block text-sm font-medium text-gray-700 mb-1">
          Reseñas (una por línea)
        </label>
        <textarea
          id={idTextarea}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={4}
          placeholder={'Ingresá una reseña por línea.\nMe encantó la tela, la volvería a comprar.'}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <p className="mt-1 text-xs text-gray-500">
          {plural(resenas.length)} · máximo {MAX_RESENAS} por análisis: el handler hace DOS
          llamadas a Comprehend por texto (detectar idioma y después sentimiento), en serie y sin
          batch, y la Lambda corta a los 30 segundos.
        </p>
      </div>

      {excedeTope && (
        <div
          role="alert"
          className="mt-3 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm"
        >
          <p className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            Son {resenas.length} reseñas y el tope es {MAX_RESENAS}. Serían{' '}
            {resenas.length * 2} llamadas en serie a Comprehend y la Lambda timeoutea a los 30 s.
            Borrá algunas líneas y analizá por tandas.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          onClick={() => analizar(true)}
          disabled={!puedeAnalizar}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
            puedeAnalizar
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {cargando ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <MessageSquareQuote className="w-4 h-4" aria-hidden="true" />
          )}
          Analizar y guardar
        </button>
        <button
          type="button"
          onClick={() => analizar(false)}
          disabled={!puedeAnalizar}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            puedeAnalizar
              ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          Probar sin guardar
        </button>
      </div>

      {!sentimientoDisponible && (
        <p className="mt-3 text-xs text-gray-500">
          Esta capacidad está apagada porque falta su Function URL
          (VITE_ANALYZE_SENTIMENT_URL). Desplegá S03 y volvé a inyectar env-config.js.
        </p>
      )}

      {cargando && (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 flex items-center gap-2 text-sm text-gray-600"
        >
          <span className="sr-only">
            Analizando {plural(resenas.length)} con Amazon Comprehend. Son {resenas.length * 2}{' '}
            llamadas en serie, así que puede tardar unos segundos.
          </span>
          <span aria-hidden="true">Analizando con Amazon Comprehend…</span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm"
        >
          <p className="flex items-start gap-2 font-medium">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            {error.mensaje}
          </p>
          {error.hint && <p className="mt-1 text-xs">{error.hint}</p>}
          {error.detalle && <p className="mt-1 text-xs opacity-80">{error.detalle}</p>}
        </div>
      )}

      {/* ---- Resultado de la llamada ---- */}
      {resultado && (
        <section aria-labelledby={idResultado} className="mt-4 border-t border-gray-100 pt-4">
          <h4 id={idResultado} className="text-xs font-semibold text-gray-500 uppercase mb-2">
            Resultado del análisis
          </h4>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-700">Sentimiento general:</span>
            <span
              className={`text-xs px-2 py-1 rounded-full font-medium ${clasesPill(
                resultado.overallSentiment
              )}`}
            >
              {etiquetaEs(resultado.overallSentiment)}
            </span>
            <span className="text-xs text-gray-500">sobre {plural(resultado.count)}</span>
          </div>

          {guardoPedido ? (
            // Honestidad obligada: el handler devuelve 200 aunque el update_item
            // falle, así que no podemos prometer que quedó guardado.
            <p className="mt-2 text-xs text-gray-500">
              Se analizó y se pidió guardar el resultado en el producto. Si ese guardado falló, el
              handler responde 200 igual y no avisa: lo que se ve arriba, después de refrescar, es
              lo que quedó de verdad.
            </p>
          ) : (
            <p className="mt-2 text-xs text-gray-500">
              Modo prueba: la llamada fue sin productId, así que no se escribió nada en DynamoDB.
            </p>
          )}

          {Object.keys(resultado.distribution).length > 0 && (
            <ul className="mt-3 space-y-2">
              {/* `distribution`: claves MAYÚSCULAS, y las clases en cero no vienen. */}
              {ORDEN_DISTRIBUCION.filter((clave) => clave in resultado.distribution).map(
                (clave) => (
                  <li key={clave}>
                    <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                      <span>{etiquetaEs(clave)}</span>
                      <span>{plural(resultado.distribution[clave])}</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full" aria-hidden="true">
                      <div
                        className={`h-2 rounded-full ${claseBarra(clave)} ${anchoDeFraccion(
                          totalResultado === 0 ? 0 : resultado.distribution[clave] / totalResultado
                        )}`}
                      />
                    </div>
                  </li>
                )
              )}
            </ul>
          )}

          <ul className="mt-3 flex flex-wrap gap-2">
            {/* `averageScores`: claves Capitalizadas. */}
            {ORDEN_SCORES.filter((clave) => resultado.averageScores[clave] !== undefined).map(
              (clave) => (
                <li
                  key={clave}
                  className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium"
                >
                  {etiquetaEs(clave)} {porcentaje(resultado.averageScores[clave] ?? 0)}
                </li>
              )
            )}
          </ul>
          <p className="mt-2 text-xs text-gray-500">
            El sentimiento general se calcula promediando estos scores, no contando las etiquetas
            de arriba: una reseña negativa con 0,99 pesa más que una positiva con 0,51.
          </p>

          {discrepa && (
            <p className="mt-2 text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded-lg p-3">
              {mayoritaria
                ? `El general (${etiquetaEs(
                    resultado.overallSentiment
                  )}) no coincide con la etiqueta más frecuente (${etiquetaEs(mayoritaria)}).`
                : `Hay empate entre etiquetas, así que contarlas no daría un veredicto, y el general quedó ${etiquetaEs(
                    resultado.overallSentiment
                  )}.`}{' '}
              No es un error: el backend promedia scores y desempata prefiriendo lo que exige
              atención (Negative → Mixed → Positive → Neutral).
            </p>
          )}

          {resultado.results.length > 0 && (
            <ul className="mt-3 space-y-2">
              {resultado.results.map((r, indice) => {
                // `r.sentiment` es MAYÚSCULA y `r.scores` Capitalizado: hay que
                // traducir la clave para leer el score de su propia etiqueta.
                const clave = claveScoreDe(r.sentiment);
                const score = clave ? r.scores[clave] : undefined;
                return (
                  <li
                    key={`${indice}-${r.text.slice(0, 16)}`}
                    className="border border-gray-200 rounded-lg p-3"
                  >
                    <p className="text-sm text-gray-700">{r.text}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`text-xs px-2 py-1 rounded-full font-medium ${clasesPill(
                          r.sentiment
                        )}`}
                      >
                        {etiquetaEs(r.sentiment)}
                        {score !== undefined ? ` ${porcentaje(score)}` : ''}
                      </span>
                      {/* El idioma detectado es el punto del diseño de dos
                          llamadas: nadie declaró en qué idioma escribió. */}
                      <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
                        Idioma detectado: {r.language}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
