import { useEffect, useRef, useState } from 'react';
import { SearchField } from './SearchField';

/**
 * List-page filter box: the shared SearchField at a fixed width. The text is local state: list pages keep the query
 * in the URL, and a controlled input fed back from the URL drops keystrokes while the router catches up.
 */
export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value);
  /** Values we sent that the URL may still echo back (in order); the last one is the current text. */
  const pending = useRef<string[]>([]);
  useEffect(() => {
    const i = pending.current.indexOf(value);
    if (i >= 0) {
      // An echo of our own update: drop it and everything older.
      pending.current = pending.current.slice(i + 1);
      return;
    }
    // An outside change (back/forward, a cleared filter) wins.
    pending.current = [];
    setText(value);
  }, [value]);
  const change = (v: string) => {
    setText(v);
    pending.current.push(v);
    onChange(v);
  };
  return <SearchField variant="input" value={text} onChange={change} placeholder={placeholder} ariaLabel={placeholder} className="list-search" />;
}
