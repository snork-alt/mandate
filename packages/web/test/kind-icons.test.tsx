// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { installDom, Wrap } from './dom';
import { looksLikeFilePath } from '../src/lib/filePath';
import { Markdown } from '../src/components/Markdown';

installDom();
afterEach(cleanup);

describe('looksLikeFilePath', () => {
  it('accepts file names and paths', () => {
    for (const t of ['kyc.test.ts', 'src/lib/a.go', 'pkg/x.py:10-20', 'README.md', 'config/app.yaml', 'web/src/x.vue']) expect(looksLikeFilePath(t), t).toBe(true);
  });
  it('rejects code that is not a path', () => {
    for (const t of ['foo()', 'a.b', 'npm run build', 'https://x.io/a.ts', 'e.g.', 'x = 1', 'v1.2']) expect(looksLikeFilePath(t), t).toBe(false);
  });
});

describe('Markdown inline code', () => {
  it('prefixes file paths with the code-file icon and leaves other code alone', () => {
    const { container } = render(
      <Wrap>
        <Markdown>{'Tests live in `kyc.test.ts`; call `verify()`.'}</Markdown>
      </Wrap>,
    );
    const codes = [...container.querySelectorAll('code')];
    expect(codes.map((c) => c.textContent)).toEqual(['kyc.test.ts', 'verify()']);
    expect(codes[0]!.querySelector('.kind-icon[data-kind="code_file"]')).not.toBeNull();
    expect(codes[1]!.querySelector('.kind-icon')).toBeNull();
    expect(codes[0]!.closest('a')).toBeNull();
  });
});
