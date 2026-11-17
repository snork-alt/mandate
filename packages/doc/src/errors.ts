export type DocIssueCode =
  | 'frontmatter-missing'
  | 'yaml-invalid'
  | 'frontmatter-invalid'
  | 'sections-invalid'
  | 'unknown-type'
  | 'content-before-first-section'
  | 'duplicate-id'
  | 'marker-without-metadata'
  | 'metadata-without-marker'
  | 'order-mismatch'
  | 'heading-missing'
  | 'heading-mismatch'
  | 'fence-missing'
  | 'fence-mismatch'
  | 'body-invalid'
  | 'section-not-found'
  | 'round-trip-mismatch';

export interface DocIssue {
  code: DocIssueCode;
  message: string;
  /** Section the issue refers to, if any. */
  sectionId?: string;
  /** 1-based line in the source document, if known. */
  line?: number;
}

/** Non-blocking advice: the document is valid but could be better for agents and search. */
export interface DocWarning {
  code: 'summary-missing' | 'summary-stale' | 'section-too-long' | 'tldr-missing';
  message: string;
  sectionId?: string;
  line?: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: DocIssue[];
  /** Advice only; never makes `ok` false. */
  warnings: DocWarning[];
}

/** Thrown by parse/serialize/ops; carries every issue found. */
export class DocError extends Error {
  readonly issues: DocIssue[];

  constructor(issues: DocIssue[]) {
    super(
      issues.length === 1
        ? issues[0]!.message
        : `${issues.length} problems: ${issues.map((i) => i.message).join('; ')}`,
    );
    this.name = 'DocError';
    this.issues = issues;
  }
}
