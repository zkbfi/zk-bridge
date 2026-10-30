/** The zkb.fi mark (v12), drawn in the current text colour. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="butt" strokeLinejoin="miter"><path d="M18.76 42.26 A19 19 0 0 1 24.00 5.00" /><path d="M40.20 14.07 A19 19 0 0 1 37.44 37.44" /></g><circle cx="36.83" cy="9.99" r="2.1" fill="currentColor" /><circle cx="24.00" cy="43.00" r="2.1" fill="currentColor" /><g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="butt" strokeLinejoin="miter"><path d="M1 29 H42.33" /><path d="M24 11 V29" /><path d="M24 25.5 L27.39 21.41" /><path d="M24 25.5 L28 29" /><path d="M31 11 V29" /><path d="M31 21 H32 A4 4 0 0 1 32 29" /></g><polygon fill="currentColor" points="12.55,19.50 21.55,19.50 21.55,23.35 18.12,27.50 14.22,27.50 18.36,22.50 12.55,22.50" />
    </svg>
  );
}
