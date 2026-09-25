import { useState } from 'react';
import { Store, Settings, Search, Plus, Loader2, Globe, MessageCircle, X } from 'lucide-react';
import { ProductCard } from './components/ProductCard';
import { ProductModal } from './components/ProductModal';
import { ProductAIPanel } from './components/ProductAIPanel';
import { ProductAudio } from './components/ProductAudio';
import { SentimentPanel } from './components/SentimentPanel';
import { SemanticSearch } from './components/SemanticSearch';
import { ShoppingAssistant } from './components/ShoppingAssistant';
import { AdminAIOps } from './components/AdminAIOps';
import { useProducts } from './hooks/useProducts';
import type { Product } from './lib/types';

function App() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [language, setLanguage] = useState<'es' | 'en'>('es');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | undefined>();
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('Todos');

  // ---- Estado de las capacidades de IA ----
  // `aiProductId` y no el producto entero: después de un enriquecimiento hacemos
  // refetch y el objeto cambia de identidad. Guardando el id, el panel siempre
  // lee la versión fresca de `products`.
  const [aiProductId, setAiProductId] = useState<string | undefined>();
  const [isChatOpen, setIsChatOpen] = useState(false);

  const {
    products,
    loading,
    error,
    createProduct,
    updateProduct,
    deleteProduct,
    refetch,
  } = useProducts();

  const aiProduct = products.find((p) => p.productId === aiProductId);

  const handleSaveProduct = async (productData: Omit<Product, 'productId' | 'createdAt' | 'updatedAt'>) => {
    if (editingProduct) {
      const result = await updateProduct(editingProduct.productId, productData);
      if (result.success) {
        setEditingProduct(undefined);
      } else {
        alert(result.error);
      }
    } else {
      const result = await createProduct(productData);
      if (!result.success) {
        alert(result.error);
      }
    }
  };

  const handleEdit = (product: Product) => {
    setEditingProduct(product);
    setIsModalOpen(true);
  };

  const handleDelete = async (productId: string) => {
    if (confirm('¿Estás seguro de que deseas eliminar este producto?')) {
      const result = await deleteProduct(productId);
      if (!result.success) {
        alert(result.error);
      }
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingProduct(undefined);
  };

  const handleShowAI = (product: Product) => {
    setAiProductId(product.productId);
  };

  // Cualquier escritura de una Lambda de IA en DynamoDB (etiquetas, moderación,
  // descripción, sentimiento, audio) se refleja recién después de releer el
  // catálogo: el hook parchea el cache local sólo en el CRUD, no en los
  // enriquecimientos.
  const handleEnriched = () => {
    refetch();
  };

  const filteredProducts = products.filter((product) => {
    // El filtro incluye el texto TRADUCIDO además del original. Antes sólo
    // miraba product.name/description, así que en modo EN el usuario escribía lo
    // que estaba leyendo en pantalla y no encontraba nada.
    const haystack = [
      product.name,
      product.description,
      product.translations?.es?.name,
      product.translations?.es?.description,
      product.translations?.en?.name,
      product.translations?.en?.description,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();

    const matchesSearch = haystack.includes(searchTerm.toLowerCase());
    const matchesCategory = categoryFilter === 'Todos' || product.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-blue-600 p-2 rounded-lg">
                <Store className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">TechModa</h1>
                <p className="text-sm text-gray-500">Catálogo de Productos</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Language Toggle */}
              <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg">
                <Globe className="w-4 h-4 text-gray-600" />
                <button
                  onClick={() => setLanguage('es')}
                  className={`px-3 py-1 rounded font-medium transition-colors ${
                    language === 'es'
                      ? 'bg-blue-600 text-white'
                      : 'bg-transparent text-gray-600 hover:text-gray-900'
                  }`}
                >
                  ES
                </button>
                <button
                  onClick={() => setLanguage('en')}
                  className={`px-3 py-1 rounded font-medium transition-colors ${
                    language === 'en'
                      ? 'bg-blue-600 text-white'
                      : 'bg-transparent text-gray-600 hover:text-gray-900'
                  }`}
                >
                  EN
                </button>
              </div>
              {/* S08 · Asistente de compras (RAG sobre Bedrock) */}
              <button
                onClick={() => setIsChatOpen(!isChatOpen)}
                aria-expanded={isChatOpen}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                  isChatOpen
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <MessageCircle className="w-4 h-4" aria-hidden="true" />
                Asistente
              </button>
              {/* Admin Toggle */}
              <button
                onClick={() => setIsAdmin(!isAdmin)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                  isAdmin
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <Settings className="w-4 h-4" />
                {isAdmin ? 'Modo Admin' : 'Modo Cliente'}
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8 space-y-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                placeholder="Buscar productos..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-4 py-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              <option value="Todos">Todas las Categorías</option>
              <option value="Ropa">Ropa</option>
              <option value="Zapatos">Zapatos</option>
              <option value="Accesorios">Accesorios</option>
            </select>
          </div>

          {/* S07 · Búsqueda semántica. Vive al lado del filtro por texto a
              propósito: el de arriba compara substrings, este compara SIGNIFICADO
              vía embeddings, y ver los dos juntos es el punto didáctico. */}
          <SemanticSearch onSelectProduct={setAiProductId} />

          {isAdmin && (
            <button
              onClick={() => setIsModalOpen(true)}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-md"
            >
              <Plus className="w-5 h-5" />
              Agregar Nuevo Producto
            </button>
          )}

          {/* S07 · Indexador. Sólo en modo admin: reescribe el embedding de TODOS
              los productos y es prerequisito de la búsqueda y del asistente. */}
          {isAdmin && <AdminAIOps onIndexed={handleEnriched} />}
        </div>

        {loading ? (
          <div role="status" aria-live="polite" className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" aria-hidden="true" />
            <span className="sr-only">Cargando productos…</span>
          </div>
        ) : error ? (
          <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
            Error: {error}
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="text-center py-20">
            <Store className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-gray-600 mb-2">
              No se encontraron productos
            </h3>
            <p className="text-gray-500">
              {searchTerm || categoryFilter !== 'Todos'
                ? 'Intenta ajustar los filtros de búsqueda'
                : 'Agrega productos para comenzar'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredProducts.map((product) => (
              <ProductCard
                key={product.productId}
                product={product}
                language={language}
                isAdmin={isAdmin}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onShowAI={handleShowAI}
              />
            ))}
          </div>
        )}
      </main>

      <ProductModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        onSave={handleSaveProduct}
        product={editingProduct}
      />

      {/* Todas las capacidades por producto en UN modal: S01 etiquetas, S02
          moderación + alt-text y S06 descripción los trae ProductAIPanel; S05
          audio y S03 sentimiento entran como children. */}
      {aiProduct && (
        <ProductAIPanel
          product={aiProduct}
          isOpen={true}
          onClose={() => setAiProductId(undefined)}
          onEnriched={handleEnriched}
        >
          <ProductAudio product={aiProduct} />
          <SentimentPanel product={aiProduct} onAnalyzed={handleEnriched} />
        </ProductAIPanel>
      )}

      {/* S08 · Asistente. Panel lateral fijo para que el catálogo siga visible
          mientras el modelo recomienda: las citas de `retrieved` abren el
          producto real. */}
      {isChatOpen && (
        <aside
          aria-label="Asistente de compras"
          className="fixed bottom-0 right-0 z-40 w-full sm:w-[420px] sm:bottom-4 sm:right-4 max-h-[85vh] overflow-y-auto bg-white rounded-t-lg sm:rounded-lg shadow-xl border border-gray-200"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <h2 className="font-semibold text-gray-900">Asistente TechModa</h2>
            <button
              onClick={() => setIsChatOpen(false)}
              aria-label="Cerrar asistente"
              className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
          <div className="p-4">
            <ShoppingAssistant onSelectProduct={setAiProductId} />
          </div>
        </aside>
      )}

      <footer className="bg-white border-t mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-center text-gray-500 text-sm">
            TechModa © 2024 - E-commerce de Moda Serverless
          </p>
        </div>
      </footer>
    </div>
  );
}

export default App;
