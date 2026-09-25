import type { Product } from './types';

// Runtime environment configuration (injected at deployment time)
//
// Cada Lambda de IA tiene SU PROPIA Function URL, en otro host: no son rutas
// bajo VITE_API_URL. Por eso hay una clave por sesión. El inyector las escribe
// desde los Outputs del stack; si una falta, el cliente de `ai.ts` deshabilita
// esa capacidad en la UI en lugar de fallar.
// Ver docs/RUNTIME_CONFIG.md — sólo URLs públicas acá, nunca claves.
declare global {
  interface Window {
    __ENV?: {
      VITE_API_URL?: string;
      VITE_ENRICH_LABELS_URL?: string;      // S1
      VITE_MODERATE_IMAGE_URL?: string;     // S2
      VITE_ANALYZE_SENTIMENT_URL?: string;  // S3
      VITE_TRANSLATE_CATALOG_URL?: string;  // S4
      VITE_SYNTHESIZE_VOICE_URL?: string;   // S5
      VITE_GENERATE_DESCRIPTION_URL?: string; // S6
      VITE_INDEX_EMBEDDINGS_URL?: string;   // S7 (indexador)
      VITE_SEMANTIC_SEARCH_URL?: string;    // S7 (búsqueda)
      VITE_SHOPPING_ASSISTANT_URL?: string; // S8
    };
  }
}

// Get API URL from runtime config (priority) or build-time env variable
// Priority: window.__ENV (runtime) > import.meta.env (build-time) > fallback
//
// En el sandbox AWS re/Start NO hay API Gateway: la base es una Lambda Function
// URL (https://<id>.lambda-url.<region>.on.aws/). Esa URL termina en '/', así que
// la normalizamos quitando el slash final para que `${API_URL}/products` no genere
// un doble slash. (El router tolera el doble slash igual, pero mantenemos URLs limpias.)
const RAW_API_URL =
  window.__ENV?.VITE_API_URL ||
  import.meta.env.VITE_API_URL ||
  'https://your-function-url-id.lambda-url.us-east-1.on.aws';

const API_URL = RAW_API_URL.replace(/\/+$/, '');

// Log the API URL for debugging (only in development)
if (import.meta.env.DEV) {
  console.log('API URL:', API_URL);
  console.log('Runtime config:', window.__ENV);
  console.log('Build-time config:', import.meta.env.VITE_API_URL);
}

export const api = {
  // List all products
  async listProducts(): Promise<Product[]> {
    const response = await fetch(`${API_URL}/products`);
    if (!response.ok) {
      throw new Error(`Error ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    // API returns {products: [...]}
    return data.products || [];
  },

  // Get a single product
  async getProduct(productId: string): Promise<Product> {
    const response = await fetch(`${API_URL}/products/${productId}`);
    if (!response.ok) {
      throw new Error(`Error ${response.status}: ${response.statusText}`);
    }
    return response.json();
  },

  // Create a new product
  async createProduct(product: Omit<Product, 'productId' | 'createdAt' | 'updatedAt'>): Promise<Product> {
    const response = await fetch(`${API_URL}/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(product),
    });

    if (!response.ok) {
      throw new Error(`Error ${response.status}: ${response.statusText}`);
    }

    return response.json();
  },

  // Update a product
  async updateProduct(
    productId: string,
    updates: Partial<Omit<Product, 'productId' | 'createdAt' | 'updatedAt'>>
  ): Promise<Product> {
    const response = await fetch(`${API_URL}/products/${productId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      throw new Error(`Error ${response.status}: ${response.statusText}`);
    }

    return response.json();
  },

  // Delete a product
  async deleteProduct(productId: string): Promise<void> {
    const response = await fetch(`${API_URL}/products/${productId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`Error ${response.status}: ${response.statusText}`);
    }
  },
};
