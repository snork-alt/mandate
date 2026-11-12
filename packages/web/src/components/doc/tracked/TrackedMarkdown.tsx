import { Typography } from '@mantine/core';
import type { Root } from 'mdast';
import ReactMarkdown from 'react-markdown';
import { markdownComponents } from '../../Markdown';

/** Render a pre-built (tracked-changes) mdast tree with the normal markdown typography. */
export function TrackedMarkdown({ tree }: { tree: Root }) {
  // The plugin replaces the (empty) parsed document with our merged tree.
  const usePrebuilt = () => () => structuredClone(tree);
  return (
    <Typography className="markdown">
      <ReactMarkdown remarkPlugins={[usePrebuilt]} components={markdownComponents}>
        {''}
      </ReactMarkdown>
    </Typography>
  );
}
