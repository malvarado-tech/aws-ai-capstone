/**
 * S07 · Búsqueda semántica del catálogo (Amazon Bedrock · Titan Embeddings v2).
 *
 * QUÉ SERVICIO EXPONE, Y POR QUÉ ESE
 * ----------------------------------
 * El handler de S07 convierte la consulta en un vector con **Titan Embeddings
 * v2** y lo compara por coseno contra el `embedding` que cada producto tiene
 * guardado en DynamoDB. No es el filtro por substring de App.tsx: "algo para una
 * entrevista" puede traer una camisa blanca aunque no comparta ni una palabra
 * con el título. Titan (y no un LLM) porque embeddings es justamente el modelo
 * barato y determinístico para representar texto como vector.
 *
 * TRES COMPORTAMIENTOS DEL BACKEND CONTRA LOS QUE ESTE COMPONENTE SE DEFIENDE
 * --------------------------------------------------------------------------
 * 1. DEBOUNCE DE 500 ms, NO NEGOCIABLE. Cada GET /search es un embedding de
 *    Bedrock **facturado**. Sin debounce, tipear "camisa blanca" son 14
 *    invocaciones para una sola intención del usuario. El timer se reinicia en
 *    cada tecla y la respuesta vieja se descarta con el flag `cancelled`, así
 *    una respuesta lenta no sobreescribe a una consulta más nueva.
 * 2. EL COSENO NO TIENE PISO DE RELEVANCIA. Una vez que hay algo indexado el
 *    handler devuelve hasta 5 resultados **siempre**, incluso para "asdfgh".
 *    Por eso el `score` se muestra siempre: es la única señal de relevancia que
 *    existe, y esconderla haría pasar ruido por resultado.
 * 3. `hint` APARECE SÓLO CUANDO NO SE PUDO PUNTUAR NADA — o sea, cuando ningún
 *    producto tiene embedding todavía. Ese caso no es "no hay resultados", es
 *    "falta correr el indexador", y se muestra como aviso destacado.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Search, Sparkles } from 'lucide-react';
import { AiError, AiNotConfiguredError, searchProducts } from '../lib/ai';
import type { SearchResult } from '../lib/ai';

interface SemanticSearchProps {
  /** El padre decide qué hacer con el producto elegido (abrir modal, scrollear…). */
  onSelectProduct?: (productId: string) => void;
  className?: string;
}

/** 500 ms es el piso: por debajo se facturan embeddings de teclas intermedias. */
const DEBOUNCE_MS = 500;

/**
 * El ancho de la barra sale de clases FIJAS de Tailwind, en baldes.
 * Un `w-[${pct}%]` calculado en runtime no existe en el CSS compilado: Tailwind
 * escanea los archivos en build time y nunca ve ese string. La barra es sólo
 * decorativa (`aria-hidden`); el dato exacto va como texto al lado.
 */
function scoreBarWidth(score: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  if (pct >= 90) return 'w-full';
  if (pct >= 75) return 'w-3/4';
  if (pct >= 60) return 'w-3/5';
  if (pct >= 40) return 'w-2/5';
  if (pct >= 25) return 'w-1/4';
  return 'w-1/12';
}

function scorePercent(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

export function SemanticSearch({ onSelectProduct, className = '' }: SemanticSearchProps) {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ message: string; detail?: string; hint?: string } | null>(
    null
  );
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();

    // Consulta vacía: ni llamada, ni resultados, ni error. Un embedding de "" no
    // significa nada y se cobra igual.
    if (trimmed === '') {
      setData(null);
      setFailure(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setFailure(null);

      searchProducts(trimmed)
        .then((result) => {
          if (!cancelled) {
            setData(result);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          setData(null);
          if (err instanceof AiNotConfiguredError) {
            // Capacidad apagada: no es un error del usuario, se esconde la UI.
            setUnavailable(true);
          } else if (err instanceof AiError) {
            // `hint` y `detail` del handler valen más que el mensaje genérico:
            // suelen decir literalmente qué falta configurar.
            setFailure({ message: err.message, detail: err.detail, hint: err.hint });
          } else {
            setFailure({ message: 'No pudimos completar la búsqueda semántica.' });
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  if (unavailable) {
    return (
      <div className={`bg-white rounded-lg shadow-md p-5 ${className}`}>
        <p className="text-sm text-gray-500">
          Búsqueda semántica no disponible: falta configurar el endpoint de S07.
        </p>
      </div>
    );
  }

  const results = data?.results ?? [];

  return (
    <div className={`bg-white rounded-lg shadow-md p-5 ${className}`}>
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-5 h-5 text-blue-600" aria-hidden="true" />
        <h3 className="text-lg font-semibold text-gray-900">Búsqueda semántica</h3>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Describí lo que necesitás, no el nombre exacto del producto: compara significado con
        embeddings de Titan, no palabras.
      </p>

      <label htmlFor="semantic-search-query" className="block text-sm font-medium text-gray-700 mb-1">
        Buscá con lenguaje natural
      </label>
      <div className="relative">
        <Search
          className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
          aria-hidden="true"
        />
        <input
          type="search"
          id="semantic-search-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full pl-11 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="Ej: algo elegante para una entrevista"
        />
      </div>

      {loading && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 mt-4">
          <Loader2 className="w-4 h-4 text-blue-600 animate-spin" aria-hidden="true" />
          <span className="sr-only">Buscando productos…</span>
          <span className="text-sm text-gray-500" aria-hidden="true">
            Buscando…
          </span>
        </div>
      )}

      {failure && (
        <div
          role="alert"
          className="mt-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg"
        >
          <p className="font-medium">{failure.message}</p>
          {failure.detail && <p className="text-sm mt-1">{failure.detail}</p>}
          {failure.hint && <p className="text-sm mt-1 font-medium">{failure.hint}</p>}
        </div>
      )}

      {/*
        El `hint` del handler es el camino "índice vacío": ningún producto tenía
        embedding, así que no hubo nada que puntuar. Se muestra destacado porque
        la acción correcta es administrativa (correr el indexador de S07), no
        reescribir la consulta.
      */}
      {data?.hint && (
        <div
          role="alert"
          className="mt-4 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">El índice de embeddings todavía no está construido.</p>
              <p className="text-sm mt-1">{data.hint}</p>
              <p className="text-sm mt-1">
                Pedile a quien administre el catálogo que corra el indexador (POST /search/index)
                antes de volver a buscar.
              </p>
            </div>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-gray-500 mb-2">
            {results.length} resultado{results.length === 1 ? '' : 's'} ordenados por similitud. Ojo:
            el coseno no tiene piso, así que mirá el porcentaje antes de confiar en un resultado.
          </p>
          <ul className="space-y-2">
            {results.map((item) => (
              <li key={item.productId}>
                <button
                  type="button"
                  onClick={() => onSelectProduct?.(item.productId)}
                  className="w-full text-left px-4 py-3 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-lg transition-colors focus:ring-2 focus:ring-blue-500"
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="font-medium text-gray-900">{item.name}</span>
                    <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium shrink-0">
                      {item.category}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-3 mt-2">
                    <span className="text-sm font-semibold text-gray-900">
                      {item.price === null ? 'Precio no disponible' : `$${item.price.toFixed(2)}`}
                    </span>
                    <span className="text-xs text-gray-600">
                      {scorePercent(item.score)}% de similitud
                    </span>
                  </span>
                  <span className="block mt-2 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <span
                      className={`block h-full bg-blue-600 rounded-full ${scoreBarWidth(item.score)}`}
                      aria-hidden="true"
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && !data.hint && results.length === 0 && !loading && (
        <p className="mt-4 text-sm text-gray-500">
          No encontramos nada parecido a «{data.query}». Probá describirlo de otra forma.
        </p>
      )}
    </div>
  );
}
