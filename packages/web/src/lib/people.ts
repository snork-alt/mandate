/**
 * People (server mode only): contributors of elements (`contributors`) and the user directory (`users_resolve`).
 * Both are batched: every component asks for its own ref / login and the requests made in the same tick go out as one
 * tool call (chunks of 100 refs / 200 logins); results are cached per ref / login by react-query.
 */
import { useQuery } from '@tanstack/react-query';
import type { Contributor, ContributorsResponse, DirectoryUser, UsersResolveResponse } from '@mandate/shared';
import { callTool } from '../mcp/client';
import { bareRef } from './lineage';
import { useShowUsers } from './attribution';
import { useAuth } from '../auth';

type Waiter<T> = { resolve: (v: T) => void; reject: (e: unknown) => void };

/** Collects keys for one tick and resolves them with one call per chunk. */
export function batcher<T>(chunk: number, run: (keys: string[]) => Promise<Map<string, T>>, fallback: T, delay = 15) {
  let pending = new Map<string, Waiter<T>[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const batch = pending;
    pending = new Map();
    const keys = [...batch.keys()];
    for (let i = 0; i < keys.length; i += chunk) {
      const part = keys.slice(i, i + chunk);
      run(part).then(
        (m) => part.forEach((k) => batch.get(k)!.forEach((w) => w.resolve(m.get(k) ?? fallback))),
        (e) => part.forEach((k) => batch.get(k)!.forEach((w) => w.reject(e))),
      );
    }
  };
  return (key: string) =>
    new Promise<T>((resolve, reject) => {
      pending.set(key, [...(pending.get(key) ?? []), { resolve, reject }]);
      timer ??= setTimeout(flush, delay);
    });
}

const loadContributors = batcher<Contributor[]>(
  100,
  async (refs) => {
    const r = await callTool<ContributorsResponse>('contributors', { refs }, undefined);
    const out = new Map<string, Contributor[]>();
    const got = r?.contributors ?? {};
    // The server keys by canonical uri; requested refs are already canonical (no `@mandate:`), so match either way.
    for (const ref of refs) out.set(ref, got[ref] ?? got[bareRef(ref)] ?? []);
    return out;
  },
  [],
);

const loadUser = batcher<DirectoryUser | null>(
  200,
  async (logins) => {
    const r = await callTool<UsersResolveResponse>('users_resolve', { logins }, undefined);
    return new Map((r?.users ?? []).map((u) => [u.login, u]));
  },
  null,
);

/** Contributors of one element: users (server mode) or agent identities (`userRecorded: false`: legacy, local mode). */
/**
 * Contributors that came with a get tool's result (`contributors` on spec / doc / work order / feedback / audit gets):
 * the first render of that element's stack uses them instead of a separate `contributors` call.
 */
const primed = new Map<string, { at: number; list: Contributor[] }>();
export function primeContributors(ref: string, list: unknown): void {
  if (Array.isArray(list)) primed.set(bareRef(ref), { at: Date.now(), list: list as Contributor[] });
}

export function useContributors(ref: string | null | undefined, enabled = true) {
  const known = !!useAuth();
  const key = ref ? bareRef(ref) : '';
  const seed = primed.get(key);
  return useQuery<Contributor[]>({
    queryKey: ['mcp', 'contributors', key],
    queryFn: () => loadContributors(key),
    ...(seed ? { initialData: seed.list, initialDataUpdatedAt: seed.at } : {}),
    enabled: known && enabled && !!key,
    staleTime: 30_000,
    retry: false,
  });
}

/** Directory entry of a login (name, avatar), server mode only. */
export function useDirectoryUser(login: string | null | undefined, enabled = true) {
  const server = useShowUsers();
  return useQuery<DirectoryUser | null>({
    queryKey: ['users', login],
    queryFn: () => loadUser(login!),
    enabled: server && enabled && !!login,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/* ------------------------------------------------------------------ phrasing (pure, unit-tested) */

/** "alice", "alice and bob", "alice, bob and carol", "alice, bob and 3 others". */
export function namesPhrase(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const rest = names.length - (max - 1);
  return `${names.slice(0, max - 1).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

export const directOf = (cs: Contributor[]) => cs.filter((c) => c.kind === 'direct');
export const viaOf = (cs: Contributor[]) => cs.filter((c) => c.kind === 'via');

/** Indirect contributors grouped by their nearest cause (first `via` hop), in order of appearance. */
export function viaGroups(cs: Contributor[]): { cause: { uri: string; kind: string; label: string } | null; users: Contributor[] }[] {
  const groups: { cause: { uri: string; kind: string; label: string } | null; users: Contributor[] }[] = [];
  for (const c of viaOf(cs)) {
    const cause = c.via?.[0] ?? null;
    const g = groups.find((x) => (x.cause?.uri ?? null) === (cause?.uri ?? null));
    if (g) g.users.push(c);
    else groups.push({ cause, users: [c] });
  }
  return groups;
}

export interface LabelPart {
  text: string;
  /** A login (bold, filter link) or a cause reference. */
  user?: string;
  cause?: string;
}

const userParts = (users: string[], max = 3): LabelPart[] => {
  const phrase = namesPhrase(users, max);
  // Re-split the phrase into names and joiners so the names can be links.
  const parts: LabelPart[] = [];
  let rest = phrase;
  for (const u of users.slice(0, users.length <= max ? users.length : max - 1)) {
    const i = rest.indexOf(u);
    if (i > 0) parts.push({ text: rest.slice(0, i) });
    parts.push({ text: u, user: u });
    rest = rest.slice(i + u.length);
  }
  if (rest) parts.push({ text: rest });
  return parts;
};

/** Short name of a cause: a readable id (fb-0007, wo-0042) when it is short, else its label (truncated). */
const shortCause = (c: { uri: string; label: string; kind: string }) => {
  const tail = c.uri.split('/').pop() ?? '';
  if ((c.kind === 'feedback' || c.kind === 'work_order' || c.kind === 'finding') && tail.length <= 12) return tail;
  return c.label.length > 40 ? `${c.label.slice(0, 38)}…` : c.label;
};

/**
 * The label next to a stack.
 * - full (documents): "alice and bob contributed", "alice, bob and 3 others contributed",
 *   "carol edited · alice and bob via fb-0007";
 * - compact (sections): "carol + 2 via feedback", "carol + 1", "2 via feedback".
 */
export function contributorsLabel(cs: Contributor[], form: 'full' | 'compact'): LabelPart[] {
  const direct = directOf(cs).map((c) => c.user);
  const groups = viaGroups(cs);
  const via = groups.flatMap((g) => g.users.map((u) => u.user));
  if (!cs.length) return [];
  if (form === 'compact') {
    const cause = groups[0]?.cause;
    const causeWord = cause ? (cause.kind === 'work_order' ? 'work order' : cause.kind.replace(/_/g, ' ')) : '';
    if (direct.length) {
      const parts: LabelPart[] = [{ text: direct[0]!, user: direct[0] }];
      const others = direct.length - 1;
      if (others) parts.push({ text: ` + ${others}` });
      if (via.length) parts.push({ text: `${others ? ',' : ' +'} ${via.length} via ${causeWord}` });
      return parts;
    }
    return [{ text: `${via.length} via ${causeWord}` }];
  }
  if (!via.length) return [...userParts(direct), { text: ' contributed' }];
  const parts: LabelPart[] = direct.length ? [...userParts(direct), { text: ' edited · ' }] : [];
  const g = groups[0]!;
  parts.push(...userParts(g.users.map((u) => u.user)));
  if (g.cause) parts.push({ text: ' via ' }, { text: shortCause(g.cause), cause: g.cause.uri });
  if (groups.length > 1) parts.push({ text: ` and ${groups.slice(1).reduce((n, x) => n + x.users.length, 0)} more` });
  return parts;
}

export const labelText = (parts: LabelPart[]) => parts.map((p) => p.text).join('');
