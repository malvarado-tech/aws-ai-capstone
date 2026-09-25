import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShoppingAssistant } from './ShoppingAssistant';
import { AiError, AiNotConfiguredError, askAssistant } from '../lib/ai';
import type { AssistantResult } from '../lib/ai';
import { mockProduct, mockProducts } from '../test/mockData';

/**
 * Mock PARCIAL: se reemplaza `askAssistant`, pero `AiError`,
 * `AiNotConfiguredError` y `ASSISTANT_HISTORY_LIMIT` son los reales. Con el
 * automock de vitest el constructor de una clase queda mockeado y
 * `new AiError(502, …)` perdería `status`/`detail`/`hint`, que es justo lo que el
 * componente usa para decidir qué mostrar.
 */
vi.mock('../lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ai')>();
  return { ...actual, askAssistant: vi.fn() };
});

const okReply: AssistantResult = {
  reply: 'Para una entrevista te recomiendo la Camisa Blanca Clásica.',
  retrieved: [
    { productId: mockProduct.productId, name: mockProduct.name },
    { productId: mockProducts[1].productId, name: mockProducts[1].name },
  ],
  model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  stopReason: 'end_turn',
  guardrailBlocked: false,
  usage: { inputTokens: 420, outputTokens: 88, totalTokens: 508 },
};

/** Un bloqueo de guardrail llega con HTTP 200 y el rechazo en `reply`. */
const blockedReply: AssistantResult = {
  reply: 'No puedo ayudarte con ese pedido.',
  retrieved: [],
  model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  stopReason: 'guardrail_intervened',
  guardrailBlocked: true,
  usage: { inputTokens: 120, outputTokens: 14, totalTokens: 134 },
};

function composer() {
  return screen.getByLabelText(/preguntá sobre el catálogo/i);
}

function sendButton() {
  return screen.getByRole('button', { name: /enviar/i });
}

describe('ShoppingAssistant Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(askAssistant).mockResolvedValue(okReply);
  });

  describe('Rendering', () => {
    it('should render a labelled composer and a send button', () => {
      render(<ShoppingAssistant />);

      expect(composer()).toBeInTheDocument();
      expect(sendButton()).toBeInTheDocument();
      expect(screen.getByText(/asistente de compras/i)).toBeInTheDocument();
    });

    it('should render an empty state before the first question', () => {
      render(<ShoppingAssistant />);

      expect(screen.getByText(/todavía no preguntaste nada/i)).toBeInTheDocument();
      expect(screen.getByRole('log')).toBeInTheDocument();
    });

    it('should disable the send button while the composer is empty', () => {
      render(<ShoppingAssistant />);

      expect(sendButton()).toBeDisabled();
    });
  });

  describe('Sending a message', () => {
    it('should render the user turn and the assistant reply', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), '¿Qué me pongo para una entrevista?');
      await user.click(sendButton());

      expect(screen.getByText('¿Qué me pongo para una entrevista?')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText(okReply.reply)).toBeInTheDocument();
      });
      expect(askAssistant).toHaveBeenCalledWith('¿Qué me pongo para una entrevista?', []);
    });

    it('should submit with Enter', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      await waitFor(() => {
        expect(askAssistant).toHaveBeenCalledWith('hola', []);
      });
    });

    it('should insert a newline with Shift+Enter instead of submitting', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'primera{Shift>}{Enter}{/Shift}segunda');

      expect(askAssistant).not.toHaveBeenCalled();
      expect(composer()).toHaveValue('primera\nsegunda');
    });

    it('should not send a whitespace-only message', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), '   {Enter}');

      expect(askAssistant).not.toHaveBeenCalled();
    });

    it('should pass the previous turns as history, since the backend does not persist them', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'primera{Enter}');
      await waitFor(() => {
        expect(screen.getByText(okReply.reply)).toBeInTheDocument();
      });

      await user.type(composer(), 'segunda{Enter}');

      await waitFor(() => {
        expect(askAssistant).toHaveBeenLastCalledWith('segunda', [
          { role: 'user', text: 'primera' },
          { role: 'assistant', text: okReply.reply },
        ]);
      });
    });

    it('should clear the conversation when Limpiar is clicked', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');
      await waitFor(() => {
        expect(screen.getByText(okReply.reply)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /limpiar/i }));

      expect(screen.queryByText(okReply.reply)).not.toBeInTheDocument();
      expect(screen.getByText(/todavía no preguntaste nada/i)).toBeInTheDocument();
    });
  });

  describe('In-flight behaviour (no streaming, 60 s timeout)', () => {
    it('should show a typing indicator instead of a fake token animation', async () => {
      vi.mocked(askAssistant).mockImplementation(() => new Promise(() => {}));
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      const status = await screen.findByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toHaveTextContent(/escribiendo/i);
    });

    it('should disable the send button while a request is in flight', async () => {
      vi.mocked(askAssistant).mockImplementation(() => new Promise(() => {}));
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      await waitFor(() => {
        expect(sendButton()).toBeDisabled();
      });
    });

    it('should not queue a concurrent request while one is pending', async () => {
      vi.mocked(askAssistant).mockImplementation(() => new Promise(() => {}));
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');
      await waitFor(() => {
        expect(askAssistant).toHaveBeenCalledTimes(1);
      });

      // Segundo intento mientras la primera llamada sigue viva.
      await user.type(composer(), 'otra vez{Enter}');

      expect(askAssistant).toHaveBeenCalledTimes(1);
    });
  });

  describe('Guardrail blocked (HTTP 200 con guardrailBlocked: true)', () => {
    it('should visually distinguish a blocked reply and say the guardrail intervened', async () => {
      vi.mocked(askAssistant).mockResolvedValue(blockedReply);
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'algo prohibido{Enter}');

      await waitFor(() => {
        expect(screen.getByText(blockedReply.reply)).toBeInTheDocument();
      });
      expect(screen.getByText(/un guardrail de bedrock intervino/i)).toBeInTheDocument();
      // El estilo de rechazo (superficie roja) tiene que estar en la burbuja.
      const bubble = screen.getByText(blockedReply.reply).parentElement;
      expect(bubble?.className).toContain('bg-red-50');
    });

    it('should not surface the missing-index warning for a blocked reply', async () => {
      vi.mocked(askAssistant).mockResolvedValue(blockedReply);
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'algo prohibido{Enter}');

      await waitFor(() => {
        expect(screen.getByText(blockedReply.reply)).toBeInTheDocument();
      });
      expect(screen.queryByText(/indexador/i)).not.toBeInTheDocument();
    });
  });

  describe('Citations (retrieved)', () => {
    it('should render a chip per retrieved product', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      await waitFor(() => {
        expect(screen.getByText(okReply.reply)).toBeInTheDocument();
      });
      expect(screen.getByText(mockProduct.name)).toBeInTheDocument();
      expect(screen.getByText(mockProducts[1].name)).toBeInTheDocument();
    });

    it('should call onSelectProduct when a citation chip is clicked', async () => {
      const onSelectProduct = vi.fn();
      const user = userEvent.setup();
      render(<ShoppingAssistant onSelectProduct={onSelectProduct} />);

      await user.type(composer(), 'hola{Enter}');

      const chip = await screen.findByRole('button', {
        name: new RegExp(mockProduct.name, 'i'),
      });
      await user.click(chip);

      expect(onSelectProduct).toHaveBeenCalledWith(mockProduct.productId);
    });

    it('should render chips as plain text when there is no onSelectProduct', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      await waitFor(() => {
        expect(screen.getByText(mockProduct.name)).toBeInTheDocument();
      });
      expect(
        screen.queryByRole('button', { name: new RegExp(mockProduct.name, 'i') })
      ).not.toBeInTheDocument();
    });

    it('should surface that the index needs building when retrieved is empty', async () => {
      vi.mocked(askAssistant).mockResolvedValue({ ...okReply, retrieved: [] });
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      await waitFor(() => {
        expect(screen.getByText(/ningún item tiene embedding/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/indexador/i)).toBeInTheDocument();
    });

    it('should show the token usage as a teaching artifact', async () => {
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      await waitFor(() => {
        expect(screen.getByText(/508 tokens/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error handling', () => {
    it('should render the AiError message, detail and hint in an alert', async () => {
      vi.mocked(askAssistant).mockRejectedValue(
        new AiError(502, 'Bedrock no respondió', 'ValidationException', 'Revisá el historial.')
      );
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/bedrock no respondió/i);
      expect(alert).toHaveTextContent(/validationexception/i);
      expect(alert).toHaveTextContent(/revisá el historial/i);
    });

    it('should render a generic message for a non-AI error', async () => {
      vi.mocked(askAssistant).mockRejectedValue(new Error('network down'));
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/no pudimos consultar al asistente/i);
    });

    it('should render a muted notice when the capability is not configured', async () => {
      vi.mocked(askAssistant).mockRejectedValue(
        new AiNotConfiguredError('VITE_SHOPPING_ASSISTANT_URL')
      );
      const user = userEvent.setup();
      render(<ShoppingAssistant />);

      await user.type(composer(), 'hola{Enter}');

      await waitFor(() => {
        expect(screen.getByText(/no disponible/i)).toBeInTheDocument();
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/preguntá sobre el catálogo/i)).not.toBeInTheDocument();
    });
  });
});
