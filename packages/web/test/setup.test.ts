import { describe, expect, it } from 'vitest';
import { tildify } from '../src/setup/api';
import { splitNdjson } from '../src/lib/ui';
import { cli } from '../src/auth';

describe('setup helpers', () => {
  it('formats paths and ids', () => {
    expect(tildify('/home/me/mandate', '/home/me')).toBe('~/mandate');
    expect(tildify('/home/meow/x', '/home/me')).toBe('/home/meow/x');
    expect(cli('open')).toEqual({ npx: 'npx getmandate open', dev: 'npm run mandate -- open' });
  });
  it('splits NDJSON streams across chunk boundaries', () => {
    const a = splitNdjson('{"step":"init","status":"start"}\n{"step":"in');
    expect(a.items).toEqual([{ step: 'init', status: 'start' }]);
    const b = splitNdjson(`${a.rest}it","status":"done"}\nnot json\n\n`);
    expect(b.items).toEqual([{ step: 'init', status: 'done' }]);
    expect(b.rest).toBe('');
  });
});
