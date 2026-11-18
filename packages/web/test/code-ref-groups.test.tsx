import { describe, expect, it } from 'vitest';
import { createComponentSchema, type StoredComponent } from '@mandate/shared';
import { compactPaths, groupByOwner } from '../src/lib/codeRefGroups';

const comp = (id: string, owns: { repo: string; paths: string[] }[]) => ({ ...createComponentSchema.parse({ id, title: id, kind: 'service', owns }), sections: [] }) as unknown as StoredComponent;

describe('compactPaths', () => {
  it('lists a shared directory once, keeps full paths for lone files, and collapses past the limit', () => {
    const paths = ['src/api.rs', 'src/auth.rs', 'tests/api.rs', 'Cargo.toml', 'src/lib.rs', 'postman/collection.json'];
    const { groups, hidden } = compactPaths(paths, (p) => p);
    expect(hidden).toBe(0);
    expect(groups.map((g) => [g.dir, g.files.map((f) => f.name)])).toEqual([
      ['src/', ['api.rs', 'auth.rs', 'lib.rs']],
      ['', ['tests/api.rs']],
      ['', ['Cargo.toml']],
      ['', ['postman/collection.json']],
    ]);
    const cut = compactPaths(paths, (p) => p, 4);
    expect(cut.hidden).toBe(2);
    expect(cut.groups.flatMap((g) => g.files)).toHaveLength(4);
  });
});

describe('groupByOwner', () => {
  it('groups refs by owning component, unowned last', () => {
    const svc = comp('svc', [{ repo: 'agentmachines', paths: ['src/**', 'tests/**'] }]);
    const refs = [
      { repo: 'agentmachines', path: 'Cargo.toml' },
      { repo: 'agentmachines', path: 'src/api.rs' },
      { repo: 'agentmachines', path: 'tests/api.rs' },
    ];
    const g = groupByOwner(refs, [svc]);
    expect(g.map((x) => [x.owner?.id ?? null, x.items.length])).toEqual([['svc', 2], [null, 1]]);
  });
});
