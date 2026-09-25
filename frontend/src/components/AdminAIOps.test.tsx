/**
 * Tests del indexador de embeddings (S07).
 *
 * DOS COSAS QUE SE VERIFICARON SOBRE EL AUTOMOCK Y CONDICIONAN ESTE ARCHIVO
 * ------------------------------------------------------------------------
 * 1. `vi.mock('../lib/ai')` también mockea `aiCapabilities`, y el automock
 *    devuelve `undefined`. Por eso se le da un valor explícito en cada test
 *    (`beforeEach`): sin eso, el panel estaría leyendo capacidades inexistentes.
 * 2. El automock achata el prototipo de las clases de error: `new AiError(...)`
 *    sale con todos los campos en `undefined` y un `AiNotConfiguredError` NO pasa
 *    `instanceof AiError`. Así que los rechazos se construyen acá como errores
 *    con la MISMA forma que el handler produce (`name`/`status`/`detail`/`hint`),
 *    que es lo que el componente lee.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminAIOps } from './AdminAIOps';
import { aiCapabilities, indexEmbeddings } from '../lib/ai';
import type { IndexResult } from '../lib/ai';

vi.mock('../lib/ai');

const allCapabilities = {
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

const successResult: IndexResult = {
  indexed: 4,
  skipped: 0,
  total: 4,
  model: 'amazon.titan-embed-text-v2:0',
};

/** El caso peligroso: HTTP 200, cero indexados. No hay excepción que catchear. */
const noModelAccessResult: IndexResult = {
  indexed: 0,
  skipped: 4,
  total: 4,
  model: 'amazon.titan-embed-text-v2:0',
};

const trigger = () => screen.getByRole('button', { name: /reindexar catálogo/i });
const confirmButton = () => screen.getByRole('button', { name: /sí, reindexar/i });

describe('AdminAIOps Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiCapabilities).mockReturnValue(allCapabilities);
    vi.mocked(indexEmbeddings).mockResolvedValue(successResult);
  });

  describe('Rendering', () => {
    it('should render the admin heading and the session pill', () => {
      render(<AdminAIOps />);

      expect(screen.getByRole('heading', { name: /indexador de embeddings/i })).toBeInTheDocument();
      expect(screen.getByText('S07 · Titan Embeddings v2')).toBeInTheDocument();
    });

    it('should explain what indexing is and that it gates search and the assistant', () => {
      render(<AdminAIOps />);

      // Consultas específicas a propósito: "vector" y "Titan Embeddings v2"
      // aparecen en más de un nodo del bloque didáctico.
      expect(screen.getByText(/convierte el texto de cada producto/i)).toBeInTheDocument();
      expect(screen.getByText(/del patrón rag/i)).toBeInTheDocument();
      expect(screen.getByText(/prerequisito duro/i)).toBeInTheDocument();
    });

    it('should apply the className passed by the parent', () => {
      const { container } = render(<AdminAIOps className="mb-8" />);

      expect(container.querySelector('section')).toHaveClass('mb-8');
    });

    it('should never fire the indexer on mount', () => {
      render(<AdminAIOps />);

      expect(indexEmbeddings).not.toHaveBeenCalled();
    });
  });

  describe('Confirmation gate', () => {
    it('should not call the indexer on the first click', async () => {
      const user = userEvent.setup();
      render(<AdminAIOps />);

      await user.click(trigger());

      // Lo único que cambió es que apareció el panel de confirmación.
      expect(indexEmbeddings).not.toHaveBeenCalled();
      expect(confirmButton()).toBeInTheDocument();
    });

    it('should explain the cost in the confirm panel', async () => {
      const user = userEvent.setup();
      render(<AdminAIOps />);

      await user.click(trigger());

      expect(screen.getByText(/recorre todo el catálogo/i)).toBeInTheDocument();
      expect(screen.getByText(/por producto/i)).toBeInTheDocument();
      expect(screen.getByText(/120 segundos/i)).toBeInTheDocument();
    });

    it('should disable the trigger while the confirm panel is open', async () => {
      const user = userEvent.setup();
      render(<AdminAIOps />);

      await user.click(trigger());

      expect(trigger()).toBeDisabled();
    });

    it('should move focus to the confirm button so it is keyboard-operable', async () => {
      const user = userEvent.setup();
      render(<AdminAIOps />);

      await user.click(trigger());

      expect(confirmButton()).toHaveFocus();
    });

    it('should fire the indexer when the confirmation is accepted', async () => {
      const user = userEvent.setup();
      render(<AdminAIOps />);

      await user.click(trigger());
      await user.click(confirmButton());

      await waitFor(() => {
        expect(indexEmbeddings).toHaveBeenCalledTimes(1);
      });
    });

    it('should fire the indexer when the confirmation is accepted with the keyboard', async () => {
      const user = userEvent.setup();
      render(<AdminAIOps />);

      await user.click(trigger());
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(indexEmbeddings).toHaveBeenCalledTimes(1);
      });
    });

    it('should not call the indexer when the confirmation is cancelled', async () => {
      const user = userEvent.setup();
      render(<AdminAIOps />);

      await user.click(trigger());
      await user.click(screen.getByRole('button', { name: /cancelar/i }));

      expect(indexEmbeddings).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /sí, reindexar/i })).not.toBeInTheDocument();
      expect(trigger()).toBeEnabled();
    });
  });

  describe('In flight', () => {
    it('should show a live progress region and disable the trigger while indexing', async () => {
      const user = userEvent.setup();
      let resolveIndex!: (result: IndexResult) => void;
      vi.mocked(indexEmbeddings).mockImplementation(
        () =>
          new Promise<IndexResult>((resolve) => {
            resolveIndex = resolve;
          })
      );

      render(<AdminAIOps />);
      await user.click(trigger());
      await user.click(confirmButton());

      const progress = await screen.findByRole('status');
      expect(progress).toHaveTextContent(/indexando el catálogo/i);
      expect(progress).toHaveAttribute('aria-live', 'polite');
      expect(trigger()).toBeDisabled();

      resolveIndex(successResult);

      await waitFor(() => {
        expect(screen.queryByText(/indexando el catálogo/i)).not.toBeInTheDocument();
      });
      expect(trigger()).toBeEnabled();
    });
  });

  describe('Success path', () => {
    it('should report the counts and call onIndexed', async () => {
      const user = userEvent.setup();
      const onIndexed = vi.fn();
      render(<AdminAIOps onIndexed={onIndexed} />);

      await user.click(trigger());
      await user.click(confirmButton());

      expect(await screen.findByText(/catálogo indexado: 4 de 4 productos/i)).toBeInTheDocument();
      expect(screen.getByText(/ya podés usar la búsqueda semántica/i)).toBeInTheDocument();
      expect(onIndexed).toHaveBeenCalledTimes(1);
      expect(onIndexed).toHaveBeenCalledWith(successResult);
    });

    it('should flag skipped products on a partial success', async () => {
      const user = userEvent.setup();
      const onIndexed = vi.fn();
      vi.mocked(indexEmbeddings).mockResolvedValue({
        indexed: 3,
        skipped: 1,
        total: 4,
        model: 'amazon.titan-embed-text-v2:0',
      });
      render(<AdminAIOps onIndexed={onIndexed} />);

      await user.click(trigger());
      await user.click(confirmButton());

      expect(await screen.findByText(/catálogo indexado: 3 de 4 productos/i)).toBeInTheDocument();
      expect(screen.getByText(/1 producto\(s\) quedaron omitidos/i)).toBeInTheDocument();
      expect(onIndexed).toHaveBeenCalledTimes(1);
    });
  });

  describe('Zero indexed (no Bedrock model access)', () => {
    it('should render indexed:0 with skipped>0 as a model-access warning, not a success', async () => {
      const user = userEvent.setup();
      vi.mocked(indexEmbeddings).mockResolvedValue(noModelAccessResult);
      render(<AdminAIOps />);

      await user.click(trigger());
      await user.click(confirmButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/no se indexó ningún producto/i);
      expect(alert).toHaveTextContent(/model access/i);
      expect(alert).toHaveTextContent(/titan embeddings v2/i);
      expect(alert).toHaveTextContent(/us-east-1/i);
      // No se presenta como éxito en ninguna parte.
      expect(screen.queryByText(/catálogo indexado/i)).not.toBeInTheDocument();
    });

    it('should not call onIndexed when nothing was indexed', async () => {
      const user = userEvent.setup();
      const onIndexed = vi.fn();
      vi.mocked(indexEmbeddings).mockResolvedValue(noModelAccessResult);
      render(<AdminAIOps onIndexed={onIndexed} />);

      await user.click(trigger());
      await user.click(confirmButton());

      await screen.findByRole('alert');
      expect(onIndexed).not.toHaveBeenCalled();
    });

    it('should report an empty catalog instead of a model-access warning', async () => {
      const user = userEvent.setup();
      vi.mocked(indexEmbeddings).mockResolvedValue({
        indexed: 0,
        skipped: 0,
        total: 0,
        model: 'amazon.titan-embed-text-v2:0',
      });
      render(<AdminAIOps />);

      await user.click(trigger());
      await user.click(confirmButton());

      expect(await screen.findByText(/no encontró productos para indexar/i)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('Error handling', () => {
    it('should render the backend hint when the call fails', async () => {
      const user = userEvent.setup();
      vi.mocked(indexEmbeddings).mockRejectedValue(
        Object.assign(new Error('Error interno del indexador'), {
          name: 'AiError',
          status: 502,
          detail: 'AccessDeniedException al invocar el modelo',
          hint: 'Habilitá Titan Embeddings v2 en Bedrock → Model access.',
        })
      );
      render(<AdminAIOps />);

      await user.click(trigger());
      await user.click(confirmButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/http 502/i);
      expect(alert).toHaveTextContent(/error interno del indexador/i);
      expect(alert).toHaveTextContent(/accessdeniedexception/i);
      expect(alert).toHaveTextContent(/habilitá titan embeddings v2/i);
    });

    it('should re-enable the trigger after a failure so it can be retried', async () => {
      const user = userEvent.setup();
      vi.mocked(indexEmbeddings).mockRejectedValue(
        Object.assign(new Error('Timeout'), { name: 'AiError', status: 504 })
      );
      render(<AdminAIOps />);

      await user.click(trigger());
      await user.click(confirmButton());

      await screen.findByRole('alert');
      expect(trigger()).toBeEnabled();
    });

    it('should explain an AiNotConfiguredError rejection instead of crashing', async () => {
      const user = userEvent.setup();
      vi.mocked(indexEmbeddings).mockRejectedValue(
        Object.assign(new Error('Capacidad de IA no configurada (falta VITE_INDEX_EMBEDDINGS_URL).'), {
          name: 'AiNotConfiguredError',
          status: 0,
        })
      );
      render(<AdminAIOps />);

      await user.click(trigger());
      await user.click(confirmButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/no está configurado/i);
      // Sin status HTTP real no inventamos uno.
      expect(alert).not.toHaveTextContent(/http 0/i);
    });
  });

  describe('Capability not configured', () => {
    it('should disable the trigger and explain when the index capability is off', () => {
      vi.mocked(aiCapabilities).mockReturnValue({ ...allCapabilities, index: false });
      render(<AdminAIOps />);

      expect(trigger()).toBeDisabled();
      expect(screen.getByText(/no está configurado/i)).toBeInTheDocument();
      expect(screen.getByText(/VITE_INDEX_EMBEDDINGS_URL/)).toBeInTheDocument();
    });

    it('should not offer the confirm step when the capability is off', async () => {
      const user = userEvent.setup();
      vi.mocked(aiCapabilities).mockReturnValue({ ...allCapabilities, index: false });
      render(<AdminAIOps />);

      await user.click(trigger());

      expect(screen.queryByRole('button', { name: /sí, reindexar/i })).not.toBeInTheDocument();
      expect(indexEmbeddings).not.toHaveBeenCalled();
    });
  });
});
