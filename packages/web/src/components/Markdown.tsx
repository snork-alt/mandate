import { lazy, Suspense } from 'react';
import { Skeleton, Typography } from '@mantine/core';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import { withBase } from '../project';
import { MCP_SERVER_NAME, parseNodeUri } from '@mandate/shared/refs';
import { RefChip } from './refs/RefChip';
import { KindIcon } from './refs/KindIcon';
import { looksLikeFilePath } from '../lib/filePath';

const SCHEME = `${MCP_SERVER_NAME}://`;
const BARE = new RegExp(`(^|[\\s(,;])(${MCP_SERVER_NAME}:\\/\\/[A-Za-z0-9._~/@:-]*[A-Za-z0-9_/-])`, 'g');

/** Mandate references survive react-markdown's URL sanitising (they render as reference chips). */
const keepRefs = (url: string) => (url.startsWith(SCHEME) ? url : defaultUrlTransform(url));

/** Bare references in prose (`… see mandate-URI f1`) become autolinks, rendered as reference chips; code is left alone. */
export function linkBareRefs(md: string): string {
  if (!md.includes(SCHEME)) return md;
  return md
    .split(/(^```[\s\S]*?^```)/m)
    .map((part) => (part.startsWith('```') ? part : part.split(/(`[^`\n]*`)/).map((x) => (x.startsWith('`') ? x : x.replace(BARE, (_m, pre: string, uri: string) => `${pre}<${uri}>`))).join('')))
    .join('');
}

const MermaidBlock = lazy(() => import('./doc/MermaidBlock').then((m) => ({ default: m.MermaidBlock })));

export const markdownComponents: Components = {
  a: ({ href, children, node: _node, ...rest }) => {
    if (href?.startsWith(SCHEME) && parseNodeUri(href)) return <RefChip to={href} />;
    const external = href ? /^https?:\/\//.test(href) : false;
    return (
      <a href={href && !external ? withBase(href) : href} {...rest} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
        {children}
      </a>
    );
  },
  // Inline code that names a file gets the code-file icon (still plain code text, no link).
  code: ({ children, node: _node, className, ...rest }) => {
    const text = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null;
    const inline = !className && text !== null && !text.includes('\n');
    if (!inline || !looksLikeFilePath(text)) return <code className={className} {...rest}>{children}</code>;
    return (
      <code {...rest} className="md-file-code">
        <KindIcon kind="code_file" size={12} />
        {children}
      </code>
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={keepRefs}>
        {linkBareRefs(children)}
      </ReactMarkdown>
    </Typography>
  );
}
