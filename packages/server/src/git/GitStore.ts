import type { GitCommitInfo, GitStatus } from '@mandate/shared';

export interface CommitOptions {
  /** Author/committer time (defaults to now); used by the seed script to backdate history. */
  date?: Date;
  /** Override the configured author/committer identity. */
  author?: { name: string; email: string };
}

export interface CommitDiff {
  commit: string;
  parent: string | null;
  files: { path: string; status: 'added' | 'deleted' | 'modified'; before?: string; after?: string }[];
}

/** A commit that touched a given file. */
export interface FileCommit {
  id: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

/**
 * Minimal git abstraction used by the storage layer. Paths are relative to
 * the repository working directory.
 */
export interface GitStore {
  /** Absolute path of the working directory. */
  readonly dir: string;
  /** Create a new repository at `dir`. */
  init(): Promise<void>;
  /** Open an existing repository at `dir`. */
  open(): Promise<void>;
  /** Clone the configured remote into `dir`. */
  clone(): Promise<void>;
  /** Open the repo if present, else clone (remote configured) or init. */
  openOrCreate(): Promise<void>;
  hasRemote(): boolean;
  status(): Promise<GitStatus>;
  /**
   * Stage the given paths (added, modified or deleted) and commit them.
   * Returns the new commit id, or null if nothing changed.
   */
  commit(paths: string[], message: string, options?: CommitOptions): Promise<string | null>;
  fetch(): Promise<void>;
  /** Fetch + fast-forward or merge the remote branch. Returns true if HEAD moved. */
  pull(): Promise<boolean>;
  push(): Promise<void>;
  log(limit?: number): Promise<GitCommitInfo[]>;
  /**
   * Commits that changed each file directly inside `dirs` (newest first), following first parents.
   * Keyed by repo-relative path (`specs/foo.md`).
   */
  fileHistory(dirs: string[]): Promise<Map<string, FileCommit[]>>;
  /**
   * Files directly inside `dirs` that `commit` changed compared with its first parent
   * (blob ids allow rename detection by content).
   */
  commitDiff(commit: string, dirs: string[]): Promise<CommitDiff>;
  /** Full commit id for a ref / (short) hash, or null if it does not resolve to a commit. */
  resolveCommit(ref: string): Promise<string | null>;
  /** UTF-8 content of `path` at `commit`, or null if the file does not exist there. Throws for unknown commits. */
  readFileAt(commit: string, path: string): Promise<string | null>;
  /** Current HEAD commit id, or null in an empty repository. */
  head(): Promise<string | null>;
  /** First-parent chain from HEAD, newest first, stopping before `stopAt` (exclusive) or at the root. */
  firstParentChain(stopAt?: string | null): Promise<{ commits: string[]; reachedStop: boolean }>;
  /** Commits reachable from `commit` but not from `hide` (a merge brings in its side-branch commits), newest first. */
  reachable(commit: string, hide: string | null): Promise<string[]>;
  /** Message, author and date of one commit. */
  commitInfo(commit: string): Promise<FileCommit>;
  /**
   * Blob id of every file directly inside `dirs`, plus the root-level `files`, at `commit`.
   * Keyed by repo-relative path; used by the search index to find changed files cheaply.
   */
  blobsAt(commit: string, dirs: string[], files?: string[]): Promise<Map<string, string>>;
}
