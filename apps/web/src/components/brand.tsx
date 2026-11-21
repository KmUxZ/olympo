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
