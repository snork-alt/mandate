/**
 * Cross-tab leader election for the server push stream.
 *
 * Browsers allow 6 concurrent HTTP/1.1 connections per origin. Each tab holding its own long-lived SSE stream
 * exhausts that pool with 3+ tabs, and every further request queues forever. So all tabs of one origin share ONE
 * push stream per project: the leader tab holds it and rebroadcasts its notifications over a BroadcastChannel.
 *
 * Election: the Web Locks API (`navigator.locks.request`, released automatically when the tab closes) when
 * available; otherwise (insecure contexts such as plain HTTP on a LAN address) a heartbeat protocol over the
 * BroadcastChannel; without BroadcastChannel every tab leads alone. Hidden tabs never claim leadership, and a
 * leader that stays hidden for `hiddenGraceMs` steps down (another visible tab takes over).
 */

export interface ChannelLike {
  postMessage(msg: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface LocksLike {
  request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

export interface LeaderEnv {
  /** Web Locks (null: use the heartbeat fallback). */
  locks: LocksLike | null;
  /** BroadcastChannel factory (null: no cross-tab sharing; this tab leads alone). */
  channel: ((name: string) => ChannelLike) | null;
  visible: () => boolean;
  /** Subscribe to visibility changes; returns the unsubscribe function. */
  onVisibility: (cb: () => void) => () => void;
  /** Subscribe to the tab going away (pagehide); returns the unsubscribe function. */
  onUnload: (cb: () => void) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  now: () => number;
  random: () => number;
}

export interface LeaderOptions {
  /** A leader hidden this long steps down. */
  hiddenGraceMs?: number;
  /** Fallback protocol: heartbeat interval / leader timeout / initial probe wait. */
  heartbeatMs?: number;
  timeoutMs?: number;
  probeMs?: number;
}

/** Messages relayed between tabs (everything else on the channel is election traffic). */
export type PushMessage =
  /** A server notification received on the leader's stream. */
  | { t: 'ev'; n: { method: string; params?: Record<string, unknown> } }
  /** The leader's stream opened (`src` identifies that stream; a new source after a gap means events may be missed). */
  | { t: 'up'; src: string }
  /** The leader's stream closed (or the leader stepped down). */
  | { t: 'down'; src: string };

type Wire = PushMessage | { t: 'hb'; id: string } | { t: 'bye'; id: string } | { t: 'who' };

export interface LeaderCallbacks {
  /** This tab became the leader: open the stream. */
  onLead(): void;
  /** This tab is no longer the leader: close the stream. */
  onFollow(): void;
  /** A relayed message from the leader tab. */
  onMessage(msg: PushMessage): void;
}

export interface PushLeader {
  readonly id: string;
  isLeader(): boolean;
  /** Relay a message to the other tabs (no-op unless leader). */
  publish(msg: PushMessage): void;
  stop(): void;
}

export function browserLeaderEnv(): LeaderEnv {
  const hasDoc = typeof document !== 'undefined';
  const locks = typeof navigator !== 'undefined' ? ((navigator as Navigator & { locks?: LocksLike }).locks ?? null) : null;
  return {
    locks,
    channel: typeof BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) as unknown as ChannelLike : null,
    visible: () => !hasDoc || document.visibilityState !== 'hidden',
    onVisibility: (cb) => {
      if (!hasDoc) return () => undefined;
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    onUnload: (cb) => {
      if (typeof window === 'undefined') return () => undefined;
      window.addEventListener('pagehide', cb);
      return () => window.removeEventListener('pagehide', cb);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: () => Math.random(),
  };
}

/** Elect one leader among the tabs sharing `key` (e.g. one per project). */
export function createPushLeader(key: string, cb: LeaderCallbacks, env: LeaderEnv = browserLeaderEnv(), opts: LeaderOptions = {}): PushLeader {
  const hiddenGraceMs = opts.hiddenGraceMs ?? 30_000;
  const heartbeatMs = opts.heartbeatMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const probeMs = opts.probeMs ?? 300;
  const id = `${env.now().toString(36)}-${Math.floor(env.random() * 1e9).toString(36)}`;
  let leader = false;
  let stopped = false;
  const ch = env.channel ? env.channel(`mandate-push:${key}`) : null;
  const timers = new Set<unknown>();
  const later = (fn: () => void, ms: number) => {
    const t = env.setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t: unknown) => {
    if (t === undefined) return;
    timers.delete(t);
    env.clearTimeout(t);
  };
  const post = (m: Wire) => {
    try {
      ch?.postMessage(m);
    } catch {
      /* channel closed */
    }
  };

  const lead = () => {
    if (leader || stopped) return;
    leader = true;
    cb.onLead();
  };
  const follow = () => {
    if (!leader) return;
    // Still the leader during onFollow, so it can relay a final 'down'.
    try {
      cb.onFollow();
    } finally {
      leader = false;
    }
  };

  /* ---------------- election strategy ---------------- */
  let want: () => void;
  let unwant: () => void;
  let onWire: (m: Wire) => void = () => undefined;

  if (!ch) {
    // No cross-tab channel: this tab leads alone (while visible).
    want = lead;
    unwant = follow;
  } else if (env.locks) {
    const locks = env.locks;
    let abort: AbortController | null = null;
    let release: (() => void) | null = null;
    want = () => {
      if (abort || stopped) return;
      const a = new AbortController();
      abort = a;
      locks
        .request(`mandate-push:${key}`, { signal: a.signal }, () => {
          if (a.signal.aborted || stopped) return Promise.resolve();
          lead();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => undefined)
        .finally(() => {
          if (abort === a) abort = null;
        });
    };
    unwant = () => {
      abort?.abort();
      abort = null;
      const r = release;
      release = null;
      follow();
      r?.();
    };
  } else {
    // Heartbeat fallback: the leader beats; a visible tab claims after a silence; the lower id wins a conflict.
    let lastBeat = -Infinity;
    let wanted = false;
    let beatTimer: unknown;
    let checkTimer: unknown;
    const beat = () => {
      if (!leader) return;
      post({ t: 'hb', id });
      beatTimer = later(beat, heartbeatMs);
    };
    const check = () => {
      checkTimer = undefined;
      if (!wanted || leader || stopped) return;
      if (env.now() - lastBeat >= timeoutMs) {
        lead();
        beat();
      } else checkTimer = later(check, heartbeatMs);
    };
    want = () => {
      if (wanted || stopped) return;
      wanted = true;
      post({ t: 'who' });
      cancel(checkTimer);
      checkTimer = later(check, probeMs);
    };
    unwant = () => {
      wanted = false;
      cancel(checkTimer);
      checkTimer = undefined;
      if (leader) {
        cancel(beatTimer);
        post({ t: 'bye', id });
        follow();
      }
    };
    onWire = (m) => {
      if (m.t === 'hb') {
        if (leader && m.id !== id) {
          if (m.id < id) {
            cancel(beatTimer);
            follow();
          } else return; // we win; our next beat silences the other tab
        }
        lastBeat = env.now();
        if (wanted && !leader) {
          cancel(checkTimer);
          checkTimer = later(check, timeoutMs);
        }
      } else if (m.t === 'bye') {
        lastBeat = -Infinity;
        if (wanted && !leader) {
          cancel(checkTimer);
          checkTimer = later(check, Math.floor(env.random() * probeMs));
        }
      } else if (m.t === 'who' && leader) post({ t: 'hb', id });
    };
  }

  if (ch) {
    ch.onmessage = (ev) => {
      if (stopped) return;
      const m = ev.data as Wire | null;
      if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
      if (m.t === 'ev' || m.t === 'up' || m.t === 'down') {
        if (!leader) cb.onMessage(m);
      } else onWire(m);
    };
  }

  /* ---------------- visibility ---------------- */
  let hideTimer: unknown;
  const onVis = () => {
    if (stopped) return;
    if (env.visible()) {
      cancel(hideTimer);
      hideTimer = undefined;
      want();
    } else if (hideTimer === undefined) {
      // Hidden: stop competing at once; a hidden leader keeps the stream for a grace period, then hands it over.
      hideTimer = later(() => {
        hideTimer = undefined;
        if (!env.visible()) unwant();
      }, leader ? hiddenGraceMs : 0);
    }
  };
  const offVis = env.onVisibility(onVis);
  const offUnload = env.onUnload(() => stop());
  if (env.visible()) want();

  function stop() {
    if (stopped) return;
    unwant();
    stopped = true;
    for (const t of timers) env.clearTimeout(t);
    timers.clear();
    offVis();
    offUnload();
    if (ch) {
      ch.onmessage = null;
      ch.close();
    }
  }

  return {
    id,
    isLeader: () => leader,
    publish: (msg) => {
      if (leader) post(msg);
    },
    stop,
  };
}
