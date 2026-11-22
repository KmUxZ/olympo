// Athena · lo que Athena sabe: catálogo de productos y preguntas frecuentes. No responde nada que no esté aquí o en los ajustes.
import { useState } from 'react';
import { api, useApi } from '../../lib/api';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, PageHero } from '../../components/ui';

interface Product { id: string; name: string; description: string; price: number; offers: string; active: boolean }
interface Faq { id: string; question: string; answer: string; active: boolean }
const money = (n: number) => `$${n.toLocaleString('es-CO')}`;

export function AthenaCatalog() {
  const products = useApi<{ products: Product[] }>('/api/athena/products');
  const faqs = useApi<{ items: Faq[] }>('/api/athena/knowledge');
  const [product, setProduct] = useState<Product | 'new' | null>(null);
  const [faq, setFaq] = useState<Faq | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = products.data?.products ?? [];
  const items = faqs.data?.items ?? [];

  async function remove(path: string, label: string, reload: () => Promise<unknown>) {
    if (!window.confirm(`¿Quitar ${label}? Athena dejará de usarlo.`)) return;
    setError(null);
    try {
      await api('DELETE', path);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHero
        tone="athena"
        title="Catálogo y respuestas"
        subtitle="Todo lo que Athena puede decirle a un cliente sale de aquí. Lo que no esté escrito, lo pasa a una persona."
        kpis={[{ label: 'Productos activos', value: list.filter((p) => p.active).length }, { label: 'Preguntas frecuentes', value: items.filter((f) => f.active).length }]}
      />
      <ErrorNote error={error ?? products.error ?? faqs.error} />

      <div className="card">
        <div className="card-head"><h3>Productos</h3><button className="btn primary sm" onClick={() => setProduct('new')}>Añadir producto</button></div>
        {!products.data ? <Loading /> : list.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Producto</th><th>Precio</th><th>Ofertas</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td style={{ maxWidth: 380 }}><strong>{p.name}</strong><span className="sub">{p.description || 'Sin descripción'}</span></td>
                    <td className="nowrap">{money(p.price)}</td>
                    <td style={{ maxWidth: 260 }}>{p.offers || <span className="muted">—</span>}</td>
                    <td>{p.active ? <Badge tone="ok">Athena lo ofrece</Badge> : <Badge>Oculto</Badge>}</td>
                    <td className="nowrap"><button className="btn sm" onClick={() => setProduct(p)}>Editar</button> <button className="btn sm ghost" onClick={() => void remove(`/api/athena/products/${p.id}`, `«${p.name}»`, products.reload)}>Quitar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Sin productos. Athena no puede ofrecer ni dar precios hasta que cargues al menos uno.</Empty>}
      </div>

      <div className="card">
        <div className="card-head"><h3>Preguntas frecuentes</h3><button className="btn primary sm" onClick={() => setFaq('new')}>Añadir pregunta</button></div>
        {!faqs.data ? <Loading /> : items.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Cuando pregunten</th><th>Athena responde</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {items.map((f) => (
                  <tr key={f.id}>
                    <td style={{ maxWidth: 300 }}><strong>{f.question}</strong></td>
                    <td style={{ maxWidth: 460 }}>{f.answer}</td>
                    <td>{f.active ? <Badge tone="ok">Activa</Badge> : <Badge>Oculta</Badge>}</td>
                    <td className="nowrap"><button className="btn sm" onClick={() => setFaq(f)}>Editar</button> <button className="btn sm ghost" onClick={() => void remove(`/api/athena/knowledge/${f.id}`, 'esta pregunta', faqs.reload)}>Quitar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Sin preguntas frecuentes. Añade las dudas que más se repiten: tallas, garantía, cómo se usa, tiempos.</Empty>}
      </div>

      {product && <ProductModal product={product === 'new' ? null : product} onClose={() => setProduct(null)} onSaved={async () => { setProduct(null); await products.reload(); }} />}
      {faq && <FaqModal faq={faq === 'new' ? null : faq} onClose={() => setFaq(null)} onSaved={async () => { setFaq(null); await faqs.reload(); }} />}
    </>
  );
}

function ProductModal({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ name: product?.name ?? '', description: product?.description ?? '', price: product ? String(product.price) : '', offers: product?.offers ?? '', active: product?.active ?? true });
  async function save() {
    const body = { ...f, price: Math.max(0, Math.round(Number(f.price) || 0)) };
    await (product ? api('PUT', `/api/athena/products/${product.id}`, body) : api('POST', '/api/athena/products', body));
    await onSaved();
  }
  return (
    <FormModal title={product ? 'Editar producto' : 'Añadir producto'} onClose={onClose} onSubmit={save}>
      <div className="row">
        <div className="grow" style={{ flex: 2 }}><Field label="Nombre"><input required minLength={2} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
        <div className="grow"><Field label="Precio"><input required type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field></div>
      </div>
      <Field label="Descripción" hint="Para qué sirve, tallas, colores, qué incluye. Athena lo usa tal cual para responder.">
        <textarea maxLength={1000} rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <Field label="Ofertas (opcional)" hint="Ej.: 2 por $170.000 · 3 por $240.000. Athena no ofrece descuentos que no estén aquí.">
        <input maxLength={600} value={f.offers} onChange={(e) => setF({ ...f, offers: e.target.value })} />
      </Field>
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Athena puede ofrecerlo</label>
    </FormModal>
  );
}

function FaqModal({ faq, onClose, onSaved }: { faq: Faq | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ question: faq?.question ?? '', answer: faq?.answer ?? '', active: faq?.active ?? true });
  async function save() {
    await (faq ? api('PUT', `/api/athena/knowledge/${faq.id}`, f) : api('POST', '/api/athena/knowledge', f));
    await onSaved();
  }
  return (
    <FormModal title={faq ? 'Editar pregunta' : 'Añadir pregunta'} onClose={onClose} onSubmit={save}>
      <Field label="Cuando pregunten"><input required minLength={3} maxLength={300} value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} placeholder="Ej.: ¿Tiene garantía?" /></Field>
      <Field label="Athena responde"><textarea required minLength={2} maxLength={1500} rows={4} value={f.answer} onChange={(e) => setF({ ...f, answer: e.target.value })} /></Field>
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Activa</label>
    </FormModal>
  );
}
