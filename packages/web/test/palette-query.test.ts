import { describe, expect, it } from 'vitest';
import { parsePaletteQuery } from '../src/mcp/queryParser';

describe('parsePaletteQuery', () => {
  it('classifies prefixes', () => {
    expect(parsePaletteQuery('  ')).toEqual({ type: 'empty' });
    expect(parsePaletteQuery('refresh token')).toEqual({ type: 'search', q: 'refresh token' });
    expect(parsePaletteQuery('@AuthService')).toEqual({ type: 'symbol', name: 'AuthService' });
    expect(parsePaletteQuery('/src/auth')).toEqual({ type: 'code', path: 'src/auth' });
    expect(parsePaletteQuery('/src/auth/callback.ts:10-20')).toEqual({ type: 'code', path: 'src/auth/callback.ts', lines: '10-20' });
    expect(parsePaletteQuery('"refresh token"')).toEqual({ type: 'phrase', phrase: 'refresh token' });
    expect(parsePaletteQuery('"open phrase')).toEqual({ type: 'phrase', phrase: 'open phrase' });
    expect(parsePaletteQuery('#Login-SSO')).toEqual({ type: 'id', id: 'login-sso' });
    expect(parsePaletteQuery('#not an id')).toEqual({ type: 'empty' });
  });
  it('detects pasted references before the @ prefix', () => {
    const uri = ['mandate:', '', 'specs/x/sections/y'].join('/');
    expect(parsePaletteQuery(`@mandate:${uri}`)).toEqual({ type: 'ref', uri });
    expect(parsePaletteQuery(uri)).toEqual({ type: 'ref', uri });
  });
});
