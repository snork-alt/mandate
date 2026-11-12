import { lazy, Suspense } from 'react';
import { Skeleton, Typography } from '@mantine/core';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import { withBase } from '../project';

const MermaidBlock = lazy(() => import('./doc/MermaidBlock').then((m) => ({ default: m.MermaidBlock })));

export const markdownComponents: Components = {
  a: ({ href, children, node: _node, ...rest }) => {
    const external = href ? /^https?:\/\//.test(href) : false;
    return (
      <a href={href && !external ? withBase(href) : href} {...rest} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
        {children}
      </a>
    );
  },
  // ```mermaid fences inside markdown render as diagrams too.
  pre: ({ children, node, ...rest }) => {
    const code = node?.children[0];
    const cls = code && code.type === 'element' ? (code.properties.className as string[] | undefined) : undefined;
    if (cls?.includes('language-mermaid') && code?.type === 'element') {
      const text = code.children.map((c) => (c.type === 'text' ? c.value : '')).join('');
      return (
        <Suspense fallback={<Skeleton height={160} radius="md" />}>
          <MermaidBlock code={text.replace(/\n$/, '')} />
        </Suspense>
      );
    }
    // Tracked-changes code blocks carry their own line marks: keep them as-is.
    const cls2 = (rest as { className?: string }).className ?? '';
    if (cls2.includes('tc-code') || code?.type !== 'element' || code.tagName !== 'code') return <pre {...rest}>{children}</pre>;
    const lang = (cls ?? []).find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
    const text = code.children.map((c) => (c.type === 'text' ? c.value : '')).join('');
    return <CodeBlock code={text} lang={lang} />;
  },
};

/** GitHub-flavoured markdown rendered with Mantine typography styles. */
export function Markdown({ children }: { children: string }) {
  return (
    <Typography className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </Typography>
  );
}
