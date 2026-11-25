// Marcas de OLYMPO y Argos dibujadas a partir de la "Propuesta visual 01".
// Son una aproximación en SVG: cuando existan los logotipos oficiales exportados, se sustituyen aquí
// (este archivo es el único lugar donde se dibujan).

/** Isotipo de Argos: obturador en el teal del producto. */
export function ArgosMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="11" fill="var(--brand-teal)" />
      <g stroke="#fff" strokeWidth="1.7" strokeLinecap="round" fill="none">
        <path d="m14.31 8 4.9 8.5" />
        <path d="M9.69 8h9.8" />
        <path d="m7.38 12 4.9-8.5" />
        <path d="M9.69 16 4.79 7.5" />
        <path d="M14.31 16H4.5" />
        <path d="m16.62 12-4.9 8.5" />
      </g>
    </svg>
  );
}

/** Isotipo de OLYMPO: cumbre dentro de un anillo, en el azul del ecosistema. */
export function OlympoMark({ size = 28, color = 'var(--brand-blue)' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M9.5 39.5A20 20 0 1 1 38.5 39.5" fill="none" stroke={color} strokeWidth="6.5" strokeLinecap="butt" />
      <path d="M6 42 18 27l5 5 6-9 13 19z" fill={color} />
    </svg>
  );
}

export function ArgosLogo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo">
      <ArgosMark size={size} />
      <span className="logo-word">Argos</span>
    </span>
  );
}

export function OlympoLogo({ size = 28, color }: { size?: number; color?: string }) {
  return (
    <span className="logo">
      <OlympoMark size={size} color={color} />
      <span className="logo-word">Olympo</span>
    </span>
  );
}

/** Isotipo de Hermes: alas en movimiento, en el azul del ecosistema. */
export function HermesMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="var(--brand-blue)">
        <path d="M9 4h13l-2.4 4H6.6z" />
        <path d="M5.4 10h11.2l-2.4 4H3z" />
        <path d="M6.6 16h7.2l-2.4 4H4.2z" />
      </g>
    </svg>
  );
}

/** Marca provisional de Athena: un escudo con una chispa, hasta tener el logo oficial. */
export function AthenaMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="var(--brand-violet)" />
      <path d="M12 6.5 13.4 10.6 17.5 12 13.4 13.4 12 17.5 10.6 13.4 6.5 12 10.6 10.6z" fill="#fff" />
    </svg>
  );
}

/** Marca provisional de Zeus: un rayo, hasta tener el logo oficial. */
export function ZeusMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--brand-gold)" />
      <path d="M13.2 4.5 7 13h4l-1.2 6.5L17 11h-4.3z" fill="#fff" />
    </svg>
  );
}

/** Catálogo de productos del ecosistema: nombre, lema, marca y a dónde lleva cada uno. */
export const PRODUCT_INFO: Record<string, { name: string; tagline: string; home: string; available: boolean; /** en pausa para el público: no se ofrece ni se muestra a quien no lo tiene */ internal?: boolean; Mark: (p: { size?: number }) => React.JSX.Element }> = {
  argos: { name: 'Argos', tagline: 'Equipo', home: '/', available: true, Mark: ArgosMark },
  hermes: { name: 'Hermes', tagline: 'Logística', home: '/hermes/pedidos', available: true, Mark: HermesMark },
  zeus: { name: 'Zeus', tagline: 'Clientes', home: '/zeus', available: true, internal: true, Mark: ZeusMark },
  athena: { name: 'Athena', tagline: 'Vendedora IA', home: '/athena/conversaciones', available: true, Mark: AthenaMark },
};
