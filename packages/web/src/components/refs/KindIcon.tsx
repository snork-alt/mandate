import type { NodeKind } from '@mandate/shared';
import { KIND_ICON } from './kinds';
import './kind-icon.css';

/** The one icon for a Mandate object type (KIND_ICON), with the shared size, stroke and dimmed colour. */
export function KindIcon({ kind, size = 14, className, label }: { kind: NodeKind; size?: number; className?: string; label?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={size} stroke={1.6} className={`kind-icon${className ? ` ${className}` : ''}`} data-kind={kind} aria-hidden={label ? undefined : true} aria-label={label} />;
}
