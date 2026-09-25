/**
 * S08 · Asistente de compras con RAG (Amazon Bedrock · Converse + Titan Embeddings v2).
 *
 * QUÉ SERVICIOS EXPONE, Y POR QUÉ ESOS
 * ------------------------------------
 * El handler de S08 hace RAG en dos pasos: embeddea la pregunta con **Titan
 * Embeddings v2** para recuperar los productos más parecidos del catálogo en
 * DynamoDB, y le pasa esos productos como contexto a **Claude Haiku vía la
 * Converse API** para que responda sólo con lo que hay en stock. Converse (y no
 * la API nativa del modelo) porque es agnóstica al proveedor: cambiar de modelo
 * no toca el código, sólo la variable de entorno.
 *
 * CUATRO COMPORTAMIENTOS DEL BACKEND CONTRA LOS QUE ESTE COMPONENTE SE DEFIENDE
 * ---------------------------------------------------------------------------
 * 1. UN BLOQUEO DE GUARDRAIL DEVUELVE **HTTP 200**. El texto de rechazo llega en
 *    `reply` y lo único que lo distingue de una recomendación real es
 *    `guardrailBlocked: true`. Si se renderizara igual que una respuesta normal,
 *    el usuario leería "no puedo ayudarte con eso" como si fuera consejo de
 *    compra. Por eso el mensaje bloqueado se pinta en rojo y se dice que
 *    intervino el guardrail. Esto es alcanzable en producción: el guardrail de
 *    S09 está activo.
 * 2. NO HAY STREAMING. El handler usa `converse`, no `converse_stream`, así que
 *    la respuesta llega entera de golpe tras varios segundos (timeout 60 s). Lo
 *    máximo honesto es un "escribiendo…": animar tokens de a uno sería inventar
 *    un streaming que no existe.
 * 3. EL HISTORIAL LO ADMINISTRA EL FRONTEND. El backend no persiste nada: lo que
 *    no mandemos en `history`, el modelo no lo sabe. Lo guardamos en estado y el
 *    cliente lo recorta a los últimos ASSISTANT_HISTORY_LIMIT turnos, porque
 *    Bedrock exige roles alternados empezando en `user` y un historial mal
 *    formado es un ValidationException → 502.
 * 4. `retrieved: []` NO ES "no encontré nada parecido": significa que ningún
 *    producto tenía embedding, o sea que falta correr el indexador de S07. Se
 *    avisa en pantalla en vez de mostrar una respuesta sin citas como si fuera
 *    normal.
 */

import { useState } from 'react';
import { Bot, Loader2, Send, ShieldAlert, Trash2, User } from 'lucide-react';
import { ASSISTANT_HISTORY_LIMIT, AiError, AiNotConfiguredError, askAssistant } from '../lib/ai';
import type { AssistantTurn } from '../lib/ai';

interface ShoppingAssistantProps {
  className?: string;
  /** Permite que los chips de citas lleven al producto en el catálogo. */
  onSelectProduct?: (productId: string) => void;
}

/**
 * Un turno del chat en la UI: el texto que se manda al backend más los metadatos
 * que sólo existen en la respuesta (bloqueo, citas, tokens). `AssistantTurn` es
 * apenas `{role, text}`: el historial que viaja se deriva de acá.
 */
interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  guardrailBlocked?: boolean;
  retrieved?: { productId: string; name: string }[];
  totalTokens?: number;
}

export function ShoppingAssistant({ className = '', onSelectProduct }: ShoppingAssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; detail?: string; hint?: string } | null>(
    null
  );
  const [unavailable, setUnavailable] = useState(false);

  const handleSend = async () => {
    const text = draft.trim();
    // `pending` corta el encolado de pedidos concurrentes: cada pregunta son dos
    // llamadas a Bedrock más un scan, y dos en paralelo desordenan el historial.
    if (text === '' || pending) {
      return;
    }

    // El historial va SIN el mensaje nuevo (viaja aparte en `message`) y se
    // arma antes del setState para no depender del render siguiente.
    const history: AssistantTurn[] = messages.map((message) => ({
      role: message.role,
      text: message.text,
    }));

    setMessages((previous) => [...previous, { role: 'user', text }]);
    setDraft('');
    setPending(true);
    setFailure(null);

    try {
      const result = await askAssistant(text, history);
      setMessages((previous) => [
        ...previous,
        {
          role: 'assistant',
          text: result.reply,
          // El turno bloqueado igual entra al historial: saltearlo rompería la
          // alternancia user/assistant que exige Bedrock.
          guardrailBlocked: result.guardrailBlocked,
          retrieved: result.retrieved,
          totalTokens: result.usage?.totalTokens,
        },
      ]);
    } catch (err: unknown) {
      if (err instanceof AiNotConfiguredError) {
        setUnavailable(true);
      } else if (err instanceof AiError) {
        setFailure({ message: err.message, detail: err.detail, hint: err.hint });
      } else {
        setFailure({ message: 'No pudimos consultar al asistente.' });
      }
    } finally {
      setPending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envía, Shift+Enter hace salto de línea: lo que espera cualquiera que
    // haya usado un chat. Sin el preventDefault, Enter además escribiría el \n.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className={`bg-white rounded-lg shadow-md p-5 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Bot className="w-5 h-5 text-blue-600" aria-hidden="true" />
            <h3 className="text-lg font-semibold text-gray-900">Asistente de compras</h3>
          </div>
          <p className="text-sm text-gray-500">
            Responde sólo con productos del catálogo: recupera los más parecidos y se los pasa al
            modelo como contexto.
          </p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setMessages([]);
              setFailure(null);
            }}
            disabled={pending}
            className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0 ${
              pending
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
            Limpiar
          </button>
        )}
      </div>

      <div role="log" aria-live="polite" className="space-y-3 mb-4">
        {messages.length === 0 && !pending && (
          <p className="text-sm text-gray-500">
            Todavía no preguntaste nada. Probá con «¿Qué me recomendás para una entrevista de
            trabajo?».
          </p>
        )}

        {messages.map((message, index) => {
          const isUser = message.role === 'user';
          const isBlocked = message.guardrailBlocked === true;

          return (
            <div
              // El índice alcanza como key: los turnos sólo se agregan al final y
              // nunca se reordenan ni se borran de a uno.
              key={`${message.role}-${index}`}
              className={`flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}
            >
              {!isUser && (
                <span
                  className={`shrink-0 mt-1 ${isBlocked ? 'text-red-600' : 'text-blue-600'}`}
                  aria-hidden="true"
                >
                  {isBlocked ? <ShieldAlert className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                </span>
              )}
              <div
                className={`max-w-[85%] px-4 py-3 rounded-lg text-sm ${
                  isUser
                    ? 'bg-blue-600 text-white'
                    : isBlocked
                      ? 'bg-red-50 border border-red-200 text-red-700'
                      : 'bg-gray-100 text-gray-700'
                }`}
              >
                <p className="whitespace-pre-wrap">{message.text}</p>

                {isBlocked && (
                  <p className="text-xs mt-2 font-medium">
                    Un guardrail de Bedrock intervino: esto es un rechazo, no una recomendación del
                    catálogo.
                  </p>
                )}

                {/*
                  Las citas se muestran sólo en respuestas reales. En un bloqueo no
                  hubo recuperación que citar, y un aviso de "falta el índice" ahí
                  mandaría a arreglar algo que no está roto.
                */}
                {!isUser && !isBlocked && message.retrieved && (
                  <div className="mt-3">
                    {message.retrieved.length === 0 ? (
                      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                        Respondió sin citar productos: ningún item tiene embedding todavía, así que
                        hay que correr el indexador de S07 (POST /search/index).
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {message.retrieved.map((item) =>
                          onSelectProduct ? (
                            <button
                              key={item.productId}
                              type="button"
                              onClick={() => onSelectProduct(item.productId)}
                              className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium hover:bg-blue-100 transition-colors focus:ring-2 focus:ring-blue-500"
                            >
                              {item.name}
                            </button>
                          ) : (
                            // Sin handler no hay nada que clickear: un botón inerte
                            // sería ruido para un lector de pantalla.
                            <span
                              key={item.productId}
                              className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium"
                            >
                              {item.name}
                            </span>
                          )
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/*
                  Artefacto didáctico: ver los tokens de cada turno hace visible
                  que el historial se paga en cada pregunta.
                */}
                {!isUser && message.totalTokens !== undefined && (
                  <p className="text-xs text-gray-400 mt-2">{message.totalTokens} tokens</p>
                )}
              </div>
              {isUser && (
                <span className="shrink-0 mt-1 text-gray-400" aria-hidden="true">
                  <User className="w-4 h-4" />
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/*
        El indicador va FUERA del `role="log"`: dos regiones live anidadas hacen
        que un lector de pantalla anuncie lo mismo dos veces. Y es un
        "escribiendo…", no tokens animados: `converse` no streamea, la respuesta
        aparece entera de golpe.
      */}
      {pending && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 mb-4">
          <Loader2 className="w-4 h-4 text-blue-600 animate-spin" aria-hidden="true" />
          <span className="sr-only">El asistente está escribiendo la respuesta…</span>
          <span className="text-sm text-gray-500" aria-hidden="true">
            escribiendo…
          </span>
        </div>
      )}

      {failure && (
        <div
          role="alert"
          className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg"
        >
          <p className="font-medium">{failure.message}</p>
          {failure.detail && <p className="text-sm mt-1">{failure.detail}</p>}
          {failure.hint && <p className="text-sm mt-1 font-medium">{failure.hint}</p>}
        </div>
      )}

      {unavailable ? (
        <p className="text-sm text-gray-500">
          Asistente no disponible: falta configurar el endpoint de S08.
        </p>
      ) : (
        <div>
          <label htmlFor="assistant-draft" className="block text-sm font-medium text-gray-700 mb-1">
            Preguntá sobre el catálogo
          </label>
          <div className="flex items-end gap-2">
            <textarea
              id="assistant-draft"
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              placeholder="Ej: ¿Tenés algo blanco por menos de $60?"
            />
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={pending || draft.trim() === ''}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                pending || draft.trim() === ''
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              <Send className="w-4 h-4" aria-hidden="true" />
              Enviar
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Enter envía, Shift+Enter hace un salto de línea. Se recuerdan los últimos{' '}
            {ASSISTANT_HISTORY_LIMIT} turnos.
          </p>
        </div>
      )}
    </div>
  );
}
