/**
 * S07 · Indexador de embeddings del catálogo (Amazon Bedrock · Titan Embeddings v2).
 *
 * QUÉ DOMINIO DEL EXAMEN CUBRE (AIF-C01)
 * --------------------------------------
 * Dominio 3 — Aplicaciones de modelos fundacionales: embeddings, búsqueda
 * vectorial y RAG. Este panel es la "R" de RAG: sin vectores no hay nada que
 * recuperar, así que la búsqueda semántica (S07) y el asistente (S08) devuelven
 * vacío hasta que alguien corre esto al menos una vez. De paso toca Dominio 5
 * (gobernanza responsable): es una operación que cuesta plata, y por eso la UI
 * pide confirmación explícita en vez de disparar con un solo clic.
 *
 * COMPORTAMIENTO DEL BACKEND CONTRA EL QUE ESTÁ ESCRITA ESTA UI
 * ------------------------------------------------------------
 * 1. Recorre TODA la tabla de productos: una llamada a Bedrock + un update_item
 *    por producto, EN SERIE. El handler timeoutea a los 120 s. De ahí el spinner
 *    con contador de segundos (honesto) en lugar de un porcentaje inventado
 *    (mentira: el endpoint no reporta progreso parcial), y el disparador
 *    deshabilitado mientras está en vuelo.
 * 2. NO EXISTE camino de error 4xx. Los fallos por producto se suman a `skipped`
 *    y el handler devuelve 200 igual. Por eso `{ indexed: 0, skipped: N }` con
 *    N > 0 NO es un éxito: es la firma de "falta habilitar Bedrock → Model
 *    access". Hay que detectarla mirando los números, porque no se va a lanzar
 *    ninguna excepción que catchear. Se renderiza como advertencia accionable.
 * 3. Nunca se dispara al montar. Es el endpoint más caro y lento del capstone;
 *    un `useEffect` que lo llamara solo sería un incidente de costos.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Info, Loader2 } from 'lucide-react';
import { AiError, AiNotConfiguredError, aiCapabilities, indexEmbeddings } from '../lib/ai';
import type { IndexResult } from '../lib/ai';

interface AdminAIOpsProps {
  onIndexed?: (result: { indexed: number; skipped: number; total: number }) => void;
  className?: string;
}

/** Máquina de estados del panel. `confirming` es el paso de confirmación in-component. */
type OpsStatus = 'idle' | 'confirming' | 'running' | 'done' | 'error';

/** Lo que el handler timeoutea, en segundos: lo mostramos para fijar expectativas. */
const HANDLER_TIMEOUT_SECONDS = 120;

interface AiErrorLike {
  message: string;
  status?: number;
  detail?: string;
  hint?: string;
  notConfigured: boolean;
}

/**
 * Normaliza lo que venga del catch a los campos que sabemos mostrar.
 *
 * Por qué no alcanza `instanceof`: el automock de vitest (`vi.mock('../lib/ai')`)
 * achata el prototipo, así que un `AiNotConfiguredError` construido en un test
 * NO pasa `instanceof AiError`. Probamos las clases reales primero (es el camino
 * de producción y es el que typea) y caemos a leer las propiedades, para no
 * perder nunca el `hint`, que en S6/S7/S8 dice literalmente qué falta configurar.
 */
function toAiErrorLike(err: unknown): AiErrorLike {
  if (err instanceof AiError) {
    return {
      message: err.message,
      status: err.status,
      detail: err.detail,
      hint: err.hint,
      notConfigured: err instanceof AiNotConfiguredError || err.status === 0,
    };
  }
  if (typeof err === 'object' && err !== null) {
    const bag = err as { name?: unknown; message?: unknown; status?: unknown; detail?: unknown; hint?: unknown };
    const status = typeof bag.status === 'number' ? bag.status : undefined;
    return {
      message: typeof bag.message === 'string' && bag.message ? bag.message : 'Falló el indexado.',
      status,
      detail: typeof bag.detail === 'string' ? bag.detail : undefined,
      hint: typeof bag.hint === 'string' ? bag.hint : undefined,
      notConfigured: bag.name === 'AiNotConfiguredError' || status === 0,
    };
  }
  return { message: 'Falló el indexado por un error desconocido.', notConfigured: false };
}

/**
 * Clasifica el resultado. Es la pieza central del componente: el backend devuelve
 * 200 siempre, así que la diferencia entre "funcionó" y "no hay acceso a los
 * modelos" sale únicamente de estos tres números.
 */
function classifyResult(result: IndexResult): 'success' | 'modelAccess' | 'empty' {
  if (result.indexed > 0) return 'success';
  if (result.skipped > 0) return 'modelAccess';
  return 'empty';
}

export function AdminAIOps({ onIndexed, className = '' }: AdminAIOpsProps) {
  const [status, setStatus] = useState<OpsStatus>('idle');
  const [result, setResult] = useState<IndexResult | null>(null);
  const [failure, setFailure] = useState<AiErrorLike | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // useId en vez de un id literal: si el panel se montara dos veces, dos ids
  // iguales dejarían el aria-labelledby apuntando al heading equivocado.
  const headingId = useId();

  // `aiCapabilities()` siempre devuelve un objeto en producción; el `?.` es por el
  // automock de vitest, que devuelve undefined. Sólo `index: false` explícito
  // apaga el panel, así que un test que no mockee la función ve la capacidad viva.
  const isConfigured = aiCapabilities()?.index !== false;

  const isRunning = status === 'running';
  const isConfirming = status === 'confirming';

  /**
   * Contador de segundos transcurridos. No es una barra de progreso porque el
   * endpoint no reporta avance: es lo único honesto que podemos mostrar.
   */
  useEffect(() => {
    if (status !== 'running') {
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  // El paso de confirmación tiene que ser operable por teclado: al aparecer,
  // movemos el foco al botón que confirma.
  useEffect(() => {
    if (isConfirming) {
      confirmRef.current?.focus();
    }
  }, [isConfirming]);

  const handleRequestConfirm = () => {
    setFailure(null);
    setStatus('confirming');
  };

  const handleCancel = () => {
    setStatus(result !== null ? 'done' : 'idle');
  };

  const handleConfirm = async () => {
    setFailure(null);
    setResult(null);
    setElapsed(0);
    setStatus('running');
    try {
      const indexResult = await indexEmbeddings();
      setResult(indexResult);
      setStatus('done');
      // Sólo avisamos hacia afuera cuando de verdad se indexó algo: con
      // `indexed: 0` el catálogo sigue sin vectores y nada que dependa de esto
      // debería refrescarse como si hubiera funcionado.
      if (indexResult.indexed > 0) {
        onIndexed?.(indexResult);
      }
    } catch (err) {
      setFailure(toAiErrorLike(err));
      setStatus('error');
    }
  };

  const outcome = result !== null ? classifyResult(result) : null;

  return (
    <section
      aria-labelledby={headingId}
      className={`bg-white rounded-lg shadow-md border border-gray-200 p-5 ${className}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div className="bg-gray-900 p-2 rounded-lg">
            <Database className="w-5 h-5 text-white" aria-hidden="true" />
          </div>
          <div>
            <h2 id={headingId} className="text-lg font-semibold text-gray-900">
              Operaciones de IA · Indexador de embeddings
            </h2>
            <p className="text-sm text-gray-500">Herramienta de administración del catálogo</p>
          </div>
        </div>
        <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium whitespace-nowrap">
          S07 · Titan Embeddings v2
        </span>
      </div>

      {/* Superficie didáctica: qué ES indexar. Sin esto el botón es magia. */}
      <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 mb-4">
        <p className="text-sm text-gray-700">
          Indexar convierte el texto de cada producto (nombre, descripción, categoría) en un{' '}
          <strong className="font-semibold">vector</strong> de 1024 dimensiones con Amazon Titan
          Embeddings v2, y lo guarda en el mismo item de DynamoDB. Esos vectores son lo que permite
          buscar <em>por significado</em> —&nbsp;&ldquo;algo abrigado para el invierno&rdquo;&nbsp;— en
          lugar de por coincidencia de palabras, y son lo que el asistente recupera antes de
          responder: el paso <strong className="font-semibold">Retrieve</strong> del patrón RAG.
        </p>
        <p className="text-sm text-gray-600 mt-2">
          Es un <strong className="font-semibold">prerequisito duro</strong>: hasta que corrás esto una
          vez, la búsqueda semántica y el asistente no devuelven nada.
        </p>
      </div>

      {!isConfigured ? (
        // Capacidad apagada: falta VITE_INDEX_EMBEDDINGS_URL. Deshabilitamos con
        // explicación en vez de dejar que la llamada explote.
        <div className="rounded-lg bg-gray-100 border border-gray-200 px-4 py-3">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-gray-500 mt-0.5 shrink-0" aria-hidden="true" />
            <p className="text-sm text-gray-700">
              El indexador no está configurado en este entorno: falta la Function URL de S07
              (<code className="text-xs">VITE_INDEX_EMBEDDINGS_URL</code>). Desplegá la sesión 7 y
              volvé a inyectar la configuración de runtime para habilitarlo.
            </p>
          </div>
          <button
            type="button"
            disabled
            className="mt-3 px-4 py-2 rounded-lg font-medium bg-gray-100 text-gray-400 cursor-not-allowed"
          >
            Reindexar catálogo
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={handleRequestConfirm}
            disabled={isRunning || isConfirming}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              isRunning || isConfirming
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <Database className="w-4 h-4" aria-hidden="true" />
            )}
            Reindexar catálogo
          </button>

          {isConfirming && (
            // Confirmación construida en el componente, no `window.confirm()`:
            // así es testeable, estilable y accesible por teclado.
            <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" aria-hidden="true" />
                <div>
                  <h3 className="text-sm font-semibold text-amber-800">
                    Confirmá: esta operación recorre todo el catálogo
                  </h3>
                  <ul className="mt-2 text-sm text-amber-800 list-disc pl-5 space-y-1">
                    <li>
                      Una llamada a Bedrock <strong className="font-semibold">más</strong> una
                      escritura en DynamoDB <strong className="font-semibold">por producto</strong>, en
                      serie. Se cobra por token embebido.
                    </li>
                    <li>
                      Puede tardar hasta {HANDLER_TIMEOUT_SECONDS} segundos: ese es el timeout del
                      handler, no una estimación.
                    </li>
                    <li>
                      Reindexa <strong className="font-semibold">todos</strong> los productos, no sólo
                      los nuevos: volvés a pagar los que ya tenían vector.
                    </li>
                  </ul>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  type="button"
                  ref={confirmRef}
                  onClick={handleConfirm}
                  className="px-4 py-2 rounded-lg font-medium bg-red-600 text-white hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                >
                  Sí, reindexar
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-4 py-2 rounded-lg font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {isRunning && (
            <div className="mt-4 flex items-center gap-3 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3">
              <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" aria-hidden="true" />
              {/* La región viva NO incluye el contador: si lo incluyera, el lector
                  de pantalla repetiría el mensaje una vez por segundo. */}
              <div role="status" aria-live="polite" className="text-sm text-blue-800">
                Indexando el catálogo…
                <span className="sr-only">
                  {' '}
                  Se está generando un embedding por producto, en serie. Puede tardar hasta{' '}
                  {HANDLER_TIMEOUT_SECONDS} segundos. No cerrés la pestaña.
                </span>
              </div>
              <span
                aria-hidden="true"
                className="ml-auto text-sm font-medium text-blue-700 tabular-nums whitespace-nowrap"
              >
                {elapsed}s / {HANDLER_TIMEOUT_SECONDS}s
              </span>
            </div>
          )}

          {status === 'done' && result !== null && outcome === 'success' && (
            <div
              role="status"
              aria-live="polite"
              className="mt-4 rounded-lg bg-green-50 border border-green-200 px-4 py-3"
            >
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-700 mt-0.5 shrink-0" aria-hidden="true" />
                <div className="text-sm text-green-800">
                  <p className="font-semibold">
                    Catálogo indexado: {result.indexed} de {result.total} productos.
                  </p>
                  <p className="mt-1">
                    Modelo: <code className="text-xs">{result.model}</code>. Ya podés usar la búsqueda
                    semántica y el asistente de compras.
                  </p>
                  {result.skipped > 0 && (
                    // Éxito parcial: el handler no distingue "sin texto" de "falló
                    // el embedding", así que lo decimos como lo que es.
                    <p className="mt-1">
                      {result.skipped} producto(s) quedaron omitidos y no van a aparecer en la
                      búsqueda semántica hasta que se reindexen.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {status === 'done' && result !== null && outcome === 'modelAccess' && (
            // EL CASO IMPORTANTE. HTTP 200 con indexed: 0 no es un éxito.
            <div
              role="alert"
              className="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" aria-hidden="true" />
                <div className="text-sm text-amber-800">
                  <p className="font-semibold">
                    No se indexó ningún producto: 0 indexados y {result.skipped} omitidos de{' '}
                    {result.total}.
                  </p>
                  <p className="mt-1">
                    El endpoint respondió HTTP 200 igual —&nbsp;no tiene camino de error&nbsp;— así que
                    estos números son la única señal. Con 0 indexados el catálogo sigue{' '}
                    <strong className="font-semibold">sin vectores</strong>: la búsqueda semántica y el
                    asistente van a seguir devolviendo vacío.
                  </p>
                  <p className="mt-2 font-semibold">
                    Causa más probable: el acceso al modelo de Bedrock no está habilitado.
                  </p>
                  <ol className="mt-1 list-decimal pl-5 space-y-1">
                    <li>
                      Abrí la consola de AWS → Amazon Bedrock → <em>Model access</em>, en la región{' '}
                      <strong className="font-semibold">us-east-1</strong> (es un setting por región).
                    </li>
                    <li>
                      Habilitá <strong className="font-semibold">Amazon Titan Embeddings v2</strong>{' '}
                      (<code className="text-xs">amazon.titan-embed-text-v2:0</code>).
                    </li>
                    <li>Volvé a correr el indexador desde acá.</li>
                  </ol>
                  <p className="mt-2">
                    Si el acceso ya estaba habilitado, mirá los logs de la Lambda del indexador: un
                    <code className="text-xs"> AccessDeniedException</code> apunta al modelo, y un
                    error de DynamoDB, a la escritura.
                  </p>
                </div>
              </div>
            </div>
          )}

          {status === 'done' && result !== null && outcome === 'empty' && (
            <div
              role="status"
              aria-live="polite"
              className="mt-4 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3"
            >
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-gray-500 mt-0.5 shrink-0" aria-hidden="true" />
                <p className="text-sm text-gray-700">
                  El indexador no encontró productos para indexar (0 de {result.total}). Sembrá el
                  catálogo y volvé a intentar.
                </p>
              </div>
            </div>
          )}

          {status === 'error' && failure !== null && (
            <div
              role="alert"
              className="mt-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-700 mt-0.5 shrink-0" aria-hidden="true" />
                <div className="text-sm text-red-700">
                  <p className="font-semibold">
                    {failure.notConfigured
                      ? 'El indexador no está configurado en este entorno.'
                      : `Falló el indexado${failure.status ? ` (HTTP ${failure.status})` : ''}.`}
                  </p>
                  <p className="mt-1">{failure.message}</p>
                  {failure.detail && <p className="mt-1">{failure.detail}</p>}
                  {/* El `hint` del handler suele ser la instrucción exacta que falta:
                      mostralo tal cual en vez de resumirlo. */}
                  {failure.hint && <p className="mt-1 font-medium">Pista del backend: {failure.hint}</p>}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
