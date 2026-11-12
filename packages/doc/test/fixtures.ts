import { z } from 'zod';
import { createDocFormat, slugSchema } from '../src/index.js';

/** A spec-like frontmatter used across tests. */
export const testSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional(),
  status: z.enum(['draft', 'ready', 'in_progress', 'done', 'archived']).default('draft'),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
  tags: z.array(z.string()).default([]),
  dependsOn: z.array(slugSchema).default([]),
  implementedCommit: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string()).optional(),
  claim: z
    .object({ agent: z.string(), branch: z.string().optional(), startedAt: z.string(), heartbeatAt: z.string() })
    .optional(),
});

export const fmt = createDocFormat(testSchema);

export const CANONICAL = `---
title: Login with SSO
summary: Users can sign in with Google/Microsoft via OIDC.
status: in_progress
priority: p1
tags: [security, api]
dependsOn: [user-sessions]
implementedCommit: 3f2a9c1
claim:
  agent: claude-code@matteo-mbp
  branch: spec/login-sso
  startedAt: 2026-11-11T22:50:00Z
  heartbeatAt: 2026-11-11T23:10:00Z
sections:
  - id: overview
    title: Overview
    type: markdown
  - id: auth-flow
    title: Authentication flow
    type: mermaid
    refs: [{repo: app, path: src/auth/oidc.ts, lines: 10-64, commit: 3f2a9c1}]
    symbols: [OidcClient, AuthService.login]
    links: [{to: mandate://standards/security-baseline, rel: follows}]
  - id: button
    title: Login button
    type: html
---

<!-- @section overview -->
## Overview

Users pick a provider.

### Details

- Google
- Microsoft

<!-- @section auth-flow -->
## Authentication flow

\`\`\`mermaid
sequenceDiagram
  User->>App: login
\`\`\`

<!-- @section button -->
## Login button

\`\`\`html
<button class="sso">Sign in</button>
\`\`\`
`;
