import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  aiCapabilities,
  AiError,
  AiNotConfiguredError,
  analyzeSentiment,
  askAssistant,
  ASSISTANT_HISTORY_LIMIT,
  enrichLabels,
  generateDescription,
  indexEmbeddings,
  moderateImage,
  searchProducts,
  stripEmbedding,
  synthesizeVoice,
  translateProduct,
} from './ai';
import { mockProduct, mockProductEnriched } from '../test/mockData';

/**
 * Tests del cliente de IA.
 *
 * Igual que api.test.ts, se stubea `globalThis.fetch` en vez de mockear el
 * módulo: acá lo que se prueba es justamente el cliente.
 *
 * OJO: setup.ts sólo define VITE_API_URL, así que por defecto TODAS las
 * capacidades de IA están apagadas. Cada test que espera una llamada real tiene
 * que poblar window.__ENV primero — eso también prueba el camino
 * "no configurado", que es el que ve un stack a medio desplegar.
 */

const ALL_AI_URLS = {
  VITE_ENRICH_LABELS_URL: 'https://labels.lambda-url.us-east-1.on.aws/',
  VITE_MODERATE_IMAGE_URL: 'https://moderate.lambda-url.us-east-1.on.aws/',
  VITE_ANALYZE_SENTIMENT_URL: 'https://sentiment.lambda-url.us-east-1.on.aws/',
  VITE_TRANSLATE_CATALOG_URL: 'https://translate.lambda-url.us-east-1.on.aws/',
  VITE_SYNTHESIZE_VOICE_URL: 'https://voice.lambda-url.us-east-1.on.aws/',
  VITE_GENERATE_DESCRIPTION_URL: 'https://describe.lambda-url.us-east-1.on.aws/',
  VITE_INDEX_EMBEDDINGS_URL: 'https://index.lambda-url.us-east-1.on.aws/',
  VITE_SEMANTIC_SEARCH_URL: 'https://search.lambda-url.us-east-1.on.aws/',
  VITE_SHOPPING_ASSISTANT_URL: 'https://assistant.lambda-url.us-east-1.on.aws/',
};

const BASE_ENV = { ...window.__ENV };

function configureAll() {
  window.__ENV = { ...BASE_ENV, ...ALL_AI_URLS };
}

function okFetch(payload: unknown) {
  const mockFetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => payload,
  });
  globalThis.fetch = mockFetch;
  return mockFetch;
}

describe('AI client module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__ENV = { ...BASE_ENV };
  });

  afterEach(() => {
    window.__ENV = { ...BASE_ENV };
  });

  describe('URL resolution and capabilities', () => {
    it('should report every capability as unavailable when no URL is configured', () => {
      expect(aiCapabilities()).toEqual({
        labels: false,
        moderation: false,
        sentiment: false,
        translate: false,
        voice: false,
        describe: false,
        index: false,
        search: false,
        assistant: false,
      });
    });

    it('should report capabilities as available once URLs are injected', () => {
      configureAll();

      const caps = aiCapabilities();

      expect(caps.labels).toBe(true);
      expect(caps.assistant).toBe(true);
      expect(Object.values(caps).every(Boolean)).toBe(true);
    });

    it('should throw AiNotConfiguredError instead of calling fetch when a URL is missing', async () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      await expect(enrichLabels('p1')).rejects.toBeInstanceOf(AiNotConfiguredError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // El inyector reemplaza los marcadores sin valor por cadena vacía, pero si
    // alguien sirviera el template crudo llegaría '%%VITE_...%%'. Tratarlo como
    // URL haría un fetch a una ruta relativa sin sentido.
    it('should treat an unsubstituted %% token as not configured', async () => {
      window.__ENV = { ...BASE_ENV, VITE_SEMANTIC_SEARCH_URL: '%%VITE_SEMANTIC_SEARCH_URL%%' };
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      await expect(searchProducts('vestido')).rejects.toBeInstanceOf(AiNotConfiguredError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should strip trailing slashes so paths do not double up', async () => {
      configureAll();
      const mockFetch = okFetch({ query: 'x', results: [] });

      await searchProducts('x');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://search.lambda-url.us-east-1.on.aws/search?q=x',
        expect.anything()
      );
    });
  });

  describe('request mechanics', () => {
    // Los handlers Python no decodifican isBase64Encoded. Sin este header la
    // Function URL manda el body en base64 y el handler responde 400.
    it('should send Content-Type application/json on POST', async () => {
      configureAll();
      const mockFetch = okFetch({ productId: 'p1', labels: [] });

      await enrichLabels('p1');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/products/p1/labels'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should not attach a body or content-type on GET', async () => {
      configureAll();
      const mockFetch = okFetch({ query: 'x', results: [] });

      await searchProducts('x');

      const init = mockFetch.mock.calls[0][1];
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.headers).toBeUndefined();
    });

    it('should url-encode the search query', async () => {
      configureAll();
      const mockFetch = okFetch({ query: 'algo abrigado', results: [] });

      await searchProducts('algo abrigado para el invierno');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('q=algo%20abrigado%20para%20el%20invierno'),
        expect.anything()
      );
    });
  });

  describe('error handling', () => {
    it('should preserve error, detail and hint from the handler payload', async () => {
      configureAll();
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => ({
          error: 'Fallo al invocar el modelo',
          detail: 'AccessDeniedException',
          hint: '¿Habilitaste acceso al modelo en Bedrock > Model access (us-east-1)?',
        }),
      });

      await expect(generateDescription('p1')).rejects.toMatchObject({
        status: 502,
        message: 'Fallo al invocar el modelo',
        detail: 'AccessDeniedException',
        hint: expect.stringContaining('Model access'),
      });
    });

    it('should surface a 422 with the handler message', async () => {
      configureAll();
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({
          error: 'El producto no tiene una imageUrl válida. Subí una imagen real primero.',
        }),
      });

      const error = await enrichLabels('p1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).status).toBe(422);
      expect((error as AiError).message).toMatch(/imageUrl válida/i);
    });

    // Un 502 de la plataforma (excepción no atrapada en el handler) puede no
    // traer JSON parseable: no debe perderse el status real.
    it('should fall back to a status message when the error body is not JSON', async () => {
      configureAll();
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('not json');
        },
      });

      await expect(moderateImage('p1')).rejects.toThrow('Error 500: Internal Server Error');
    });
  });

  describe('generateDescription (S06) body shaping', () => {
    // bool("false") es true en Python: un string haría que guarde igual.
    it('should send save as a real boolean', async () => {
      configureAll();
      const mockFetch = okFetch({ productId: 'p1', description: 'x', saved: true });

      await generateDescription('p1', { save: true });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.save).toBe(true);
      expect(typeof body.save).toBe('boolean');
    });

    it('should default save to false when not requested', async () => {
      configureAll();
      const mockFetch = okFetch({ productId: 'p1', description: 'x', saved: false });

      await generateDescription('p1');

      expect(JSON.parse(mockFetch.mock.calls[0][1].body).save).toBe(false);
    });

    // tone: null explícito rompe el converse con ValidationException -> 502.
    it('should omit tone entirely when it is blank rather than send null', async () => {
      configureAll();
      const mockFetch = okFetch({ productId: 'p1', description: 'x' });

      await generateDescription('p1', { tone: '' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect('tone' in body).toBe(false);
    });

    it('should include tone when provided', async () => {
      configureAll();
      const mockFetch = okFetch({ productId: 'p1', description: 'x' });

      await generateDescription('p1', { tone: 'minimalista' });

      expect(JSON.parse(mockFetch.mock.calls[0][1].body).tone).toBe('minimalista');
    });

    it('should pass through a guardrail-blocked 200 response untouched', async () => {
      configureAll();
      okFetch({
        productId: 'p1',
        description: 'Lo siento, solo puedo ayudarte con productos.',
        stopReason: 'guardrail_intervened',
        guardrailBlocked: true,
        saved: false,
      });

      const result = await generateDescription('p1');

      // Un bloqueo NO es un error HTTP: el consumidor tiene que mirar el flag.
      expect(result.guardrailBlocked).toBe(true);
      expect(result.stopReason).toBe('guardrail_intervened');
    });
  });

  describe('askAssistant (S08) history handling', () => {
    it('should send the message and an empty history by default', async () => {
      configureAll();
      const mockFetch = okFetch({ reply: 'hola', retrieved: [] });

      await askAssistant('¿Tenés algo blanco?');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toBe('¿Tenés algo blanco?');
      expect(body.history).toEqual([]);
    });

    // El handler no tiene tope propio: sin recorte el costo por token crece sin
    // límite y un historial largo puede romper el converse.
    it('should truncate history to the last ASSISTANT_HISTORY_LIMIT turns', async () => {
      configureAll();
      const mockFetch = okFetch({ reply: 'ok', retrieved: [] });

      const longHistory = Array.from({ length: ASSISTANT_HISTORY_LIMIT + 6 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        text: `turno ${i}`,
      }));

      await askAssistant('siguiente', longHistory);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.history).toHaveLength(ASSISTANT_HISTORY_LIMIT);
      // Conserva los ÚLTIMOS turnos, no los primeros.
      expect(body.history[body.history.length - 1].text).toBe(
        `turno ${longHistory.length - 1}`
      );
    });
  });

  describe('other endpoints', () => {
    it('should post the target language for translateProduct', async () => {
      configureAll();
      const mockFetch = okFetch({ productId: 'p1', target: 'en', translation: {} });

      await translateProduct('p1', 'en');

      expect(JSON.parse(mockFetch.mock.calls[0][1].body).target).toBe('en');
    });

    it('should post the lang for synthesizeVoice', async () => {
      configureAll();
      const mockFetch = okFetch({ productId: 'p1', lang: 'es', voice: 'Lupe', audioUrl: 'x' });

      await synthesizeVoice('p1', 'es');

      expect(JSON.parse(mockFetch.mock.calls[0][1].body).lang).toBe('es');
    });

    it('should send reviews and productId for analyzeSentiment', async () => {
      configureAll();
      const mockFetch = okFetch({ count: 2, overallSentiment: 'POSITIVE' });

      await analyzeSentiment({ reviews: ['buenísimo', 'meh'], productId: 'p1' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reviews).toEqual(['buenísimo', 'meh']);
      expect(body.productId).toBe('p1');
    });

    // indexed:0 con skipped>0 es la señal de "sin acceso a los modelos": llega
    // como 200, así que el cliente no debe convertirlo en error.
    it('should return a zero-indexed result as success, not an error', async () => {
      configureAll();
      okFetch({ indexed: 0, skipped: 4, total: 4, model: 'amazon.titan-embed-text-v2:0' });

      const result = await indexEmbeddings();

      expect(result.indexed).toBe(0);
      expect(result.skipped).toBe(4);
    });

    it('should expose the hint when the search index is empty', async () => {
      configureAll();
      okFetch({
        query: 'vestido',
        results: [],
        hint: '¿Corriste POST /search/index primero?',
      });

      const result = await searchProducts('vestido');

      expect(result.results).toEqual([]);
      expect(result.hint).toMatch(/search\/index/);
    });
  });

  describe('stripEmbedding', () => {
    it('should remove the embedding field', () => {
      const stripped = stripEmbedding(mockProductEnriched);

      expect(stripped.embedding).toBeUndefined();
      expect('embedding' in stripped).toBe(false);
    });

    it('should keep every other field including the embedding metadata', () => {
      const stripped = stripEmbedding(mockProductEnriched);

      expect(stripped.productId).toBe(mockProductEnriched.productId);
      expect(stripped.aiLabels).toEqual(mockProductEnriched.aiLabels);
      expect(stripped.embeddingDim).toBe(mockProductEnriched.embeddingDim);
      expect(stripped.embeddingModel).toBe(mockProductEnriched.embeddingModel);
    });

    it('should not mutate the original product', () => {
      stripEmbedding(mockProductEnriched);

      expect(mockProductEnriched.embedding).toBeDefined();
    });

    it('should return the same object when there is no embedding', () => {
      const result = stripEmbedding(mockProduct);

      expect(result).toBe(mockProduct);
    });
  });
});
