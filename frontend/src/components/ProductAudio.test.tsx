import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProductAudio } from './ProductAudio';
import { AiError, AiNotConfiguredError, aiCapabilities, synthesizeVoice } from '../lib/ai';
import type { VoiceResult } from '../lib/ai';
import { mockProduct, mockProductEnriched } from '../test/mockData';

/**
 * Mockeamos SÓLO las funciones y dejamos las clases reales.
 *
 * Con `vi.mock('../lib/ai')` pelado el automock también reemplaza los
 * constructores: se midió que `new AiError(502, 'boom', 'detalle', 'pista')`
 * queda con `status`, `detail`, `hint` y `message` en undefined, y que
 * `new AiNotConfiguredError(...) instanceof AiError` pasa a ser **false** (se
 * rompe la cadena de prototipos). Con eso no se puede testear el camino de error,
 * que es justo lo que hay que cubrir.
 */
vi.mock('../lib/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/ai')>();
  return {
    ...real,
    aiCapabilities: vi.fn(),
    synthesizeVoice: vi.fn(),
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

/** Respuesta real de S05: URL prefirmada + expiresIn, sin nada persistible. */
function respuestaVoz(overrides: Partial<VoiceResult> = {}): VoiceResult {
  return {
    productId: mockProduct.productId,
    lang: 'es',
    voice: 'Lupe',
    audioUrl:
      'https://techmoda-ai-audio.s3.amazonaws.com/audio/test-product-123-es.mp3?X-Amz-Signature=abc123',
    expiresIn: 3600,
    ...overrides,
  };
}

describe('ProductAudio Component', () => {
  let play: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom no implementa HTMLMediaElement.play (loguea "Not implemented" y
    // devuelve undefined). Lo stubbeamos para poder afirmar que se reprodujo.
    play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.play = play as unknown as () => Promise<void>;
    vi.mocked(aiCapabilities).mockReturnValue({ ...TODAS_LAS_CAPACIDADES });
    vi.mocked(synthesizeVoice).mockResolvedValue(respuestaVoz());
  });

  describe('Initial Rendering', () => {
    it('should render the play button without calling Polly on mount', () => {
      render(<ProductAudio product={mockProduct} />);

      expect(screen.getByRole('button', { name: /escuchar con polly/i })).toBeEnabled();
      expect(synthesizeVoice).not.toHaveBeenCalled();
    });

    it('should not render a playable audio source before any request', () => {
      const { container } = render(<ProductAudio product={mockProduct} />);

      // No hay URL que poner en src hasta que el endpoint responda: el <audio>
      // no puede existir todavía.
      expect(container.querySelector('audio')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/audio de/i)).not.toBeInTheDocument();
    });

    it('should explain that a stored audioKey is not playable', () => {
      const { container } = render(<ProductAudio product={mockProductEnriched} />);

      expect(screen.getByText(/ya tiene audio generado/i)).toBeInTheDocument();
      expect(screen.getByText(/audio\/test-product-enriched-es\.mp3/i)).toBeInTheDocument();
      expect(screen.getByText(/nunca se persiste/i)).toBeInTheDocument();
      // Tener la clave guardada NO habilita un reproductor.
      expect(container.querySelector('audio')).not.toBeInTheDocument();
    });

    it('should warn that English reads the S04 translation or falls back to a Spanish text', () => {
      render(<ProductAudio product={mockProduct} />);

      // "Joanna" solo también es el texto de la opción del select: buscamos la
      // frase de la nota, que es la que explica el fallback.
      expect(screen.getByText(/traducción de s04/i)).toBeInTheDocument();
      expect(screen.getByText(/voz inglesa \(joanna\)/i)).toBeInTheDocument();
    });
  });

  describe('Synthesis flow', () => {
    it('should request a fresh presigned URL and play it when clicked', async () => {
      const user = userEvent.setup();
      render(<ProductAudio product={mockProduct} />);

      await user.click(screen.getByRole('button', { name: /escuchar con polly/i }));

      await waitFor(() => {
        expect(synthesizeVoice).toHaveBeenCalledWith(mockProduct.productId, 'es');
      });

      const audio = await screen.findByLabelText(/audio de camisa blanca clásica/i);
      expect(audio).toHaveAttribute('src', respuestaVoz().audioUrl);
      expect(audio).toHaveAttribute('controls');
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    });

    it('should show a polite loading status while synthesizing', async () => {
      const user = userEvent.setup();
      vi.mocked(synthesizeVoice).mockImplementation(() => new Promise(() => {}));
      render(<ProductAudio product={mockProduct} />);

      await user.click(screen.getByRole('button', { name: /escuchar con polly/i }));

      const estado = await screen.findByRole('status');
      expect(estado).toHaveAttribute('aria-live', 'polite');
      expect(estado).toHaveTextContent(/amazon polly/i);
      expect(screen.getByRole('button', { name: /generando audio/i })).toBeDisabled();
    });

    it('should show the voice that the response actually used', async () => {
      const user = userEvent.setup();
      render(<ProductAudio product={mockProduct} />);

      await user.click(screen.getByRole('button', { name: /escuchar con polly/i }));

      expect(await screen.findByText(/voz: lupe/i)).toBeInTheDocument();
    });
  });

  describe('Presigned URL cache', () => {
    it('should reuse the cached URL on a second play instead of re-billing Polly', async () => {
      const user = userEvent.setup();
      render(<ProductAudio product={mockProduct} />);

      const boton = screen.getByRole('button', { name: /escuchar con polly/i });
      await user.click(boton);
      await screen.findByLabelText(/audio de/i);
      await user.click(boton);

      await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
      expect(synthesizeVoice).toHaveBeenCalledTimes(1);
    });

    it('should re-request when the cached URL is inside the expiry margin', async () => {
      const user = userEvent.setup();
      // expiresIn menor que el margen de seguridad: la URL se considera vencida
      // enseguida y hay que pedir una nueva antes que reproducir un link muerto.
      vi.mocked(synthesizeVoice).mockResolvedValue(respuestaVoz({ expiresIn: 45 }));
      render(<ProductAudio product={mockProduct} />);

      const boton = screen.getByRole('button', { name: /escuchar con polly/i });
      await user.click(boton);
      await screen.findByLabelText(/audio de/i);
      await user.click(boton);

      await waitFor(() => expect(synthesizeVoice).toHaveBeenCalledTimes(2));
    });
  });

  describe('Language choice', () => {
    it('should offer only es and en', () => {
      render(<ProductAudio product={mockProduct} />);

      const opciones = screen.getAllByRole('option');
      expect(opciones).toHaveLength(2);
      expect(opciones.map((o) => o.getAttribute('value'))).toEqual(['es', 'en']);
    });

    it('should send lang en to the client after selecting English', async () => {
      const user = userEvent.setup();
      vi.mocked(synthesizeVoice).mockResolvedValue(
        respuestaVoz({ lang: 'en', voice: 'Joanna' })
      );
      render(<ProductAudio product={mockProduct} />);

      await user.selectOptions(screen.getByLabelText(/idioma de la voz/i), 'en');
      await user.click(screen.getByRole('button', { name: /escuchar con polly/i }));

      await waitFor(() => {
        expect(synthesizeVoice).toHaveBeenCalledWith(mockProduct.productId, 'en');
      });
      expect(await screen.findByText(/voz: joanna/i)).toBeInTheDocument();
    });

    it('should request a new URL when the language changes', async () => {
      const user = userEvent.setup();
      render(<ProductAudio product={mockProduct} />);

      const boton = screen.getByRole('button', { name: /escuchar con polly/i });
      await user.click(boton);
      await screen.findByLabelText(/audio de/i);

      // Cambiar de idioma limpia el reproductor: nunca el audio español con la
      // etiqueta inglesa.
      await user.selectOptions(screen.getByLabelText(/idioma de la voz/i), 'en');
      expect(screen.queryByLabelText(/audio de/i)).not.toBeInTheDocument();

      await user.click(boton);
      await waitFor(() => expect(synthesizeVoice).toHaveBeenCalledTimes(2));
      expect(vi.mocked(synthesizeVoice).mock.calls[1]).toEqual([mockProduct.productId, 'en']);
    });
  });

  describe('Error handling', () => {
    it('should render the AiError message, hint and detail', async () => {
      const user = userEvent.setup();
      vi.mocked(synthesizeVoice).mockRejectedValue(
        new AiError(
          502,
          'Fallo al generar el audio',
          'ValidationException: engine neural no disponible',
          'Probá con la voz estándar o revisá la región.'
        )
      );
      render(<ProductAudio product={mockProduct} />);

      await user.click(screen.getByRole('button', { name: /escuchar con polly/i }));

      const alerta = await screen.findByRole('alert');
      expect(alerta).toHaveTextContent(/fallo al generar el audio/i);
      expect(alerta).toHaveTextContent(/http 502/i);
      expect(alerta).toHaveTextContent(/probá con la voz estándar/i);
      expect(alerta).toHaveTextContent(/engine neural no disponible/i);
    });

    it('should point at the missing Function URL when the capability is unconfigured', async () => {
      const user = userEvent.setup();
      vi.mocked(synthesizeVoice).mockRejectedValue(
        new AiNotConfiguredError('VITE_SYNTHESIZE_VOICE_URL')
      );
      render(<ProductAudio product={mockProduct} />);

      await user.click(screen.getByRole('button', { name: /escuchar con polly/i }));

      const alerta = await screen.findByRole('alert');
      expect(alerta).toHaveTextContent(/no está configurada/i);
      expect(alerta).toHaveTextContent(/VITE_SYNTHESIZE_VOICE_URL/);
    });

    it('should disable the button when aiCapabilities reports voice off', () => {
      vi.mocked(aiCapabilities).mockReturnValue({ ...TODAS_LAS_CAPACIDADES, voice: false });
      render(<ProductAudio product={mockProduct} />);

      expect(screen.getByRole('button', { name: /escuchar con polly/i })).toBeDisabled();
      expect(screen.getByText(/capacidad está apagada/i)).toBeInTheDocument();
    });

    it('should recover from a failed attempt and clear the alert on retry', async () => {
      const user = userEvent.setup();
      vi.mocked(synthesizeVoice)
        .mockRejectedValueOnce(new AiError(404, 'Producto no encontrado.'))
        .mockResolvedValueOnce(respuestaVoz());
      render(<ProductAudio product={mockProduct} />);

      const boton = screen.getByRole('button', { name: /escuchar con polly/i });
      await user.click(boton);
      expect(await screen.findByRole('alert')).toBeInTheDocument();

      await user.click(boton);
      await screen.findByLabelText(/audio de/i);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
