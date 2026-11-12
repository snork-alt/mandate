import { createContext, useContext } from 'react';
import type { Audit } from '@mandate/shared';

/** The derived view of the audit page (joined work-order / feedback links, staleness) for the audit-item renderer. */
export const AuditViewContext = createContext<Audit | null>(null);
export const useAuditView = () => useContext(AuditViewContext);
