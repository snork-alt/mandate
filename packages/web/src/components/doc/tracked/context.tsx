import { createContext, useContext, type ReactNode } from 'react';
import type { ValueChange } from '@mandate/doc';

/** Frontmatter changes of the version being viewed, by field name (empty when not tracking). */
export const TrackedFieldsContext = createContext<Map<string, ValueChange>>(new Map());

export function useFieldChange(field: string): ValueChange | undefined {
  return useContext(TrackedFieldsContext).get(field);
}

/** Render a scalar field; when it changed in the viewed version, show ~~old~~ new. */
export function TrackedValue<T>({ field, value, render }: { field: string; value: T; render: (v: T) => ReactNode }) {
  const change = useFieldChange(field);
  if (!change) return <>{render(value)}</>;
  const has = (v: unknown) => v !== undefined && v !== null && v !== '';
  // One line: old (muted, struck through) → new (green). No boxes.
  return (
    <span className="tc-field tc-mark">
      {has(change.before) && <del className="tc-old">{render(change.before as T)}</del>}
      {has(change.before) && has(change.after) && <span className="tc-arrow">→</span>}
      {has(change.after) && <ins className="tc-new">{render(change.after as T)}</ins>}
    </span>
  );
}

/** Render a list field; added items are marked green, removed ones stay in red strikethrough. */
export function TrackedList<T>({
  field,
  items,
  render,
  empty,
}: {
  field: string;
  items: T[];
  render: (item: T, mark?: 'added' | 'removed') => ReactNode;
  empty?: ReactNode;
}) {
  const change = useFieldChange(field);
  const key = (x: unknown) => JSON.stringify(x);
  const addedKeys = new Set((change?.addedItems ?? []).map(key));
  const removed = (change?.removedItems ?? []) as T[];
  if (!items.length && !removed.length) return <>{empty ?? null}</>;
  return (
    <>
      {items.map((it) => (
        <span key={`i${key(it)}`} className={addedKeys.has(key(it)) ? 'tc-item tc-item-added tc-mark' : 'tc-item'}>
          {render(it, addedKeys.has(key(it)) ? 'added' : undefined)}
        </span>
      ))}
      {removed.map((it) => (
        <span key={`r${key(it)}`} className="tc-item tc-item-removed tc-mark">
          {render(it, 'removed')}
        </span>
      ))}
    </>
  );
}

export function TrackedFieldsProvider({ changes, children }: { changes: ValueChange[] | undefined; children: ReactNode }) {
  return <TrackedFieldsContext.Provider value={new Map((changes ?? []).map((c) => [c.key, c]))}>{children}</TrackedFieldsContext.Provider>;
}
