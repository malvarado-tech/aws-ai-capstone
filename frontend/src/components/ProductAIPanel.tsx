/**
 * ProductAIPanel — panel de enriquecimiento de IA POR PRODUCTO.
 *
 * QUÉ SUPERFICIE EXPONE
 * ---------------------
 *  - S01 · Amazon Rekognition `DetectLabels`            → aiLabels / aiLabelsRaw   (AIF-C01 D1)
 *  - S02 · Amazon Rekognition `DetectModerationLabels`  → moderationStatus /
 *                                                         moderationFlags / altText (D1 · D4)
 *  - S06 · Amazon Bedrock (Converse, Claude Haiku)      → aiDescription /
 *                                                         aiDescriptionModel        (D2 · D3)
 *
 * POR QUÉ ESTOS TRES Y NO OTROS: son los enriquecimientos que operan sobre UN item de
 * DynamoDB. S03 (Comprehend), S04 (Translate), S05 (Polly) y S07/S08 (Bedrock + RAG) son
 * de catálogo o de conversación y viven en otras pantallas.
 *
 * CUATRO COMPORTAMIENTOS DEL BACKEND QUE ESTE COMPONENTE DEFIENDE
 * --------------------------------------------------------------
 * 1. **Un bloqueo de guardrail devuelve HTTP 200.** El texto de rechazo llega en
 *    `description` y la ÚNICA señal es `guardrailBlocked: true` / `stopReason:
 *    'guardrail_intervened'`. Si lo pintáramos como una descripción cualquiera, el
 *    estudiante vería el mensaje del guardrail creyendo que el modelo escribió eso.
 *    Acá se renderiza como BLOQUEO (rojo, role="alert"), nunca como descripción.
 * 2. **Los dos 422 de visión traen textos DISTINTOS.** S01 dice "…imageUrl válida. Subí
 *    una imagen real primero." y S02 sólo "…imageUrl válida.". Por eso ramificamos por
 *    `status === 422`, nunca por substring del mensaje. Además detectamos el placeholder
 *    `REEMPLAZAR…` del seed en el cliente y deshabilitamos el botón ANTES de gastar la
 *    llamada (misma condición que el handler: vacío o `startsWith("REEMPLAZAR")`).
 * 3. **Semántica del flag `save` (S06).** S01 y S02 escriben en DynamoDB SIEMPRE (no
 *    tienen flag); S06 sólo si `save: true`, y el handler calcula `saved = save and not
 *    blocked`: con el guardrail interviniendo NO guarda aunque el checkbox esté prendido.
 *    Por eso el aviso de "guardado" mira `result.saved`, no el checkbox, y `onEnriched`
 *    (el refetch del padre) sólo se dispara cuando hubo escritura real.
 * 4. **`tone` vacío se OMITE del body.** Un `tone: null` explícito rompe el converse con
 *    ValidationException → 502. `ai.ts` ya omite un tone falsy; acá tampoco lo mandamos.
 *
 * Todo el fetch vive en `../lib/ai`: este componente no arma una sola URL ni un header.
 */

import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ImageOff,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tags,
  X,
} from 'lucide-react';
import {
  AiError,
  AiNotConfiguredError,
  aiCapabilities,
  enrichLabels,
  generateDescription,
  moderateImage,
} from '../lib/ai';
import type { DescribeResult, LabelsResult, ModerationResult } from '../lib/ai';
import type { Product } from '../lib/types';

interface ProductAIPanelProps {
  product: Product;
  isOpen: boolean;
  onClose: () => void;
  /** El padre refetchea el producto: sólo se llama cuando hubo escritura en DynamoDB. */
  onEnriched?: (productId: string) => void;
  /**
   * Capacidades por producto que viven en otros componentes (S05 audio, S03
   * sentimiento) y se montan dentro de este mismo modal. Van acá y no en un
   * segundo modal a propósito: dos overlays apilados por producto es peor UX y
   * obliga al usuario a adivinar en cuál está cada cosa.
   */
  children?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Normalización de errores
// ---------------------------------------------------------------------------

interface PanelError {
  message: string;
  detail?: string;
  hint?: string;
  /** 422 = falta la imagen real. Es una instrucción para el usuario, no una falla. */
  actionable: boolean;
  /** Falta la Function URL de esa capacidad en window.__ENV. */
  notConfigured: boolean;
}

/**
 * Ramifica por `status`, NUNCA por el texto del mensaje: los 422 de S01 y S02 no
 * coinciden entre sí, así que cualquier substring match se rompería en uno de los dos.
 */
function toPanelError(err: unknown): PanelError {
  if (err instanceof AiNotConfiguredError) {
    return { message: err.message, actionable: false, notConfigured: true };
  }
  if (err instanceof AiError) {
    return {
      message: err.message,
      detail: err.detail,
      hint: err.hint,
      actionable: err.status === 422,
      notConfigured: false,
    };
  }
  return {
    message: err instanceof Error ? err.message : 'Error inesperado llamando al servicio de IA.',
    actionable: false,
    notConfigured: false,
  };
}

// ---------------------------------------------------------------------------
// Piezas compartidas (no exportadas: son detalle interno del panel)
// ---------------------------------------------------------------------------

/** Spinner con anuncio para lectores de pantalla (el ícono solo no dice nada). */
function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 text-sm text-gray-600"
    >
      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Un 422 o una capacidad apagada se pintan en ámbar con instrucciones; el resto en rojo.
 * Siempre role="alert" para que el lector de pantalla lo anuncie al aparecer.
 */
function ErrorBox({ error, guidance }: { error: PanelError; guidance?: string }) {
  const soft = error.actionable || error.notConfigured;
  return (
    <div
      role="alert"
      className={`rounded-lg border p-3 text-sm ${
        soft ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-red-50 border-red-200 text-red-700'
      }`}
    >
      <p className="flex items-start gap-2 font-medium">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>{error.message}</span>
      </p>
      {guidance && soft && <p className="mt-1">{guidance}</p>}
      {error.hint && <p className="mt-1 font-medium">Pista del backend: {error.hint}</p>}
      {error.detail && <p className="mt-1 text-xs opacity-80">{error.detail}</p>}
    </div>
  );
}

/** Nota muted: costo, latencia o efecto en DynamoDB. Material didáctico, no adorno. */
function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-500">{children}</p>;
}

// Texto que se repite en las dos secciones de visión: mismo diagnóstico, distinto handler.
const PLACEHOLDER_GUIDANCE =
  'El producto todavía tiene el imageUrl del seed (REEMPLAZAR…). Subí una imagen real a S3, ' +
  'actualizá el producto con su URL y volvé a intentar: los endpoints de visión responden 422 ' +
  'hasta entonces.';

export function ProductAIPanel({
  product,
  isOpen,
  onClose,
  onEnriched,
  children,
}: ProductAIPanelProps) {
  const uid = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Un estado por sección: si Bedrock falla, las etiquetas de Rekognition
  // que ya se mostraron no se borran.
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [labelsError, setLabelsError] = useState<PanelError | null>(null);
  const [labelsResult, setLabelsResult] = useState<LabelsResult | null>(null);

  const [moderationLoading, setModerationLoading] = useState(false);
  const [moderationError, setModerationError] = useState<PanelError | null>(null);
  const [moderationResult, setModerationResult] = useState<ModerationResult | null>(null);

  const [describeLoading, setDescribeLoading] = useState(false);
  const [describeError, setDescribeError] = useState<PanelError | null>(null);
  const [describeResult, setDescribeResult] = useState<DescribeResult | null>(null);

  const [tone, setTone] = useState('');
  const [save, setSave] = useState(false); // OFF por default: una vista previa no persiste nada.

  // Al reabrir o al cambiar de producto se descartan los resultados en memoria:
  // mostrar el resultado del producto anterior sería peor que no mostrar nada.
  useEffect(() => {
    setLabelsError(null);
    setLabelsResult(null);
    setModerationError(null);
    setModerationResult(null);
    setDescribeError(null);
    setDescribeResult(null);
    setTone('');
    setSave(false);
  }, [isOpen, product.productId]);

  // Escape cierra el panel (ProductModal todavía no lo hace; acá sí).
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  // Foco en el panel al abrir: sin esto el lector de pantalla sigue en la tarjeta de atrás.
  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);

  // Capacidades: se resuelven en cada render desde window.__ENV. Si falta la URL de una
  // sesión, esa sección queda deshabilitada con la explicación, en vez de tirar al click.
  const caps = aiCapabilities();

  // Misma condición que los handlers de S01/S02, para no gastar la llamada.
  const imageUrl = product.imageUrl ?? '';
  const hasPlaceholderImage = imageUrl === '' || imageUrl.startsWith('REEMPLAZAR');

  // El resultado fresco gana sobre el campo persistido: el padre refetchea después de
  // onEnriched, pero hasta que llegue la respuesta el producto en props está viejo.
  const labels: { name: string; confidence: number | null }[] =
    labelsResult?.labels.map((label) => ({ name: label.name, confidence: label.confidence })) ??
    product.aiLabelsRaw?.map((label) => ({ name: label.name, confidence: label.confidence })) ??
    product.aiLabels?.map((name) => ({ name, confidence: null })) ??
    [];

  const moderationStatus = moderationResult?.moderationStatus ?? product.moderationStatus;
  const moderationFlags = moderationResult?.moderationFlags ?? product.moderationFlags ?? [];
  const altText = moderationResult?.altText ?? product.altText;

  const guardrailBlocked = describeResult?.guardrailBlocked === true;
  const truncated = describeResult?.stopReason === 'max_tokens';

  const handleLabels = async () => {
    setLabelsLoading(true);
    setLabelsError(null);
    try {
      const result = await enrichLabels(product.productId);
      setLabelsResult(result);
      // S01 no tiene flag de guardado: si respondió 200, ya escribió en DynamoDB.
      onEnriched?.(product.productId);
    } catch (err) {
      setLabelsError(toPanelError(err));
    } finally {
      setLabelsLoading(false);
    }
  };

  const handleModeration = async () => {
    setModerationLoading(true);
    setModerationError(null);
    try {
      const result = await moderateImage(product.productId);
      setModerationResult(result);
      // También escribe siempre (moderationStatus + moderationFlags + altText).
      onEnriched?.(product.productId);
    } catch (err) {
      setModerationError(toPanelError(err));
    } finally {
      setModerationLoading(false);
    }
  };

  const handleDescribe = async () => {
    setDescribeLoading(true);
    setDescribeError(null);
    try {
      // `tone` sólo viaja si tiene contenido: ni string vacío ni null (null → 502).
      const trimmedTone = tone.trim();
      const opts: { tone?: string; save?: boolean } = { save };
      if (trimmedTone) opts.tone = trimmedTone;

      const result = await generateDescription(product.productId, opts);
      setDescribeResult(result);
      // `saved` lo decide el handler (save && !blocked): sólo refetcheamos si escribió.
      if (result.saved) onEnriched?.(product.productId);
    } catch (err) {
      setDescribeError(toPanelError(err));
    } finally {
      setDescribeLoading(false);
    }
  };

  if (!isOpen) return null;

  const titleId = `${uid}-title`;
  const toneId = `${uid}-tone`;
  const saveId = `${uid}-save`;
  const labelsNoteId = `${uid}-labels-note`;
  const moderationNoteId = `${uid}-moderation-note`;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b">
          <h2 id={titleId} className="text-2xl font-bold text-gray-900">
            Enriquecimiento con IA
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar panel de IA"
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <p className="text-sm text-gray-600">
            Producto: <span className="font-medium text-gray-900">{product.name}</span>
          </p>

          {/* --------------------------------------------------------------- */}
          {/* S01 · Rekognition DetectLabels                                   */}
          {/* --------------------------------------------------------------- */}
          <section className="rounded-lg shadow-md border border-gray-200 p-4 space-y-3">
            <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
              <Tags className="w-5 h-5 text-blue-600" aria-hidden="true" />
              Etiquetas automáticas (Rekognition)
            </h3>
            <Note>
              S01 · <code>DetectLabels</code> escribe <code>aiLabels</code> y{' '}
              <code>aiLabelsRaw</code> en DynamoDB en cuanto responde: no hay vista previa.
            </Note>

            {labels.length > 0 ? (
              <ul className="flex flex-wrap gap-2 list-none p-0 m-0">
                {labels.map((label) => (
                  <li key={label.name}>
                    <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
                      {label.confidence === null
                        ? label.name
                        : `${label.name} ${Math.round(label.confidence)}%`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">Todavía no hay etiquetas detectadas.</p>
            )}

            {hasPlaceholderImage && (
              <p id={labelsNoteId} className="flex items-start gap-2 text-sm text-amber-800">
                <ImageOff className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                <span>{PLACEHOLDER_GUIDANCE}</span>
              </p>
            )}

            {!caps.labels && (
              <p className="text-sm text-amber-800">
                Capacidad no configurada: falta la Function URL de S01 en <code>window.__ENV</code>.
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleLabels}
                disabled={labelsLoading || hasPlaceholderImage || !caps.labels}
                aria-describedby={hasPlaceholderImage ? labelsNoteId : undefined}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                  labelsLoading || hasPlaceholderImage || !caps.labels
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {labelsLoading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                Detectar etiquetas
              </button>
              {labelsLoading && <Spinner label="Detectando etiquetas con Rekognition…" />}
            </div>

            {labelsError && <ErrorBox error={labelsError} guidance={PLACEHOLDER_GUIDANCE} />}
          </section>

          {/* --------------------------------------------------------------- */}
          {/* S02 · Rekognition moderación + alt-text                          */}
          {/* --------------------------------------------------------------- */}
          <section className="rounded-lg shadow-md border border-gray-200 p-4 space-y-3">
            <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
              <ShieldCheck className="w-5 h-5 text-blue-600" aria-hidden="true" />
              Moderación y texto alternativo
            </h3>
            <Note>
              S02 · dos llamadas a Rekognition (moderación + etiquetas para el alt-text): tarda
              unos segundos y persiste <code>moderationStatus</code>, <code>moderationFlags</code> y{' '}
              <code>altText</code>.
            </Note>

            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">Estado de moderación:</span>
              {moderationStatus === 'APPROVED' && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-green-50 text-green-700 rounded-full font-medium">
                  <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                  APPROVED
                </span>
              )}
              {moderationStatus === 'FLAGGED' && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-red-50 text-red-700 rounded-full font-medium">
                  <ShieldAlert className="w-3 h-3" aria-hidden="true" />
                  FLAGGED
                </span>
              )}
              {!moderationStatus && (
                <span className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded-full font-medium">
                  Sin moderar
                </span>
              )}
            </div>

            {moderationFlags.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm font-medium text-red-700">Categorías marcadas:</p>
                <ul className="mt-1 space-y-1 text-sm text-red-700">
                  {moderationFlags.map((flag) => (
                    <li key={`${flag.parent}-${flag.name}`}>
                      {flag.name} {Math.round(flag.confidence)}%
                      {flag.parent ? ` · categoría padre: ${flag.parent}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <p className="text-sm font-medium text-gray-700">Texto alternativo (alt):</p>
              {altText ? (
                <p className="text-sm text-gray-900">{altText}</p>
              ) : (
                <p className="text-sm text-gray-500">Todavía no hay texto alternativo generado.</p>
              )}
              <Note>
                Es el texto que leen los lectores de pantalla cuando la imagen no puede verse:
                accesibilidad e IA responsable (dominio 4 del examen), generado a partir de las
                etiquetas en vez de escribirse a mano.
              </Note>
            </div>

            {hasPlaceholderImage && (
              <p id={moderationNoteId} className="flex items-start gap-2 text-sm text-amber-800">
                <ImageOff className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                <span>{PLACEHOLDER_GUIDANCE}</span>
              </p>
            )}

            {!caps.moderation && (
              <p className="text-sm text-amber-800">
                Capacidad no configurada: falta la Function URL de S02 en <code>window.__ENV</code>.
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleModeration}
                disabled={moderationLoading || hasPlaceholderImage || !caps.moderation}
                aria-describedby={hasPlaceholderImage ? moderationNoteId : undefined}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                  moderationLoading || hasPlaceholderImage || !caps.moderation
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {moderationLoading && (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                )}
                Moderar imagen
              </button>
              {moderationLoading && <Spinner label="Moderando la imagen con Rekognition…" />}
            </div>

            {moderationError && <ErrorBox error={moderationError} guidance={PLACEHOLDER_GUIDANCE} />}
          </section>

          {/* --------------------------------------------------------------- */}
          {/* S06 · Bedrock Converse                                           */}
          {/* --------------------------------------------------------------- */}
          <section className="rounded-lg shadow-md border border-gray-200 p-4 space-y-3">
            <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
              <Sparkles className="w-5 h-5 text-blue-600" aria-hidden="true" />
              Descripción generada (Bedrock)
            </h3>
            <Note>
              S06 · Converse API con Claude Haiku. Tarda segundos y sólo escribe{' '}
              <code>aiDescription</code> si marcás "Guardar".
            </Note>

            {/* Lo persistido se muestra sólo si no hay un resultado fresco que mostrar,
                para no duplicar el mismo texto en pantalla. */}
            {!describeResult && (
              <div>
                {product.aiDescription ? (
                  <>
                    <p className="text-sm text-gray-900">{product.aiDescription}</p>
                    {product.aiDescriptionModel && (
                      <Note>Modelo guardado: {product.aiDescriptionModel}</Note>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-500">Todavía no hay descripción generada.</p>
                )}
              </div>
            )}

            <div>
              <label htmlFor={toneId} className="block text-sm font-medium text-gray-700 mb-1">
                Tono
              </label>
              <input
                type="text"
                id={toneId}
                value={tone}
                onChange={(event) => setTone(event.target.value)}
                placeholder="elegante y cercano"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <Note>
                Si lo dejás vacío no se manda el campo y el handler usa su tono por defecto. Nunca
                mandamos un tono vacío ni nulo: un <code>null</code> explícito rompe la llamada al
                modelo con un 502.
              </Note>
            </div>

            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                id={saveId}
                checked={save}
                onChange={(event) => setSave(event.target.checked)}
                className="mt-1 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <label htmlFor={saveId} className="text-sm font-medium text-gray-700">
                Guardar en DynamoDB
                <span className="block text-xs font-normal text-gray-500">
                  Apagado genera una vista previa que no persiste nada. Prendido escribe{' '}
                  <code>aiDescription</code> y <code>aiDescriptionModel</code> en el producto.
                </span>
              </label>
            </div>

            {!caps.describe && (
              <p className="text-sm text-amber-800">
                Capacidad no configurada: falta la Function URL de S06 en <code>window.__ENV</code>.
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleDescribe}
                disabled={describeLoading || !caps.describe}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                  describeLoading || !caps.describe
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {describeLoading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                Generar descripción
              </button>
              {describeLoading && <Spinner label="Generando la descripción con Bedrock…" />}
            </div>

            {/* Un bloqueo de guardrail llega como 200: se pinta como bloqueo, jamás como
                descripción. Sin este branch el texto de rechazo pasaría por texto del modelo. */}
            {describeResult && guardrailBlocked && (
              <div
                role="alert"
                className="rounded-lg border bg-red-50 border-red-200 text-red-700 p-3 text-sm"
              >
                <p className="flex items-start gap-2 font-medium">
                  <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    Bloqueado: el guardrail de Bedrock intervino ({describeResult.stopReason}).
                  </span>
                </p>
                <p className="mt-1">
                  Lo de abajo es el mensaje de rechazo del guardrail, no una descripción del
                  producto. No se guardó nada en DynamoDB, ni siquiera con "Guardar" prendido.
                </p>
                <p className="mt-1 italic">{describeResult.description}</p>
              </div>
            )}

            {describeResult && !guardrailBlocked && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-1">
                <p className="text-sm text-gray-900">{describeResult.description}</p>
                {truncated && (
                  <p role="alert" className="text-sm text-amber-800 font-medium">
                    Respuesta incompleta: se cortó al llegar al límite de tokens de salida
                    (stopReason <code>max_tokens</code>), así que la última frase queda a medias.
                  </p>
                )}
                <Note>Modelo: {describeResult.model}</Note>
                <Note>Tono usado: {describeResult.tone}</Note>
                <Note>
                  Tokens · entrada: {describeResult.usage.inputTokens ?? 0} · salida:{' '}
                  {describeResult.usage.outputTokens ?? 0} · total:{' '}
                  {describeResult.usage.totalTokens ?? 0}
                </Note>
                <Note>
                  {describeResult.saved
                    ? 'Guardado en DynamoDB (aiDescription).'
                    : 'Vista previa: no se guardó nada en DynamoDB.'}
                </Note>
              </div>
            )}

            {describeError && <ErrorBox error={describeError} />}
          </section>

          {/* S05 (audio) y S03 (sentimiento): mismos datos del producto, mismo modal. */}
          {children}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
