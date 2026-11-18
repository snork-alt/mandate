import { describe, expect, it } from 'vitest';
import { cleanRemote, codeFileWebUrl, codeRepoWebUrl } from '../src/code-context.js';

describe('code repo links', () => {
  it('links only when a remote (or legacy github link) is known', () => {
    expect(codeRepoWebUrl({})).toBeNull();
    expect(codeFileWebUrl({}, 'src/a.ts')).toBeNull();
    expect(codeRepoWebUrl({ github: 'acme/app' })).toBe('https://github.com/acme/app');
    expect(codeRepoWebUrl({ remote: 'git@github.com:acme/app.git' })).toBe('https://github.com/acme/app');
    expect(codeFileWebUrl({ remote: 'https://github.com/acme/app.git' }, '/src/a.ts', 'abc1234')).toBe('https://github.com/acme/app/blob/abc1234/src/a.ts');
    expect(codeFileWebUrl({ remote: 'https://gitlab.example/acme/app.git' }, 'src/a.ts')).toBeNull(); // path only: no known blob layout
  });
  it('strips credentials and rejects non-URLs', () => {
    expect(cleanRemote('https://user:tok@github.com/acme/app.git')).toBe('https://github.com/acme/app.git');
    expect(cleanRemote('nonsense')).toBeNull();
    expect(cleanRemote('/local/path')).toBeNull();
  });
});
