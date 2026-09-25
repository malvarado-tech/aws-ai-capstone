import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProductAIPanel } from './ProductAIPanel';
import {
  AiError,
  AiNotConfiguredError,
  aiCapabilities,
  enrichLabels,
  generateDescription,
  moderateImage,
} from '../lib/ai';
import type { DescribeResult, LabelsResult, ModerationResult } from '../lib/ai';
import { mockProduct, mockProductEnriched, mockProductFlagged } from '../test/mockData';

// Mockeamos SÓLO las funciones de red y aiCapabilities: `AiError` y
// `AiNotConfiguredError` tienen que seguir siendo las clases reales, porque el
// componente ramifica con `instanceof` y por `status`. Con el automock a secas el
// constructor queda vacío y un 422 dejaría de distinguirse de un 500.
vi.mock('../lib/ai', async () => {
  const actual = await vi.importActual<typeof import('../lib/ai')>('../lib/ai');
  return {
    ...actual,
    aiCapabilities: vi.fn(),
    enrichLabels: vi.fn(),
    moderateImage: vi.fn(),
    generateDescription: vi.fn(),
  };
});

const labelsResponse: LabelsResult = {
  productId: mockProduct.productId,
  imageSource: 'url',
  minConfidence: 80,
  labels: [
    { name: 'Shirt', confidence: 97.5 },
    { name: 'Sleeve', confidence: 88.25 },
  ],
};

const moderationResponse: ModerationResult = {
  productId: mockProduct.productId,
  moderationStatus: 'APPROVED',
  moderationFlags: [],
  altText: 'Imagen de producto que muestra: Shirt, Sleeve.',
};

const describeResponse: DescribeResult = {
  productId: mockProduct.productId,
  model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  tone: 'elegante y cercano',
  saved: false,
  description: 'Una camisa blanca que acompaña todos los días.',
  stopReason: 'end_turn',
  guardrailBlocked: false,
  usage: { inputTokens: 210, outputTokens: 96, totalTokens: 306 },
};

/** Producto del seed: el imageUrl es el placeholder que hace fallar S01/S02 con 422. */
const mockProductPlaceholderImage = {
  ...mockProduct,
  imageUrl: 'REEMPLAZAR_CON_TU_IMAGEN: s3://mi-stack-frontend/assets/camisa.jpg',
};

describe('ProductAIPanel Component', () => {
  const defaultProps = {
    product: mockProduct,
    isOpen: true,
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiCapabilities).mockReturnValue({
      labels: true,
      moderation: true,
      sentiment: true,
      translate: true,
      voice: true,
      describe: true,
      index: true,
      search: true,
      assistant: true,
    });
    vi.mocked(enrichLabels).mockResolvedValue(labelsResponse);
    vi.mocked(moderateImage).mockResolvedValue(moderationResponse);
    vi.mocked(generateDescription).mockResolvedValue(describeResponse);
  });

  describe('Rendering', () => {
    it('should not render when isOpen is false', () => {
      render(<ProductAIPanel {...defaultProps} isOpen={false} />);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('should render a labelled modal dialog when isOpen is true', () => {
      render(<ProductAIPanel {...defaultProps} />);

      const dialog = screen.getByRole('dialog', { name: /enriquecimiento con ia/i });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('should render the three AI sections with their buttons', () => {
      render(<ProductAIPanel {...defaultProps} />);

      expect(screen.getByRole('button', { name: /detectar etiquetas/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /moderar imagen/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /generar descripción/i })).toBeInTheDocument();
    });

    it('should not fire any AI call on open', () => {
      render(<ProductAIPanel {...defaultProps} />);

      expect(enrichLabels).not.toHaveBeenCalled();
      expect(moderateImage).not.toHaveBeenCalled();
      expect(generateDescription).not.toHaveBeenCalled();
    });

    it('should show empty states when the product has no enrichment', () => {
      render(<ProductAIPanel {...defaultProps} />);

      expect(screen.getByText(/todavía no hay etiquetas detectadas/i)).toBeInTheDocument();
      expect(screen.getByText(/sin moderar/i)).toBeInTheDocument();
      expect(screen.getByText(/todavía no hay descripción generada/i)).toBeInTheDocument();
    });

    it('should focus the panel on open', () => {
      render(<ProductAIPanel {...defaultProps} />);

      expect(screen.getByRole('dialog')).toHaveFocus();
    });
  });

  describe('Existing enrichment', () => {
    it('should render existing labels with their confidence', () => {
      render(<ProductAIPanel {...defaultProps} product={mockProductEnriched} />);

      expect(screen.getByText(/^shirt 98%$/i)).toBeInTheDocument();
      expect(screen.getByText(/^clothing 100%$/i)).toBeInTheDocument();
      expect(screen.getByText(/^blouse 84%$/i)).toBeInTheDocument();
    });

    it('should render labels without confidence when only aiLabels is present', () => {
      const onlyNames = { ...mockProduct, aiLabels: ['Clothing', 'Shirt'] };
      render(<ProductAIPanel {...defaultProps} product={onlyNames} />);

      expect(screen.getByText(/^clothing$/i)).toBeInTheDocument();
      expect(screen.getByText(/^shirt$/i)).toBeInTheDocument();
    });

    it('should render the APPROVED moderation badge', () => {
      render(<ProductAIPanel {...defaultProps} product={mockProductEnriched} />);

      expect(screen.getByText('APPROVED')).toBeInTheDocument();
      expect(screen.queryByText('FLAGGED')).not.toBeInTheDocument();
    });

    it('should render the alt text and explain what it is for', () => {
      render(<ProductAIPanel {...defaultProps} product={mockProductEnriched} />);

      expect(screen.getByText(mockProductEnriched.altText as string)).toBeInTheDocument();
      expect(screen.getByText(/lectores de pantalla/i)).toBeInTheDocument();
    });

    it('should render the saved description and its model', () => {
      render(<ProductAIPanel {...defaultProps} product={mockProductEnriched} />);

      expect(screen.getByText(mockProductEnriched.aiDescription as string)).toBeInTheDocument();
      expect(
        screen.getByText(new RegExp(mockProductEnriched.aiDescriptionModel as string))
      ).toBeInTheDocument();
    });

    it('should render the FLAGGED badge and its flags with confidences', () => {
      render(<ProductAIPanel {...defaultProps} product={mockProductFlagged} />);

      expect(screen.getByText('FLAGGED')).toBeInTheDocument();
      expect(screen.getByText(/suggestive 72%/i)).toBeInTheDocument();
      expect(screen.getByText(/revealing clothes 68%/i)).toBeInTheDocument();
      // La categoría padre se muestra sólo cuando el flag la trae.
      expect(screen.getByText(/categoría padre: suggestive/i)).toBeInTheDocument();
    });
  });

  describe('S01 · Rekognition labels', () => {
    it('should call enrichLabels with the productId when the button is clicked', async () => {
      const user = userEvent.setup();
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /detectar etiquetas/i }));

      await waitFor(() => {
        expect(enrichLabels).toHaveBeenCalledTimes(1);
      });
      expect(enrichLabels).toHaveBeenCalledWith(mockProduct.productId);
    });

    it('should render the freshly detected labels', async () => {
      const user = userEvent.setup();
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /detectar etiquetas/i }));

      await waitFor(() => {
        expect(screen.getByText(/^shirt 98%$/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/^sleeve 88%$/i)).toBeInTheDocument();
    });

    it('should call onEnriched after a successful detection', async () => {
      const user = userEvent.setup();
      const onEnriched = vi.fn();
      render(<ProductAIPanel {...defaultProps} onEnriched={onEnriched} />);

      await user.click(screen.getByRole('button', { name: /detectar etiquetas/i }));

      await waitFor(() => {
        expect(onEnriched).toHaveBeenCalledWith(mockProduct.productId);
      });
    });

    it('should disable the button and explain when the imageUrl is still the placeholder', () => {
      render(<ProductAIPanel {...defaultProps} product={mockProductPlaceholderImage} />);

      expect(screen.getByRole('button', { name: /detectar etiquetas/i })).toBeDisabled();
      expect(screen.getAllByText(/subí una imagen real/i).length).toBeGreaterThan(0);
      expect(enrichLabels).not.toHaveBeenCalled();
    });

    it('should render a 422 as actionable guidance instead of a raw error', async () => {
      const user = userEvent.setup();
      vi.mocked(enrichLabels).mockRejectedValue(
        new AiError(422, 'El producto no tiene una imageUrl válida. Subí una imagen real primero.')
      );
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /detectar etiquetas/i }));

      const alert = await waitFor(() => screen.getByRole('alert'));
      expect(alert).toHaveTextContent(/imageurl válida/i);
      expect(alert).toHaveTextContent(/subí una imagen real a s3/i);
    });

    it('should keep the other sections usable when labels fail', async () => {
      const user = userEvent.setup();
      vi.mocked(enrichLabels).mockRejectedValue(new AiError(500, 'Fallo al detectar etiquetas'));
      render(<ProductAIPanel {...defaultProps} product={mockProductEnriched} />);

      await user.click(screen.getByRole('button', { name: /detectar etiquetas/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/fallo al detectar etiquetas/i);
      });
      // La moderación y la descripción previas siguen en pantalla.
      expect(screen.getByText('APPROVED')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /moderar imagen/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /generar descripción/i })).toBeEnabled();
    });
  });

  describe('S02 · Moderation and alt text', () => {
    it('should call moderateImage with the productId when the button is clicked', async () => {
      const user = userEvent.setup();
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /moderar imagen/i }));

      await waitFor(() => {
        expect(moderateImage).toHaveBeenCalledWith(mockProduct.productId);
      });
    });

    it('should show a spinner while moderation is in flight', async () => {
      const user = userEvent.setup();
      let resolveModeration: ((value: ModerationResult) => void) | undefined;
      vi.mocked(moderateImage).mockImplementation(
        () =>
          new Promise<ModerationResult>((resolve) => {
            resolveModeration = resolve;
          })
      );
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /moderar imagen/i }));

      expect(screen.getByRole('status')).toHaveTextContent(/moderando la imagen/i);
      expect(screen.getByRole('button', { name: /moderar imagen/i })).toBeDisabled();

      resolveModeration?.(moderationResponse);

      await waitFor(() => {
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /moderar imagen/i })).toBeEnabled();
    });

    it('should render the fresh moderation result and alt text', async () => {
      const user = userEvent.setup();
      vi.mocked(moderateImage).mockResolvedValue({
        ...moderationResponse,
        moderationStatus: 'FLAGGED',
        moderationFlags: [{ name: 'Suggestive', parent: '', confidence: 91.6 }],
      });
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /moderar imagen/i }));

      await waitFor(() => {
        expect(screen.getByText('FLAGGED')).toBeInTheDocument();
      });
      expect(screen.getByText(/suggestive 92%/i)).toBeInTheDocument();
      expect(screen.getByText(moderationResponse.altText)).toBeInTheDocument();
    });

    it('should call onEnriched after a successful moderation', async () => {
      const user = userEvent.setup();
      const onEnriched = vi.fn();
      render(<ProductAIPanel {...defaultProps} onEnriched={onEnriched} />);

      await user.click(screen.getByRole('button', { name: /moderar imagen/i }));

      await waitFor(() => {
        expect(onEnriched).toHaveBeenCalledWith(mockProduct.productId);
      });
    });

    it('should render its 422 as guidance even though the message differs from S01', async () => {
      const user = userEvent.setup();
      // El mensaje de S02 NO trae "Subí una imagen real primero": ramificamos por status.
      vi.mocked(moderateImage).mockRejectedValue(
        new AiError(422, 'El producto no tiene una imageUrl válida.')
      );
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /moderar imagen/i }));

      const alert = await waitFor(() => screen.getByRole('alert'));
      expect(alert).toHaveTextContent(/imageurl válida/i);
      expect(alert).toHaveTextContent(/subí una imagen real a s3/i);
    });

    it('should disable moderation when the imageUrl is still the placeholder', () => {
      render(<ProductAIPanel {...defaultProps} product={mockProductPlaceholderImage} />);

      expect(screen.getByRole('button', { name: /moderar imagen/i })).toBeDisabled();
    });
  });

  describe('S06 · Bedrock description', () => {
    it('should omit tone entirely when the field is blank', async () => {
      const user = userEvent.setup();
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      await waitFor(() => {
        expect(generateDescription).toHaveBeenCalledWith(mockProduct.productId, { save: false });
      });
      const opts = vi.mocked(generateDescription).mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(opts)).not.toContain('tone');
    });

    it('should send the typed tone and a real boolean save flag', async () => {
      const user = userEvent.setup();
      render(<ProductAIPanel {...defaultProps} />);

      await user.type(screen.getByLabelText(/^tono$/i), 'técnico y breve');
      await user.click(screen.getByRole('checkbox', { name: /guardar en dynamodb/i }));
      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      await waitFor(() => {
        expect(generateDescription).toHaveBeenCalledWith(mockProduct.productId, {
          tone: 'técnico y breve',
          save: true,
        });
      });
      const opts = vi.mocked(generateDescription).mock.calls[0][1] as { save?: unknown };
      expect(opts.save).toBe(true);
    });

    it('should default the save checkbox to off', () => {
      render(<ProductAIPanel {...defaultProps} />);

      expect(screen.getByRole('checkbox', { name: /guardar en dynamodb/i })).not.toBeChecked();
    });

    it('should render the generated description with its usage tokens', async () => {
      const user = userEvent.setup();
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      await waitFor(() => {
        expect(screen.getByText(describeResponse.description)).toBeInTheDocument();
      });
      expect(screen.getByText(/entrada: 210/i)).toBeInTheDocument();
      expect(screen.getByText(/salida: 96/i)).toBeInTheDocument();
      expect(screen.getByText(/total: 306/i)).toBeInTheDocument();
      expect(screen.getByText(/vista previa: no se guardó nada/i)).toBeInTheDocument();
    });

    it('should show a spinner and disable the button while generating', async () => {
      const user = userEvent.setup();
      let resolveDescribe: ((value: DescribeResult) => void) | undefined;
      vi.mocked(generateDescription).mockImplementation(
        () =>
          new Promise<DescribeResult>((resolve) => {
            resolveDescribe = resolve;
          })
      );
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      expect(screen.getByRole('status')).toHaveTextContent(/generando la descripción/i);
      expect(screen.getByRole('button', { name: /generar descripción/i })).toBeDisabled();

      resolveDescribe?.(describeResponse);

      await waitFor(() => {
        expect(screen.getByText(describeResponse.description)).toBeInTheDocument();
      });
    });

    it('should render a guardrail block as blocked, not as a description', async () => {
      const user = userEvent.setup();
      const refusal = 'No puedo ayudarte con eso.';
      vi.mocked(generateDescription).mockResolvedValue({
        ...describeResponse,
        description: refusal,
        stopReason: 'guardrail_intervened',
        guardrailBlocked: true,
        saved: false,
      });
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      const alert = await waitFor(() => screen.getByRole('alert'));
      expect(alert).toHaveTextContent(/guardrail de bedrock intervino/i);
      expect(alert).toHaveTextContent(/mensaje de rechazo/i);
      // El texto de rechazo se muestra DENTRO del bloque de alerta, no como descripción.
      expect(alert).toHaveTextContent(refusal);
    });

    it('should not call onEnriched when the guardrail blocked the call', async () => {
      const user = userEvent.setup();
      const onEnriched = vi.fn();
      vi.mocked(generateDescription).mockResolvedValue({
        ...describeResponse,
        description: 'No puedo ayudarte con eso.',
        stopReason: 'guardrail_intervened',
        guardrailBlocked: true,
        // El handler calcula saved = save && !blocked: con bloqueo no escribe nunca.
        saved: false,
      });
      render(<ProductAIPanel {...defaultProps} onEnriched={onEnriched} />);

      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
      expect(onEnriched).not.toHaveBeenCalled();
    });

    it('should flag a max_tokens stopReason as an incomplete answer', async () => {
      const user = userEvent.setup();
      vi.mocked(generateDescription).mockResolvedValue({
        ...describeResponse,
        description: 'Una camisa blanca de corte clásico que combina con',
        stopReason: 'max_tokens',
      });
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/respuesta incompleta/i);
      });
      expect(screen.getByRole('alert')).toHaveTextContent(/max_tokens/i);
    });

    it('should call onEnriched only when the handler reports it saved', async () => {
      const user = userEvent.setup();
      const onEnriched = vi.fn();
      vi.mocked(generateDescription).mockResolvedValue({ ...describeResponse, saved: true });
      render(<ProductAIPanel {...defaultProps} onEnriched={onEnriched} />);

      await user.click(screen.getByRole('checkbox', { name: /guardar en dynamodb/i }));
      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      await waitFor(() => {
        expect(onEnriched).toHaveBeenCalledWith(mockProduct.productId);
      });
      expect(screen.getByText(/guardado en dynamodb/i)).toBeInTheDocument();
    });

    it('should not call onEnriched for a preview that saved nothing', async () => {
      const user = userEvent.setup();
      const onEnriched = vi.fn();
      render(<ProductAIPanel {...defaultProps} onEnriched={onEnriched} />);

      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      await waitFor(() => {
        expect(screen.getByText(describeResponse.description)).toBeInTheDocument();
      });
      expect(onEnriched).not.toHaveBeenCalled();
    });

    it('should render the backend hint when the call fails', async () => {
      const user = userEvent.setup();
      vi.mocked(generateDescription).mockRejectedValue(
        new AiError(
          502,
          'Fallo al invocar el modelo',
          'AccessDeniedException',
          '¿Habilitaste acceso al modelo en Bedrock > Model access (us-east-1)?'
        )
      );
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /generar descripción/i }));

      const alert = await waitFor(() => screen.getByRole('alert'));
      expect(alert).toHaveTextContent(/fallo al invocar el modelo/i);
      expect(alert).toHaveTextContent(/model access/i);
    });
  });

  describe('Capabilities', () => {
    it('should disable a section whose capability is not configured', () => {
      vi.mocked(aiCapabilities).mockReturnValue({
        labels: true,
        moderation: false,
        sentiment: true,
        translate: true,
        voice: true,
        describe: false,
        index: true,
        search: true,
        assistant: true,
      });
      render(<ProductAIPanel {...defaultProps} />);

      expect(screen.getByRole('button', { name: /moderar imagen/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /generar descripción/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /detectar etiquetas/i })).toBeEnabled();
      expect(screen.getAllByText(/capacidad no configurada/i)).toHaveLength(2);
    });

    it('should not crash when a call throws AiNotConfiguredError', async () => {
      const user = userEvent.setup();
      vi.mocked(enrichLabels).mockRejectedValue(
        new AiNotConfiguredError('VITE_ENRICH_LABELS_URL')
      );
      render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /detectar etiquetas/i }));

      const alert = await waitFor(() => screen.getByRole('alert'));
      expect(alert).toHaveTextContent(/no configurada/i);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('Accessibility and closing', () => {
    it('should call onClose when the close button is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<ProductAIPanel {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /^cerrar$/i }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when the icon button is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<ProductAIPanel {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /cerrar panel de ia/i }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when Escape is pressed', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<ProductAIPanel {...defaultProps} onClose={onClose} />);

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should label the tone input and the save checkbox', () => {
      render(<ProductAIPanel {...defaultProps} />);

      expect(screen.getByLabelText(/^tono$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/guardar en dynamodb/i)).toBeInTheDocument();
    });

    it('should drop the previous result when the product changes', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<ProductAIPanel {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /detectar etiquetas/i }));
      await waitFor(() => {
        expect(screen.getByText(/^shirt 98%$/i)).toBeInTheDocument();
      });

      rerender(<ProductAIPanel {...defaultProps} product={mockProductFlagged} />);

      await waitFor(() => {
        expect(screen.queryByText(/^sleeve 88%$/i)).not.toBeInTheDocument();
      });
    });
  });
});
