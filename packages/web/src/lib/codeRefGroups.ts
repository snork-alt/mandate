import { ownerOf, type CodeRef, type StoredComponent } from '@mandate/shared';

export interface FileEntry<T> {
  item: T;
  /** Name shown: the file name when its directory is shown once for the group, else the full path. */
  name: string;
}
export interface DirGroup<T> {
  /** Directory shown once ("src/"), empty for loose files (their full path is the name). */
  dir: string;
  files: FileEntry<T>[];
}

const split = (path: string) => {
  const i = path.lastIndexOf('/');
  return { dir: i < 0 ? '' : path.slice(0, i + 1), file: i < 0 ? path : path.slice(i + 1) };
};

/**
 * Compact a list of paths: files sharing a directory are listed once under it (`src/: api.rs, auth.rs`); a directory
 * with a single file keeps its full path (`tests/api.rs`). Order of first appearance; at most `limit` files are kept
 * (`hidden` counts the rest).
 */
export function compactPaths<T>(items: T[], pathOf: (x: T) => string, limit = Infinity): { groups: DirGroup<T>[]; hidden: number } {
  const byDir = new Map<string, T[]>();
  for (const it of items) {
    const d = split(pathOf(it)).dir;
    byDir.set(d, [...(byDir.get(d) ?? []), it]);
  }
  const groups: DirGroup<T>[] = [];
  let shown = 0;
  for (const [dir, list] of byDir) {
    if (shown >= limit) break;
    const take = list.slice(0, limit - shown);
    shown += take.length;
    const together = list.length > 1;
    groups.push({ dir: together ? dir : '', files: take.map((item) => ({ item, name: together ? split(pathOf(item)).file : pathOf(item) })) });
  }
  return { groups, hidden: items.length - shown };
}

export interface RefGroup<T> {
  /** The owning component, or null for files no component owns. */
  owner: StoredComponent | null;
  items: T[];
}

/** Group code refs by the component that owns them (owned groups first, in order of first appearance; unowned last). */
export function groupByOwner<T extends Pick<CodeRef, 'repo' | 'path'>>(items: T[], components: StoredComponent[]): RefGroup<T>[] {
  const map = new Map<string, RefGroup<T>>();
  for (const it of items) {
    const owner = ownerOf(it.repo, it.path, components)?.component ?? null;
    const key = owner?.id ?? '';
    if (!map.has(key)) map.set(key, { owner, items: [] });
    map.get(key)!.items.push(it);
  }
  return [...map.values()].sort((a, b) => Number(!a.owner) - Number(!b.owner));
}
