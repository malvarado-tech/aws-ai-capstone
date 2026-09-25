import { ShoppingCart, Package, Sparkles } from 'lucide-react';
import type { Product } from '../lib/types';

interface ProductCardProps {
  product: Product;
  language?: 'es' | 'en';
  onEdit?: (product: Product) => void;
  onDelete?: (productId: string) => void;
  isAdmin?: boolean;
  /**
   * Abre el panel de IA de este producto. Opcional: si no se pasa, la tarjeta no
   * muestra el botón y queda igual que antes (así los tests existentes y
   * cualquier uso sin IA siguen valiendo).
   */
  onShowAI?: (product: Product) => void;
}

export function ProductCard({
  product,
  language = 'es',
  onEdit,
  onDelete,
  isAdmin,
  onShowAI,
}: ProductCardProps) {
  // Get translated text if available, otherwise fall back to default
  const getName = () => {
    if (language === 'en' && product.translations?.en?.name) {
      return product.translations.en.name;
    }
    if (language === 'es' && product.translations?.es?.name) {
      return product.translations.es.name;
    }
    return product.name;
  };

  const getDescription = () => {
    if (language === 'en' && product.translations?.en?.description) {
      return product.translations.en.description;
    }
    if (language === 'es' && product.translations?.es?.description) {
      return product.translations.es.description;
    }
    return product.description;
  };

  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden transition-all duration-300 hover:shadow-xl hover:scale-105">
      <div className="aspect-square overflow-hidden bg-gray-100">
        <img
          src={product.imageUrl}
          // S02 (Rekognition) genera `altText`: una descripción de lo que la imagen
          // MUESTRA ("Imagen de producto que muestra: Clothing, Shirt, Sleeve").
          // El nombre del producto no describe la imagen, sólo la nombra, así que
          // quien usa lector de pantalla no se entera de qué está viendo. Preferir
          // el alt descriptivo es el entregable de accesibilidad de esa sesión y
          // entra por el dominio de IA responsable / inclusión del AIF-C01.
          // Fallback al nombre: `altText` es opcional y sólo existe si se corrió S02.
          alt={product.altText || getName()}
          className="w-full h-full object-cover"
        />
      </div>
      <div className="p-5">
        <div className="flex items-start justify-between mb-2">
          <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">
            {getName()}
          </h3>
          <span className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
            {product.category}
          </span>
        </div>
        <p className="text-gray-600 text-sm mb-4 line-clamp-2">
          {getDescription()}
        </p>
        <div className="flex items-center justify-between mb-4">
          <span className="text-2xl font-bold text-gray-900">
            ${product.price.toFixed(2)}
          </span>
          <div className="flex items-center gap-1 text-sm text-gray-500">
            <Package className="w-4 h-4" />
            <span>{product.stock} disponibles</span>
          </div>
        </div>
        {onShowAI && (
          <button
            onClick={() => onShowAI(product)}
            className="w-full mb-2 flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
          >
            <Sparkles className="w-4 h-4" aria-hidden="true" />
            Ver IA
          </button>
        )}
        {isAdmin ? (
          <div className="flex gap-2">
            <button
              onClick={() => onEdit?.(product)}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              Editar
            </button>
            <button
              onClick={() => onDelete?.(product.productId)}
              className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium"
            >
              Eliminar
            </button>
          </div>
        ) : (
          <button
            disabled={product.stock === 0}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              product.stock === 0
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            <ShoppingCart className="w-4 h-4" />
            {product.stock === 0 ? 'Agotado' : 'Agregar al Carrito'}
          </button>
        )}
      </div>
    </div>
  );
}
