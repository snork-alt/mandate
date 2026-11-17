import { Fragment } from 'react';

/** Text with `backticked` parts rendered as <code>. */
export function Ticks({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) => (
        <Fragment key={i}>{i % 2 ? <code>{part}</code> : part}</Fragment>
      ))}
    </>
  );
}
