import { describe, expect, it } from 'vitest';
import { displayOrder } from '../src/components/doc/order';

const s = (id: string, type = 'markdown') => ({ id, type }) as never;

describe('displayOrder', () => {
  it('description sections first (overview leading), every criterion last, stored order kept otherwise', () => {
    const stored = [s('create'), s('ac1', 'acceptance'), s('overview'), s('ac2', 'acceptance'), s('authentication')];
    expect(displayOrder(stored).map((x: { id: string }) => x.id)).toEqual(['overview', 'create', 'authentication', 'ac1', 'ac2']);
  });
  it('standards: rules after the other sections', () => {
    expect(displayOrder([s('r1', 'rule'), s('intro')]).map((x: { id: string }) => x.id)).toEqual(['intro', 'r1']);
  });
});
