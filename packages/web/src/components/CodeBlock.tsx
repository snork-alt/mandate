import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { IconAt, IconChevronDown, IconCopy } from '@tabler/icons-react';
import { copyText } from '../lib/copy';
import { blockReference, useDocSource } from './doc/DocSourceContext';

interface Props {
  code: string;
  lang?: string;
  /** Show line numbers (default: for blocks longer than 5 lines). */
  lineNumbers?: boolean;
  /** Hide the language label (e.g. when the context already says it). */
  bare?: boolean;
}

/** Code block with lazy Shiki highlighting, language label, hover copy button and optional line numbers. */
export function CodeBlock({ code, lang = '', lineNumbers, bare }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const doc = useDocSource();
  const sectionId = () => box.current?.closest<HTMLElement>('[data-section-id]')?.dataset.sectionId;
  // Default copy = the Mandate reference to this block (section + fence lines); the code itself is secondary.
  const copyRef = async () => {
    const sid = sectionId();
    if (doc && sid) await copyText(await blockReference(doc, sid, text));
    else await copyText(text, 'Copied code');
  };
  const text = code.replace(/\n$/, '');
  const numbered = lineNumbers ?? text.split('\n').length > 5;

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    import('../lib/highlight')
      .then((m) => m.highlightToHtml(text, lang))
      .then((h) => !cancelled && setHtml(h))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [text, lang]);

  return (
    <div className="code-block" data-numbered={numbered || undefined} ref={box}>
      {!bare && lang && <span className="code-lang">{lang}</span>}
      <span className="code-copy">
        <Tooltip label={doc ? 'Copy reference to this code block (@mandate:…#L…)' : 'Copy code'}>
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => void copyRef()} aria-label="Copy reference">
            {doc ? <IconAt size={13} /> : <IconCopy size={13} />}
          </ActionIcon>
        </Tooltip>
        <Menu position="bottom-end" withinPortal width={200}>
          <Menu.Target>
            <ActionIcon size="xs" variant="subtle" color="gray" aria-label="More copy options">
              <IconChevronDown size={12} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void copyRef()}>
              Copy reference
            </Menu.Item>
            <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => void copyText(text, 'Copied code')}>
              Copy code
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </span>
      {html ? (
        <div className="code-shiki" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-plain">
          <code>
            {text.split('\n').map((l, i) => (
              <span key={i} className="line">
                {l}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  );
}
