export const APP_NAME = 'Mandate';

/** Mandate brand mark (served from public/logo.svg). */
export function Logo({ size = 22 }: { size?: number }) {
  return <img src="/logo.svg?v=seal" width={size} height={size} alt="" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }} />;
}
