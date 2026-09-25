/**
 * S05 · Amazon Polly — escuchar la descripción del producto.
 *
 * Dominio AIF-C01: D1 (capacidad de un servicio de IA administrado) + D4
 * (IA responsable: accesibilidad — el mismo catálogo servido por audio).
 *
 * QUÉ COMPORTAMIENTO DEL BACKEND DEFIENDE ESTE COMPONENTE
 * ------------------------------------------------------
 * 1. LA URL ES EFÍMERA Y NO SE PERSISTE. El handler sube el MP3 a un bucket
 *    PRIVADO y devuelve una URL prefirmada de `expiresIn` segundos (3600). En
 *    DynamoDB queda sólo `audioKey`. Consecuencia de diseño: NO se puede armar
 *    un <audio src> a partir del estado guardado del producto. Recién después de
 *    llamar al endpoint existe una URL, así que el <audio> no se renderiza hasta
 *    que hay respuesta. `audioKey` indica "ya se generó alguna vez", nunca
 *    "se puede reproducir" — y encima el bucket tiene una regla de ciclo de vida
 *    de 7 días, así que la clave guardada puede apuntar a un objeto borrado.
 * 2. CADA CLICK CUESTA. Polly factura por carácter sintetizado: es un botón, no
 *    un efecto de montaje. Cacheamos la URL por idioma para que el segundo play
 *    de la misma sesión no vuelva a facturar, pero la tratamos como perecedera:
 *    si ya pasó (expiresIn - margen), pedimos de nuevo antes que reproducir un
 *    link muerto.
 * 3. EL HANDLER NO VALIDA `lang`. `VOICES.get(lang, VOICES["es"])`: cualquier
 *    valor que no sea "en" cae en la voz española SIN error. Por eso la UI sólo
 *    ofrece 'es' | 'en', igual que el tipo del cliente.
 * 4. `lang: 'en'` NO traduce. Lee `translations.en` si S04 ya corrió; si no
 *    existe, hace que una voz inglesa (Joanna) lea el texto español. Lo decimos
 *    en la UI y mostramos qué voz usó realmente la respuesta.
 * 5. SINTETIZAR TAMBIÉN ESCRIBE EN DYNAMODB (`SET audioKey`). No es una
 *    operación de sólo lectura aunque parezca un "play".
 */
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Volume2 } from 'lucide-react';
import { AiError, AiNotConfiguredError, aiCapabilities, synthesizeVoice } from '../lib/ai';
import type { Product } from '../lib/types';

interface ProductAudioProps {
  product: Product;
  className?: string;
}

/** Una URL prefirmada ya pedida en esta sesión del componente. */
interface AudioPedido {
  url: string;
  voice: 'Lupe' | 'Joanna';
  lang: 'es' | 'en';
  /** Segundos de vida que declaró la respuesta (hoy 3600). */
  expiresIn: number;
  /** `Date.now()` del momento en que llegó la respuesta. */
  pedidoEn: number;
}

interface ErrorDeVoz {
  mensaje: string;
  detalle?: string;
  hint?: string;
}

/**
 * Pedimos de nuevo un minuto antes de que la URL expire de verdad: entre el
 * click y el primer byte hay red, y un 403 de S3 por firma vencida se ve como un
 * reproductor mudo, sin mensaje de error.
 */
const MARGEN_EXPIRACION_S = 60;

const ETIQUETA_IDIOMA: Record<'es' | 'en', string> = {
  es: 'Español',
  en: 'Inglés',
};

/**
 * Si `expiresIn` fuera menor que el margen, esto da siempre `false` y cada play
 * pide audio nuevo. Es el lado seguro del trade-off: una llamada extra a Polly
 * cuesta centavos, un <audio> que no suena parece un bug del sitio.
 */
function estaVigente(audio: AudioPedido): boolean {
  const transcurrido = (Date.now() - audio.pedidoEn) / 1000;
  return transcurrido < audio.expiresIn - MARGEN_EXPIRACION_S;
}

/**
 * Traduce el error del cliente de IA a algo accionable. `AiNotConfiguredError`
 * se chequea PRIMERO porque extiende `AiError`: al revés nunca entraría.
 */
function describirError(err: unknown): ErrorDeVoz {
  if (err instanceof AiNotConfiguredError) {
    return {
      mensaje: 'La síntesis de voz no está configurada en este entorno.',
      hint: 'Falta la Function URL de S05 (VITE_SYNTHESIZE_VOICE_URL) en env-config.js.',
    };
  }
  if (err instanceof AiError) {
    return {
      mensaje: err.status ? `${err.message} (HTTP ${err.status})` : err.message,
      detalle: err.detail,
      hint: err.hint,
    };
  }
  return { mensaje: 'No pudimos generar el audio. Probá de nuevo en un momento.' };
}

export function ProductAudio({ product, className = '' }: ProductAudioProps) {
  const [lang, setLang] = useState<'es' | 'en'>('es');
  // Cache por idioma: cambiar de voz es otro texto y otra factura de Polly.
  const [cache, setCache] = useState<Partial<Record<'es' | 'en', AudioPedido>>>({});
  const [audioActual, setAudioActual] = useState<AudioPedido | null>(null);
  const [reproducirAlCargar, setReproducirAlCargar] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<ErrorDeVoz | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const vozDisponible = aiCapabilities().voice;

  // El play va acá y no en el handler: cuando el handler termina, el <audio>
  // todavía no tiene el src nuevo en el DOM. Después del commit sí.
  useEffect(() => {
    if (!reproducirAlCargar || !audioActual) {
      return;
    }
    setReproducirAlCargar(false);
    const promesa = audioRef.current?.play();
    // `play()` devuelve undefined en entornos que no implementan media (jsdom) y
    // una promesa rechazada si el navegador bloquea el autoplay. Ninguna de las
    // dos es un error del usuario: el <audio controls> queda listo igual.
    if (promesa && typeof promesa.catch === 'function') {
      promesa.catch(() => undefined);
    }
  }, [reproducirAlCargar, audioActual]);

  const cambiarIdioma = (nuevo: 'es' | 'en') => {
    setLang(nuevo);
    setError(null);
    // Mostramos lo que ya tenemos para ese idioma, o nada: nunca el audio del
    // otro idioma con la etiqueta cambiada.
    setAudioActual(cache[nuevo] ?? null);
  };

  const escuchar = async () => {
    setError(null);

    const enCache = cache[lang];
    if (enCache && estaVigente(enCache)) {
      setAudioActual(enCache);
      setReproducirAlCargar(true);
      return;
    }

    setCargando(true);
    try {
      const resultado = await synthesizeVoice(product.productId, lang);
      const pedido: AudioPedido = {
        url: resultado.audioUrl,
        voice: resultado.voice,
        lang,
        expiresIn: resultado.expiresIn,
        pedidoEn: Date.now(),
      };
      setCache((previo) => ({ ...previo, [lang]: pedido }));
      setAudioActual(pedido);
      setReproducirAlCargar(true);
    } catch (err) {
      setError(describirError(err));
    } finally {
      setCargando(false);
    }
  };

  const idSelect = `audio-lang-${product.productId}`;

  return (
    <div className={`bg-white rounded-lg shadow-md p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <Volume2 className="w-5 h-5 text-blue-600" aria-hidden="true" />
          Escuchar la descripción
        </h3>
        <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
          S05 · Polly
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={idSelect} className="block text-sm font-medium text-gray-700 mb-1">
            Idioma de la voz
          </label>
          <select
            id={idSelect}
            value={lang}
            onChange={(e) => cambiarIdioma(e.target.value === 'en' ? 'en' : 'es')}
            disabled={cargando}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            {/* Sólo estos dos: el handler no valida `lang` y cualquier otro valor
                cae en la voz española sin avisar. */}
            <option value="es">Español (Lupe)</option>
            <option value="en">Inglés (Joanna)</option>
          </select>
        </div>

        <button
          type="button"
          onClick={escuchar}
          disabled={cargando || !vozDisponible}
          title="Cada síntesis factura caracteres en Amazon Polly y actualiza audioKey en el producto."
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
            cargando || !vozDisponible
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {cargando ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <Volume2 className="w-4 h-4" aria-hidden="true" />
          )}
          {cargando ? 'Generando audio…' : 'Escuchar con Polly'}
        </button>
      </div>

      {!vozDisponible && (
        <p className="mt-3 text-xs text-gray-500">
          Esta capacidad está apagada porque falta su Function URL
          (VITE_SYNTHESIZE_VOICE_URL). Desplegá S05 y volvé a inyectar env-config.js.
        </p>
      )}

      <p className="mt-3 text-xs text-gray-500">
        Con <span className="font-medium">Inglés</span> el handler lee la traducción de S04 si
        existe; si el producto todavía no se tradujo, una voz inglesa (Joanna) termina leyendo
        el texto en español. Corré S04 antes para que tenga sentido.
      </p>

      {product.audioKey && (
        <div className="mt-3">
          <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
            Ya tiene audio generado
          </span>
          {/* Honestidad explícita: la clave guardada NO es reproducible. */}
          <p className="mt-2 text-xs text-gray-500">
            El producto guarda la clave <span className="font-mono">{product.audioKey}</span>, pero
            el bucket es privado y la URL prefirmada nunca se persiste (además se borra a los 7
            días). Para escucharlo hay que pedir una URL nueva con el botón.
          </p>
        </div>
      )}

      {cargando && (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 flex items-center gap-2 text-sm text-gray-600"
        >
          <span className="sr-only">
            Generando el audio con Amazon Polly. Suele tardar entre uno y tres segundos.
          </span>
          <span aria-hidden="true">Sintetizando con Amazon Polly…</span>
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

      {audioActual && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
              Voz: {audioActual.voice}
            </span>
            <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
              Idioma: {ETIQUETA_IDIOMA[audioActual.lang]}
            </span>
            <span className="text-xs text-gray-500">
              URL prefirmada, válida {Math.round(audioActual.expiresIn / 60)} min desde que se
              generó.
            </span>
          </div>
          {/* `key` fuerza un elemento nuevo por URL: así el navegador vuelve a
              correr el algoritmo de carga en vez de quedarse con el src viejo. */}
          <audio
            key={audioActual.url}
            ref={audioRef}
            src={audioActual.url}
            controls
            preload="none"
            aria-label={`Audio de ${product.name} en ${ETIQUETA_IDIOMA[
              audioActual.lang
            ].toLowerCase()}, voz ${audioActual.voice}`}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}
