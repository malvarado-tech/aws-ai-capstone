import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SentimentPanel } from './SentimentPanel';
import { AiError, AiNotConfiguredError, aiCapabilities, analyzeSentiment } from '../lib/ai';
import type { SentimentResult } from '../lib/ai';
import { mockProduct, mockProductEnriched } from '../test/mockData';

/**
 * Mockeamos SÓLO las funciones y dejamos las clases de error reales: el automock
 * pelado de `vi.mock('../lib/ai')` reemplaza los constructores y deja `status` /
 * `detail` / `hint` / `message` en undefined, además de romper
 * `AiNotConfiguredError instanceof AiError`. Se midió en este repo.
 */
vi.mock('../lib/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/ai')>();
  return {
    ...real,
    aiCapabilities: vi.fn(),
    analyzeSentiment: vi.fn(),
  };
});

const TODAS_LAS_CAPACIDADES = {
  labels: true,
  moderation: true,
  sentiment: true,
  translate: true,
  voice: true,
  describe: true,
  index: true,
  search: true,
  assistant: true,
};

/**
 * Payload de S03 con las DOS convenciones de mayúsculas que devuelve el handler:
 * `distribution` en MAYÚSCULA y `averageScores` / `results[].scores`
 * Capitalizados. Los valores se eligen distintos entre secciones para que un test
 * no pueda pasar leyendo la sección equivocada.
 */
function respuestaSentimiento(overrides: Partial<SentimentResult> = {}): SentimentResult {
  return {
    count: 3,
    overallSentiment: 'POSITIVE',
    distribution: { POSITIVE: 2, NEGATIVE: 1 },
    averageScores: { Positive: 0.6412, Negative: 0.3011, Neutral: 0.0501, Mixed: 0.0076 },
    results: [
      {
        text: 'La tela es hermosa y llegó rapidísimo.',
        language: 'es',
        sentiment: 'POSITIVE',
        scores: { Positive: 0.9901, Negative: 0.0021, Neutral: 0.006, Mixed: 0.0018 },
      },
      {
        text: 'Great fit, would buy again.',
        language: 'en',
        sentiment: 'POSITIVE',
        scores: { Positive: 0.9712, Negative: 0.0101, Neutral: 0.0155, Mixed: 0.0032 },
      },
      {
        text: 'Se descosió el asa a la semana.',
        language: 'es',
        sentiment: 'NEGATIVE',
        scores: { Positive: 0.0012, Negative: 0.9954, Neutral: 0.0021, Mixed: 0.0013 },
      },
    ],
    ...overrides,
  };
}

/** Escribe N líneas en el textarea (paste: `type` con 11 saltos es lentísimo). */
async function pegarResenas(
  user: ReturnType<typeof userEvent.setup>,
  lineas: string[]
): Promise<void> {
  const textarea = screen.getByLabelText(/reseñas/i);
  await user.click(textarea);
  await user.paste(lineas.join('\n'));
}

describe('SentimentPanel Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiCapabilities).mockReturnValue({ ...TODAS_LAS_CAPACIDADES });
    vi.mocked(analyzeSentiment).mockResolvedValue(respuestaSentimiento());
  });

  describe('Stored sentiment', () => {
    it('should render the sentiment stored on the product', () => {
      render(<SentimentPanel product={mockProductEnriched} />);

      const guardado = screen.getByRole('region', { name: /sentimiento guardado/i });
      // reviewSentiment = POSITIVE. La pastilla se busca por su frase completa:
      // "Positivo" solo aparece además como etiqueta de la barra de distribución.
      // getByText mira sólo los text nodes DIRECTOS del elemento, así que la
      // pastilla anidada no entra en el match: la frase se afirma con
      // toHaveTextContent, que sí usa el textContent completo.
      const general = within(guardado).getByText(/sentimiento general guardado/i);
      expect(general).toHaveTextContent('Positivo');
      // reviewSentimentCounts: claves MAYÚSCULAS ({ POSITIVE: 3, NEUTRAL: 1 }).
      expect(within(guardado).getByText('3 reseñas')).toBeInTheDocument();
      expect(within(guardado).getByText('1 reseña')).toBeInTheDocument();
      // reviewSentimentScores: claves Capitalizadas (Positive: 0.9312).
      expect(within(guardado).getByText('Positivo 93.1%')).toBeInTheDocument();
      expect(within(guardado).getByText('Neutral 5.7%')).toBeInTheDocument();
    });

    it('should not call Comprehend just for rendering', () => {
      render(<SentimentPanel product={mockProductEnriched} />);

      expect(analyzeSentiment).not.toHaveBeenCalled();
    });

    it('should say when the product has no stored sentiment yet', () => {
      render(<SentimentPanel product={mockProduct} />);

      expect(screen.getByText(/todavía no tiene sentimiento guardado/i)).toBeInTheDocument();
      expect(
        screen.queryByRole('region', { name: /sentimiento guardado/i })
      ).not.toBeInTheDocument();
    });
  });

  describe('Review cap', () => {
    it('should keep both buttons disabled with an empty textarea', () => {
      render(<SentimentPanel product={mockProduct} />);

      expect(screen.getByRole('button', { name: /analizar y guardar/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /probar sin guardar/i })).toBeDisabled();
    });

    it('should enforce the 10-review cap and explain why', async () => {
      const user = userEvent.setup();
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(
        user,
        Array.from({ length: 11 }, (_, i) => `Reseña número ${i + 1}`)
      );

      const alerta = screen.getByRole('alert');
      expect(alerta).toHaveTextContent(/11 reseñas y el tope es 10/i);
      // La razón: 2N llamadas en serie contra un timeout de 30 s.
      expect(alerta).toHaveTextContent(/22 llamadas en serie/i);
      expect(alerta).toHaveTextContent(/30 s/i);

      const boton = screen.getByRole('button', { name: /analizar y guardar/i });
      expect(boton).toBeDisabled();
      await user.click(boton);
      expect(analyzeSentiment).not.toHaveBeenCalled();
    });

    it('should allow exactly 10 reviews and ignore blank lines', async () => {
      const user = userEvent.setup();
      render(<SentimentPanel product={mockProduct} />);

      const lineas = Array.from({ length: 10 }, (_, i) => `Reseña número ${i + 1}`);
      await pegarResenas(user, ['', ...lineas, '   ', '']);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      await waitFor(() => {
        expect(analyzeSentiment).toHaveBeenCalledWith({
          reviews: lineas,
          productId: mockProduct.productId,
        });
      });
    });
  });

  describe('Response rendering', () => {
    it('should render both casing conventions from the same payload', async () => {
      const user = userEvent.setup();
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima', 'Great', 'Se rompió']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      const resultado = await screen.findByRole('region', { name: /resultado del análisis/i });
      // distribution -> MAYÚSCULAS, conteos.
      expect(within(resultado).getByText('2 reseñas')).toBeInTheDocument();
      expect(within(resultado).getByText('1 reseña')).toBeInTheDocument();
      // averageScores -> Capitalizadas, promedios. Otros números a propósito.
      expect(within(resultado).getByText('Positivo 64.1%')).toBeInTheDocument();
      expect(within(resultado).getByText('Negativo 30.1%')).toBeInTheDocument();
      expect(within(resultado).getByText('Mixto 0.8%')).toBeInTheDocument();
    });

    it('should show the overall sentiment and the detected language per review', async () => {
      const user = userEvent.setup();
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima', 'Great', 'Se rompió']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      const resultado = await screen.findByRole('region', { name: /resultado del análisis/i });
      // Match exacto: la nota didáctica de abajo también dice "sentimiento general".
      expect(within(resultado).getByText('Sentimiento general:')).toBeInTheDocument();
      expect(within(resultado).getByText(/sobre 3 reseñas/i)).toBeInTheDocument();
      expect(within(resultado).getByText(/idioma detectado: en/i)).toBeInTheDocument();
      expect(within(resultado).getAllByText(/idioma detectado: es/i)).toHaveLength(2);
      // results[].sentiment es MAYÚSCULA y results[].scores Capitalizado: el
      // score de la etiqueta propia sale de traducir la clave.
      expect(within(resultado).getByText('Negativo 99.5%')).toBeInTheDocument();
    });

    it('should explain an overallSentiment that disagrees with the distribution', async () => {
      const user = userEvent.setup();
      // Mayoría POSITIVE (2 de 3) pero el promedio de scores da NEGATIVE: es el
      // caso legítimo, no un bug.
      vi.mocked(analyzeSentiment).mockResolvedValue(
        respuestaSentimiento({
          overallSentiment: 'NEGATIVE',
          averageScores: { Positive: 0.3208, Negative: 0.6001, Neutral: 0.0521, Mixed: 0.027 },
        })
      );
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima', 'Great', 'Se rompió']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      const resultado = await screen.findByRole('region', { name: /resultado del análisis/i });
      const nota = within(resultado).getByText(/no coincide/i);
      expect(nota).toHaveTextContent(/negativo/i);
      expect(nota).toHaveTextContent(/positivo/i);
      expect(nota).toHaveTextContent(/promedia scores/i);
      // Y la distribución sigue mostrándose tal cual vino.
      expect(within(resultado).getByText('2 reseñas')).toBeInTheDocument();
    });

    it('should not show the disagreement note when both agree', async () => {
      const user = userEvent.setup();
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima', 'Great', 'Se rompió']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      await screen.findByRole('region', { name: /resultado del análisis/i });
      expect(screen.queryByText(/no coincide/i)).not.toBeInTheDocument();
    });

    it('should explain a tie in the distribution instead of picking a winner', async () => {
      const user = userEvent.setup();
      vi.mocked(analyzeSentiment).mockResolvedValue(
        respuestaSentimiento({
          count: 2,
          overallSentiment: 'NEGATIVE',
          distribution: { POSITIVE: 1, NEGATIVE: 1 },
        })
      );
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima', 'Se rompió']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      const resultado = await screen.findByRole('region', { name: /resultado del análisis/i });
      expect(within(resultado).getByText(/empate entre etiquetas/i)).toBeInTheDocument();
    });
  });

  describe('Persistence modes', () => {
    it('should send productId and fire onAnalyzed when saving', async () => {
      const user = userEvent.setup();
      const onAnalyzed = vi.fn();
      render(<SentimentPanel product={mockProduct} onAnalyzed={onAnalyzed} />);

      await pegarResenas(user, ['Buenísima']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      await waitFor(() => {
        expect(analyzeSentiment).toHaveBeenCalledWith({
          reviews: ['Buenísima'],
          productId: mockProduct.productId,
        });
      });
      await waitFor(() => expect(onAnalyzed).toHaveBeenCalledWith(mockProduct.productId));
      // El handler devuelve 200 aunque el update_item falle: no prometemos nada.
      expect(await screen.findByText(/no avisa/i)).toBeInTheDocument();
    });

    it('should omit productId in read-only mode and not fire onAnalyzed', async () => {
      const user = userEvent.setup();
      const onAnalyzed = vi.fn();
      render(<SentimentPanel product={mockProduct} onAnalyzed={onAnalyzed} />);

      await pegarResenas(user, ['Buenísima']);
      await user.click(screen.getByRole('button', { name: /probar sin guardar/i }));

      await waitFor(() => {
        expect(analyzeSentiment).toHaveBeenCalledWith({ reviews: ['Buenísima'] });
      });
      expect(await screen.findByText(/modo prueba/i)).toBeInTheDocument();
      expect(onAnalyzed).not.toHaveBeenCalled();
    });

    it('should show a polite loading status while Comprehend runs', async () => {
      const user = userEvent.setup();
      vi.mocked(analyzeSentiment).mockImplementation(() => new Promise(() => {}));
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima', 'Se rompió']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      const estado = await screen.findByRole('status');
      expect(estado).toHaveAttribute('aria-live', 'polite');
      expect(estado).toHaveTextContent(/amazon comprehend/i);
      // 2 reseñas = 4 llamadas: el sr-only dice por qué tarda.
      expect(estado).toHaveTextContent(/4 llamadas en serie/i);
    });
  });

  describe('Error handling', () => {
    it('should render the AiError message and hint', async () => {
      const user = userEvent.setup();
      vi.mocked(analyzeSentiment).mockRejectedValue(
        new AiError(
          400,
          "Enviá 'text' o 'reviews' (lista de strings).",
          'body sin reviews',
          'Revisá el body del POST /sentiment.'
        )
      );
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      const alerta = await screen.findByRole('alert');
      expect(alerta).toHaveTextContent(/http 400/i);
      expect(alerta).toHaveTextContent(/revisá el body/i);
      expect(screen.queryByRole('region', { name: /resultado del análisis/i })).not.toBeInTheDocument();
    });

    it('should point at the missing Function URL when the capability is unconfigured', async () => {
      const user = userEvent.setup();
      vi.mocked(analyzeSentiment).mockRejectedValue(
        new AiNotConfiguredError('VITE_ANALYZE_SENTIMENT_URL')
      );
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima']);
      await user.click(screen.getByRole('button', { name: /analizar y guardar/i }));

      const alerta = await screen.findByRole('alert');
      expect(alerta).toHaveTextContent(/no está configurado/i);
      expect(alerta).toHaveTextContent(/VITE_ANALYZE_SENTIMENT_URL/);
    });

    it('should disable the buttons when aiCapabilities reports sentiment off', async () => {
      const user = userEvent.setup();
      vi.mocked(aiCapabilities).mockReturnValue({ ...TODAS_LAS_CAPACIDADES, sentiment: false });
      render(<SentimentPanel product={mockProduct} />);

      await pegarResenas(user, ['Buenísima']);

      expect(screen.getByRole('button', { name: /analizar y guardar/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /probar sin guardar/i })).toBeDisabled();
      expect(screen.getByText(/capacidad está apagada/i)).toBeInTheDocument();
    });
  });
});
