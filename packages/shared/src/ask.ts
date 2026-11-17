/** A reference as checked / resolved for display (the reference chips of the web UI). */
export interface ReferenceCheck {
  ref: string;
  resolved: boolean;
  /** Node kind and label when resolved. */
  kind?: string;
  label?: string;
  /** Why it did not resolve (shown on the chip, never hidden). */
  error?: string;
}
