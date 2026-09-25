import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SemanticSearch } from './SemanticSearch';
import { AiError, AiNotConfiguredError, searchProducts } from '../lib/ai';
import type { SearchResult } from '../lib/ai';
import { mockProducts } from '../test/mockData';

/**
 * El mock es PARCIAL a propósito: se reemplaza `searchProducts`, pero `AiError` y
 * `AiNotConfiguredError` se importan de verdad. Con el automock de vitest el
 * constructor de una clase también queda mockeado, así que `new AiError(502, …)`
 * devolvería una instancia SIN `status`/`detail`/`hint` y el componente no podría
 * distinguir un error del handler de una capacidad apagada.
 */
vi.mock('../lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ai')>();
  return { ...actual, searchProducts: vi.fn() };
});

/** Tiene que coincidir con el DEBOUNCE_MS del componente. */
const DEBOUNCE_MS = 500;

const searchOk: SearchResult = {
  query: 'algo elegante',
  results: [
    {
      productId: mockProducts[0].productId,
      name: mockProducts[0].name,
      category: mockProducts[0].category,
      price: mockProducts[0].price,
      score: 0.8123,
    },
    {
      productId: mockProducts[3].productId,
      name: mockProducts[3].name,
      category: mockProducts[3].category,
      // El handler puede devolver price null: el producto existe sin precio.
      price: null,
      score: 0.4412,
    },
  ],
};

/**
 * Con timers falsos NO se puede usar `waitFor`: @testing-library/dom detecta
 * timers falsos sólo si existe el global `jest`, que en vitest no existe, así que
 * su polling interno queda congelado. Se avanza a mano y se deja que la promesa
 * del mock se resuelva dentro de `act`.
 */
async function runDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  });
}

function typeInto(text: string) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  return user.type(screen.getByLabelText(/buscá con lenguaje natural/i), text);
}

describe('SemanticSearch Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(searchProducts).mockResolvedValue(searchOk);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Rendering', () => {
    it('should render a labelled search input', () => {
      render(<SemanticSearch />);

      expect(screen.getByLabelText(/buscá con lenguaje natural/i)).toBeInTheDocument();
      expect(screen.getByText(/búsqueda semántica/i)).toBeInTheDocument();
    });

    it('should not show results or errors before any query', () => {
      render(<SemanticSearch />);

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });
  });

  describe('Debounce (cada llamada es un embedding facturado)', () => {
    it('should call the client once for a burst of keystrokes', async () => {
      render(<SemanticSearch />);

      await typeInto('camisa');
      expect(searchProducts).not.toHaveBeenCalled();

      await runDebounce();

      expect(searchProducts).toHaveBeenCalledTimes(1);
      expect(searchProducts).toHaveBeenCalledWith('camisa');
    });

    it('should not call the client before the debounce window elapses', async () => {
      render(<SemanticSearch />);

      await typeInto('camisa');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);
      });

      expect(searchProducts).not.toHaveBeenCalled();
    });

    it('should not call the client for an empty query', async () => {
      render(<SemanticSearch />);

      await runDebounce();

      expect(searchProducts).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('should not call the client for a whitespace-only query', async () => {
      render(<SemanticSearch />);

      await typeInto('   ');
      await runDebounce();

      expect(searchProducts).not.toHaveBeenCalled();
    });

    it('should trim the query before sending it', async () => {
      render(<SemanticSearch />);

      await typeInto('  camisa  ');
      await runDebounce();

      expect(searchProducts).toHaveBeenCalledWith('camisa');
    });
  });

  describe('Results', () => {
    it('should render each result with its similarity score', async () => {
      render(<SemanticSearch />);

      await typeInto('algo elegante');
      await runDebounce();

      expect(screen.getByText(mockProducts[0].name)).toBeInTheDocument();
      expect(screen.getByText(mockProducts[3].name)).toBeInTheDocument();
      expect(screen.getByText(/81% de similitud/i)).toBeInTheDocument();
      expect(screen.getByText(/44% de similitud/i)).toBeInTheDocument();
    });

    it('should warn that cosine similarity has no relevance floor', async () => {
      render(<SemanticSearch />);

      await typeInto('asdfgh');
      await runDebounce();

      expect(screen.getByText(/el coseno no tiene piso/i)).toBeInTheDocument();
    });

    it('should render a fallback when a result has no price', async () => {
      render(<SemanticSearch />);

      await typeInto('algo elegante');
      await runDebounce();

      expect(screen.getByText(`$${mockProducts[0].price.toFixed(2)}`)).toBeInTheDocument();
      expect(screen.getByText(/precio no disponible/i)).toBeInTheDocument();
    });

    it('should call onSelectProduct when a result is clicked', async () => {
      const onSelectProduct = vi.fn();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<SemanticSearch onSelectProduct={onSelectProduct} />);

      await typeInto('algo elegante');
      await runDebounce();

      await user.click(screen.getByRole('button', { name: new RegExp(mockProducts[0].name, 'i') }));

      expect(onSelectProduct).toHaveBeenCalledTimes(1);
      expect(onSelectProduct).toHaveBeenCalledWith(mockProducts[0].productId);
    });

    it('should not crash when a result is clicked without onSelectProduct', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<SemanticSearch />);

      await typeInto('algo elegante');
      await runDebounce();

      const firstResult = screen.getByRole('button', {
        name: new RegExp(mockProducts[0].name, 'i'),
      });
      await user.click(firstResult);

      expect(firstResult).toBeInTheDocument();
    });

    it('should show a no-results message when the response is empty without a hint', async () => {
      vi.mocked(searchProducts).mockResolvedValue({ query: 'zzz', results: [] });
      render(<SemanticSearch />);

      await typeInto('zzz');
      await runDebounce();

      expect(screen.getByText(/no encontramos nada parecido/i)).toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });

    it('should clear the results when the query is emptied', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<SemanticSearch />);

      await typeInto('algo elegante');
      await runDebounce();
      expect(screen.getByText(mockProducts[0].name)).toBeInTheDocument();

      await user.clear(screen.getByLabelText(/buscá con lenguaje natural/i));
      await runDebounce();

      expect(screen.queryByText(mockProducts[0].name)).not.toBeInTheDocument();
      expect(searchProducts).toHaveBeenCalledTimes(1);
    });
  });

  describe('Index not built (hint)', () => {
    it('should render the hint prominently when nothing could be scored', async () => {
      vi.mocked(searchProducts).mockResolvedValue({
        query: 'camisa',
        results: [],
        hint: '¿Corriste POST /search/index primero?',
      });
      render(<SemanticSearch />);

      await typeInto('camisa');
      await runDebounce();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/índice de embeddings todavía no está construido/i);
      expect(alert).toHaveTextContent(/corriste post \/search\/index primero/i);
      expect(alert).toHaveTextContent(/indexador/i);
    });

    it('should not show the generic no-results message when a hint is present', async () => {
      vi.mocked(searchProducts).mockResolvedValue({
        query: 'camisa',
        results: [],
        hint: '¿Corriste POST /search/index primero?',
      });
      render(<SemanticSearch />);

      await typeInto('camisa');
      await runDebounce();

      expect(screen.queryByText(/no encontramos nada parecido/i)).not.toBeInTheDocument();
    });
  });

  describe('Loading state', () => {
    it('should show a polite status while the request is in flight', async () => {
      vi.mocked(searchProducts).mockImplementation(() => new Promise(() => {}));
      render(<SemanticSearch />);

      await typeInto('camisa');
      await runDebounce();

      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toHaveTextContent(/buscando/i);
    });
  });

  describe('Error handling', () => {
    it('should render the AiError message, detail and hint in an alert', async () => {
      vi.mocked(searchProducts).mockRejectedValue(
        new AiError(502, 'Bedrock no respondió', 'AccessDeniedException', 'Habilitá Model access.')
      );
      render(<SemanticSearch />);

      await typeInto('camisa');
      await runDebounce();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/bedrock no respondió/i);
      expect(alert).toHaveTextContent(/accessdeniedexception/i);
      expect(alert).toHaveTextContent(/habilitá model access/i);
    });

    it('should render a generic message for a non-AI error', async () => {
      vi.mocked(searchProducts).mockRejectedValue(new Error('network down'));
      render(<SemanticSearch />);

      await typeInto('camisa');
      await runDebounce();

      expect(screen.getByRole('alert')).toHaveTextContent(/no pudimos completar la búsqueda/i);
    });

    it('should render a muted notice when the capability is not configured', async () => {
      vi.mocked(searchProducts).mockRejectedValue(
        new AiNotConfiguredError('VITE_SEMANTIC_SEARCH_URL')
      );
      render(<SemanticSearch />);

      await typeInto('camisa');
      await runDebounce();

      expect(screen.getByText(/no disponible/i)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/buscá con lenguaje natural/i)).not.toBeInTheDocument();
    });
  });
});
