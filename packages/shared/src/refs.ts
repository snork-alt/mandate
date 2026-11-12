/**
 * Stable references to Mandate elements, e.g. `mandate://specs/login-sso/sections/auth-flow@3f2a9c1#L12-L20`.
 * The MCP server (registered as `mandate`) exposes the same URIs as resources; MCP clients (coding agents) pick
 * them up from `@mandate:<uri>` mentions.
 */
export const REF_SCHEME = 'mandate://';
export const MCP_SERVER_NAME = 'mandate';

export type RefKind = 'specs' | 'standards' | 'components' | 'work-orders' | 'feedback';

export interface MandateRef {
  kind: RefKind;
  id: string;
  /** Section inside a spec or standard. */
  sectionId?: string;

  /** Pin to a version: the document as of this commit (emitted as a full 40-char sha). */
  commit?: string;
  /** Lines in the stored `.md` file (1-based, inclusive). */
  lines?: { start: number; end: number };
}

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** `mandate://<kind>/<id>[@<sha>][/sections/<sid>][#Lx-Ly]` (the version suffix sits on the document id). */
const REF_RE = new RegExp(
  `^mandate://(specs|standards|components|work-orders|queue|feedback)/(${SLUG})(?:@([0-9a-f]{4,40}))?(?:/sections/(${SLUG}))?(?:#L(\\d+)(?:-L(\\d+))?)?$`,
);

/** Build the `mandate://` URI for a reference. */
export function buildRef(ref: MandateRef): string {
  if (ref.sectionId && (ref.kind === 'work-orders' || ref.kind === 'feedback')) throw new Error(`${ref.kind} items have no sections`);
  let uri = `${REF_SCHEME}${ref.kind}/${ref.id}`;
  if (ref.commit) uri += `@${ref.commit}`;
  if (ref.sectionId) uri += `/sections/${ref.sectionId}`;
  if (ref.lines) uri += ref.lines.end > ref.lines.start ? `#L${ref.lines.start}-L${ref.lines.end}` : `#L${ref.lines.start}`;
  return uri;
}

/** Parse a `mandate://` URI or an `@mandate:` mention; null if it is not a valid reference. */
export function parseRef(input: string): MandateRef | null {
  const uri = input.trim().replace(new RegExp(`^@${MCP_SERVER_NAME}:`), '');
  const m = REF_RE.exec(uri);
  if (!m) return null;
  const [, kind, id, commit, sectionId, start, end] = m;
  if ((kind === 'work-orders' || kind === 'queue' || kind === 'feedback') && sectionId) return null;
  // `mandate://queue/<id>` is a read-only alias of `work-orders` (the pre-rename form); always emit the new one.
  const ref: MandateRef = { kind: (kind === 'queue' ? 'work-orders' : kind) as RefKind, id: id! };
  if (sectionId) ref.sectionId = sectionId;
  if (commit) ref.commit = commit;
  if (start) {
    const s = Number(start);
    const e = end ? Number(end) : s;
    if (s < 1 || e < s) return null;
    ref.lines = { start: s, end: e };
  }
  return ref;
}

/** The text to paste into a coding agent: `@mandate:mandate://...` (MCP resource mention). */
export function refMention(ref: MandateRef): string {
  return `@${MCP_SERVER_NAME}:${buildRef(ref)}`;
}

/* ------------------------------------------------------------------ graph nodes */

/** Kinds of node in the knowledge graph (the index exposes them for traversal). */
export const NODE_KINDS = [
  'spec',
  'standard',
  'section',
  'work_order',
  'feedback',
  'symbol',
  'code_file',
  'code_range',
  'repo',
  'commit',
  'agent',
  'branch',
  'verification',
  'version',
  'excerpt',
  'component',
  'architecture',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Any graph node: a document reference (specs, standards, sections, work orders, feedback) or
 * `mandate://symbols/<name>`, `mandate://code/<repo>/<path>[#La-Lb]`, `mandate://repos/<name>`, `mandate://commits/<sha>`,
 * `mandate://agents/<name>`, `mandate://branches/<name>`, `mandate://verifications/<id>`.
 */
export type NodeRef =
  | MandateRef
  | { kind: 'symbols'; name: string }
  | { kind: 'code'; repo: string; path: string; lines?: { start: number; end: number } }
  | { kind: 'repos'; name: string }
  | { kind: 'commits'; sha: string }
  | { kind: 'agents'; name: string }
  | { kind: 'branches'; name: string }
  | { kind: 'verifications'; id: string }
  /** The generated architecture view: `mandate://architecture[@sha][?focus=<component>]`. */
  | { kind: 'architecture'; commit?: string; focus?: string };

/** Percent-encode everything but unreserved characters and `:` (so `Foo::bar` and `A.b` stay readable). */
const encodePart = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':');
const decodePart = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

const isDocRef = (r: NodeRef): r is MandateRef =>
  r.kind === 'specs' || r.kind === 'standards' || r.kind === 'components' || r.kind === 'work-orders' || r.kind === 'feedback';

/** The architecture view reference: `mandate://architecture[@sha][?focus=<component>]`. */
export function buildArchitectureRef(r: { commit?: string; focus?: string } = {}): string {
  return `${REF_SCHEME}architecture${r.commit ? `@${r.commit}` : ''}${r.focus ? `?focus=${r.focus}` : ''}`;
}

/** Build the `mandate://` URI of any graph node. */
export function buildNodeUri(ref: NodeRef): string {
  if (isDocRef(ref)) return buildRef(ref);
  switch (ref.kind) {
    case 'symbols':
      return `${REF_SCHEME}symbols/${encodePart(ref.name)}`;
    case 'repos':
    case 'agents':
    case 'branches':
      return `${REF_SCHEME}${ref.kind}/${encodePart(ref.name)}`;
    case 'commits':
      return `${REF_SCHEME}commits/${ref.sha}`;
    case 'verifications':
      return `${REF_SCHEME}verifications/${ref.id}`;
    case 'architecture':
      return buildArchitectureRef(ref);
    case 'code': {
      const p = ref.path.replace(/^\/+/, '').split('/').map(encodePart).join('/');
      let uri = `${REF_SCHEME}code/${encodePart(ref.repo)}/${p}`;
      if (ref.lines) uri += ref.lines.end > ref.lines.start ? `#L${ref.lines.start}-L${ref.lines.end}` : `#L${ref.lines.start}`;
      return uri;
    }
  }
}

/**
 * Accept both version placements: `kind/id@sha/sections/sid` <-> `kind/id/sections/sid@sha`
 * (so references parse whichever form `parseRef` implements).
 */
function swapVersionOrder(input: string): string {
  const s = input.trim();
  const a = /^(.*?mandate:\/\/[a-z]+\/[a-z0-9-]+)@([0-9a-f]{4,40})(\/sections\/[a-z0-9-]+)(#.*)?$/.exec(s);
  if (a) return `${a[1]}${a[3]}@${a[2]}${a[4] ?? ''}`;
  const b = /^(.*?mandate:\/\/[a-z]+\/[a-z0-9-]+)(\/sections\/[a-z0-9-]+)@([0-9a-f]{4,40})(#.*)?$/.exec(s);
  if (b) return `${b[1]}@${b[3]}${b[2]}${b[4] ?? ''}`;
  return s;
}

/** Parse any graph node URI (or `@mandate:` mention); null if invalid. */
export function parseNodeUri(input: string): NodeRef | null {
  const doc = parseRef(input) ?? parseRef(swapVersionOrder(input));
  if (doc) return doc;
  const uri = input.trim().replace(new RegExp(`^@${MCP_SERVER_NAME}:`), '');
  if (!uri.startsWith(REF_SCHEME)) return null;
  const rest = uri.slice(REF_SCHEME.length);
  let m: RegExpExecArray | null;
  if ((m = /^symbols\/([^/#?]+)$/.exec(rest))) {
    const name = decodePart(m[1]!);
    return name ? { kind: 'symbols', name } : null;
  }
  if ((m = /^(repos|agents|branches)\/([^#?]+)$/.exec(rest))) {
    const name = decodePart(m[2]!);
    return name ? { kind: m[1] as 'repos' | 'agents' | 'branches', name } : null;
  }
  if ((m = /^commits\/([0-9a-f]{4,40})$/.exec(rest))) return { kind: 'commits', sha: m[1]! };
  if ((m = new RegExp(`^verifications\\/(${SLUG})$`).exec(rest))) return { kind: 'verifications', id: m[1]! };
  if ((m = new RegExp(`^architecture(?:@([0-9a-f]{4,40}))?(?:\\?focus=(${SLUG}))?$`).exec(rest))) {
    return { kind: 'architecture', ...(m[1] ? { commit: m[1] } : {}), ...(m[2] ? { focus: m[2] } : {}) };
  }
  if ((m = /^code\/([^/#?@]+)(?:@[0-9a-f]{4,40})?\/([^#?]+?)(?:#L(\d+)(?:-L(\d+))?)?$/.exec(rest))) {
    // `repo@commit` (a code-repo commit, as buildCodeRef writes it) names the same code node.
    const repo = decodePart(m[1]!);
    const parts = m[2]!.split('/').map(decodePart);
    if (!repo || parts.some((p) => !p || p === '.' || p === '..')) return null;
    const ref: NodeRef = { kind: 'code', repo, path: parts.join('/') };
    if (m[3]) {
      const s = Number(m[3]);
      const e = m[4] ? Number(m[4]) : s;
      if (s < 1 || e < s) return null;
      ref.lines = { start: s, end: e };
    }
    return ref;
  }
  return null;
}

/** Graph node kind of a parsed URI. */
export function nodeKindOf(ref: NodeRef): NodeKind {
  switch (ref.kind) {
    case 'specs':
    case 'standards':
      // `#Lx-Ly` is an excerpt, `@sha` a version of the doc / section.
      if (ref.lines) return 'excerpt';
      if (ref.commit) return 'version';
      return ref.sectionId ? 'section' : ref.kind === 'specs' ? 'spec' : 'standard';
    case 'components':
      if (ref.lines) return 'excerpt';
      if (ref.commit) return 'version';
      return ref.sectionId ? 'section' : 'component';
    case 'architecture':
      return 'architecture';
    case 'work-orders':
      return 'work_order';
    case 'feedback':
      return 'feedback';
    case 'symbols':
      return 'symbol';
    case 'code':
      return ref.lines ? 'code_range' : 'code_file';
    case 'repos':
      return 'repo';
    case 'commits':
      return 'commit';
    case 'agents':
      return 'agent';
    case 'branches':
      return 'branch';
    case 'verifications':
      return 'verification';
  }
}

/** True for a full 40-char sha (what references should carry once resolved). */
export const isFullSha = (s: string) => /^[0-9a-f]{40}$/.test(s);

/* ---------- Non-document references (chips) ---------- */

/** Code location: `mandate://code/<repo>[@<commit>]/<path>[#Lx-Ly]`. */
export function buildCodeRef(r: { repo: string; path: string; lines?: string; commit?: string }): string {
  const [a, b] = (r.lines ?? '').split('-');
  const frag = a ? `#L${a}${b ? `-L${b}` : ''}` : '';
  return `${REF_SCHEME}code/${r.repo}${r.commit ? `@${r.commit}` : ''}/${r.path}${frag}`;
}

/** Code symbol: `mandate://symbols/<name>`. */
export function buildSymbolRef(name: string): string {
  return `${REF_SCHEME}symbols/${encodeURIComponent(name)}`;
}

/** Commit of the Mandate repository: `mandate://commits/<sha>`. */
export function buildCommitRef(sha: string): string {
  return `${REF_SCHEME}commits/${sha}`;
}

/** `@mandate:<uri>` for any reference URI. */
export function mentionOf(uri: string): string {
  return `@${MCP_SERVER_NAME}:${uri}`;
}

/** The URI without scheme (for compact labels): `specs/x/sections/y`. */
export function refLabel(uri: string): string {
  return uri.startsWith(REF_SCHEME) ? uri.slice(REF_SCHEME.length) : uri;
}

/** Accepts a pasted `@mandate:` mention or `mandate://` URI and returns the URI, or null. */
export function refFromText(text: string): string | null {
  const t = text.trim().replace(new RegExp(`^@${MCP_SERVER_NAME}:`), '');
  return t.startsWith(REF_SCHEME) ? t : null;
}

/** Every reference kind the builders can produce (contract test: each is a graph key). */
export const REF_KINDS = ['specs', 'standards', 'components', 'work-orders', 'feedback', 'code', 'symbols', 'commits', 'architecture'] as const;
export type AnyRefKind = (typeof REF_KINDS)[number];

/** All builders by kind, with an example input each (for coverage checks). */
export const refBuilders = {
  specs: (r: Omit<MandateRef, 'kind'>) => buildRef({ ...r, kind: 'specs' }),
  standards: (r: Omit<MandateRef, 'kind'>) => buildRef({ ...r, kind: 'standards' }),
  components: (r: Omit<MandateRef, 'kind'>) => buildRef({ ...r, kind: 'components' }),
  'work-orders': (r: Omit<MandateRef, 'kind' | 'sectionId' | 'lines'>) => buildRef({ ...r, kind: 'work-orders' }),
  feedback: (r: Omit<MandateRef, 'kind' | 'sectionId' | 'lines'>) => buildRef({ ...r, kind: 'feedback' }),
  code: buildCodeRef,
  symbols: buildSymbolRef,
  commits: buildCommitRef,
  architecture: buildArchitectureRef,
} as const satisfies Record<AnyRefKind, (...args: never[]) => string>;

/** Canonical form of any reference (prefix dropped, parts in builder order); null if invalid. */
export function canonicalRef(input: string): string | null {
  const ref = parseNodeUri(input);
  return ref ? buildNodeUri(ref) : null;
}

/** Every reference builder (the contract tests check each one is exercised). */
export const REF_BUILDERS = { buildRef, buildNodeUri, refMention, canonicalRef } as const;
