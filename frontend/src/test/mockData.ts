import type { Product } from '../lib/types';

export const mockProduct: Product = {
  productId: 'test-product-123',
  name: 'Camisa Blanca Clásica',
  description: 'Camisa blanca elegante perfecta para cualquier ocasión',
  price: 49.99,
  category: 'Ropa',
  stock: 25,
  imageUrl: 'https://public-data-669070217575.s3.us-east-1.amazonaws.com/white-shirt.jpg',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  translations: {
    es: {
      name: 'Camisa Blanca Clásica',
      description: 'Camisa blanca elegante perfecta para cualquier ocasión',
    },
    en: {
      name: 'Classic White Shirt',
      description: 'Elegant white shirt perfect for any occasion',
    },
  },
};

export const mockProducts: Product[] = [
  mockProduct,
  {
    productId: 'test-product-456',
    name: 'Jeans Azules',
    description: 'Jeans cómodos de mezclilla azul',
    price: 79.99,
    category: 'Ropa',
    stock: 15,
    imageUrl: 'https://public-data-669070217575.s3.us-east-1.amazonaws.com/white-shirt.jpg',
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    translations: {
      es: {
        name: 'Jeans Azules',
        description: 'Jeans cómodos de mezclilla azul',
      },
      en: {
        name: 'Blue Jeans',
        description: 'Comfortable blue denim jeans',
      },
    },
  },
  {
    productId: 'test-product-789',
    name: 'Zapatos Deportivos',
    description: 'Zapatillas deportivas para correr',
    price: 129.99,
    category: 'Zapatos',
    stock: 0,
    imageUrl: 'https://public-data-669070217575.s3.us-east-1.amazonaws.com/white-shirt.jpg',
    createdAt: '2024-01-03T00:00:00Z',
    updatedAt: '2024-01-03T00:00:00Z',
    translations: {
      es: {
        name: 'Zapatos Deportivos',
        description: 'Zapatillas deportivas para correr',
      },
      en: {
        name: 'Sports Shoes',
        description: 'Athletic sneakers for running',
      },
    },
  },
  {
    productId: 'test-product-101',
    name: 'Reloj Elegante',
    description: 'Reloj de pulsera elegante',
    price: 199.99,
    category: 'Accesorios',
    stock: 10,
    imageUrl: 'https://public-data-669070217575.s3.us-east-1.amazonaws.com/white-shirt.jpg',
    createdAt: '2024-01-04T00:00:00Z',
    updatedAt: '2024-01-04T00:00:00Z',
    translations: {
      es: {
        name: 'Reloj Elegante',
        description: 'Reloj de pulsera elegante',
      },
      en: {
        name: 'Elegant Watch',
        description: 'Elegant wristwatch',
      },
    },
  },
];

/**
 * Producto con TODOS los campos de IA que escriben S1–S7, para los tests de los
 * paneles de IA.
 *
 * Existe aparte de `mockProduct` a propósito: `mockProduct` NO debe llevar
 * `altText`, porque hay tests que afirman que el alt de la imagen es el nombre
 * del producto. Agregarlo ahí rompería ProductCard.test.tsx en silencio.
 *
 * Los nombres salen del `update_item` de cada handler, no de los viejos campos
 * `ai*` inventados. Ojo con dos:
 *   - `embedding` es un STRING (json.dumps del vector), no number[].
 *   - `audioKey` se persiste, la URL prefirmada NO.
 */
export const mockProductEnriched: Product = {
  ...mockProduct,
  productId: 'test-product-enriched',

  // S1 · Rekognition DetectLabels
  aiLabels: ['Clothing', 'Shirt', 'Sleeve', 'Blouse'],
  aiLabelsRaw: [
    { name: 'Clothing', confidence: 99.87 },
    { name: 'Shirt', confidence: 98.2 },
    { name: 'Sleeve', confidence: 91.4 },
    { name: 'Blouse', confidence: 84.05 },
  ],

  // S2 · Rekognition moderación + alt-text
  moderationStatus: 'APPROVED',
  moderationFlags: [],
  altText: 'Imagen de producto que muestra: Clothing, Shirt, Sleeve, Blouse.',

  // S3 · Comprehend
  reviewSentiment: 'POSITIVE',
  reviewSentimentCounts: { POSITIVE: 3, NEUTRAL: 1 },
  reviewSentimentScores: { Positive: 0.9312, Negative: 0.0121, Neutral: 0.0567, Mixed: 0.0 },

  // S5 · Polly (sólo la clave; la URL es efímera y no se guarda)
  audioKey: 'audio/test-product-enriched-es.mp3',

  // S6 · Bedrock Converse
  aiDescription: 'Una camisa blanca de corte clásico, pensada para durar más de una temporada.',
  aiDescriptionModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',

  // S7 · Titan Embeddings (string, recortado: el real trae ~1024 floats)
  embedding: '[0.0123, -0.0456, 0.0789]',
  embeddingModel: 'amazon.titan-embed-text-v2:0',
  embeddingDim: 1024,
};

/** Producto marcado por moderación, para el camino FLAGGED de S02. */
export const mockProductFlagged: Product = {
  ...mockProduct,
  productId: 'test-product-flagged',
  moderationStatus: 'FLAGGED',
  moderationFlags: [
    { name: 'Suggestive', parent: '', confidence: 72.4 },
    { name: 'Revealing Clothes', parent: 'Suggestive', confidence: 68.1 },
  ],
  altText: 'Imagen de producto que muestra: Clothing, Swimwear.',
};

export const mockProductInput = {
  name: 'Camisa Blanca Clásica',
  description: 'Camisa blanca elegante perfecta para cualquier ocasión',
  price: 49.99,
  category: 'Ropa',
  stock: 25,
  imageUrl: 'https://public-data-669070217575.s3.us-east-1.amazonaws.com/white-shirt.jpg',
};
