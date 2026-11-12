import { HoverCard, Loader, Tooltip } from '@mantine/core';
import { IconChecklist, IconCopy, IconFolder, IconLanguage, IconScale } from '@tabler/icons-react';
import type { CriterionState, RuleHit, Section } from '@mandate/shared';
import { ruleExamples } from '@mandate/doc';
import { parseNodeUri } from '@mandate/shared/refs';
import { Link } from 'react-router';
import { copyText } from '../../lib/copy';
import type { CopyTarget } from '../../lib/refs';
import { useMcpTool } from '../../mcp/queries';
import { CodeBlock } from '../CodeBlock';
import { Markdown } from '../Markdown';
import { CodeRefChip } from '../doc/Chips';
import { CopyRef, copyTargetProps } from '../copy';
import { CriterionStateIcon } from '../doc/Acceptance';
import { sectionAnchor } from '../doc/anchors';

export type RuleLevel = 'must' | 'should' | 'may';
export const LEVEL_META: Record<RuleLevel, { label: string; tone: string; hint: string }> = {
  must: { label: 'MUST', tone: 'danger', hint: 'Blocks done unless verified or waived' },
  should: { label: 'SHOULD', tone: 'warn', hint: 'Unverified only warns' },
  may: { label: 'MAY', tone: 'muted', hint: 'Informational' },
};

export function LevelBadge({ level }: { level?: RuleLevel }) {
  const m = LEVEL_META[level ?? 'should'];
  return (
    <Tooltip label={m.hint}>
      <span className="level-badge" data-level={level ?? 'should'}>
        {m.label}
      </span>
    </Tooltip>
  );
}

/** A code reference URI (an example) as a chip. */
function ExampleChip({ uri }: { uri: string }) {
  const n = parseNodeUri(uri);
  if (n?.kind !== 'code') return <span className="mono small">{uri}</span>;
  const lines = n.lines ? (n.lines.end > n.lines.start ? `${n.lines.start}-${n.lines.end}` : `${n.lines.start}`) : undefined;
  return <CodeRefChip codeRef={{ repo: n.repo, path: n.path, ...(lines ? { lines } : {}) }} />;
}

/** Rationale, scope chips, the check (copyable command) and example chips of a rule. */
export function RuleMeta({ section }: { section: Section }) {
  const scope = section.scope;
  return (
    <div className="rule-meta">
      {section.rationale && (
        <div className="rule-rationale">
          <IconScale size={13} /> <span>{section.rationale}</span>
        </div>
      )}
      {(scope?.paths?.length || scope?.languages?.length || section.check || section.examples?.length) && (
        <div className="rule-chips">
          {scope?.paths?.map((p) => (
            <span key={p} className="chip chip-scope" title="Applies to these paths">
              <IconFolder size={12} />
              <span className="mono">{p}</span>
            </span>
          ))}
          {scope?.languages?.map((l) => (
            <span key={l} className="chip chip-scope" title="Applies to these languages">
              <IconLanguage size={12} />
              {l}
            </span>
          ))}
          {section.check && (
            <span className="chip chip-check" title={section.check.note ?? `Checked by ${section.check.kind}`}>
              <IconChecklist size={12} />
              {section.check.kind}
              {section.check.command && (
                <button type="button" className="chip-check-cmd mono" onClick={() => void copyText(section.check!.command!, 'Copied command')} title="Copy command">
                  {section.check.command}
                  <IconCopy size={11} />
                </button>
              )}
            </span>
          )}
          {section.examples?.map((e) => <ExampleChip key={e} uri={e} />)}
        </div>
      )}
    </div>
  );
}

/** Body of a rule: prose, then Do (green) and Don't (red) code blocks side by side. */
export function RuleBody({ section }: { section: Section }) {
  const { prose, do: good, dont: bad } = ruleExamples(section.body);
  return (
    <div className="rule-body">
      {prose && <Markdown>{prose}</Markdown>}
      {(good.length > 0 || bad.length > 0) && (
        <div className="rule-dodont">
          {good.length > 0 && (
            <div className="rule-do">
              <div className="rule-dodont-label">Do</div>
              {good.map((b, i) => (
                <CodeBlock key={i} code={b.code} lang={b.lang} bare />
              ))}
            </div>
          )}
          {bad.length > 0 && (
            <div className="rule-dont">
              <div className="rule-dodont-label">Don't</div>
              {bad.map((b, i) => (
                <CodeBlock key={i} code={b.code} lang={b.lang} bare />
              ))}
            </div>
          )}
        </div>
      )}
      <RuleMeta section={section} />
    </div>
  );
}

/** A rule as a card (standard pages): level, title, state, body, meta. */
export function RuleCard({ section, state, target }: { section: Section; state?: CriterionState; target?: CopyTarget }) {
  return (
    <section
      id={sectionAnchor(section.id)}
      data-section-id={section.id}
      className={`rule-card has-copy-ref${section.archived ? ' section-archived' : ''}`}
      data-level={section.level ?? 'should'}
      {...(target ? copyTargetProps(target) : {})}
    >
      <div className="rule-head">
        <LevelBadge level={section.level} />
        <h3 className="rule-title">{section.title}</h3>
        {state && <CriterionStateIcon state={state.state} />}
        {section.archived && (
          <span className="link-badge" data-tone="muted">
            Archived
          </span>
        )}
        <span className="section-actions">{target && <CopyRef target={target} />}</span>
      </div>
      <RuleBody section={section} />
    </section>
  );
}

/** "Rules for this code": the rules whose scope matches a file, plus rules inherited by spec sections referencing it. */
export function RulesForCode({ repo, path, lines }: { repo: string; path: string; lines?: string }) {
  const q = useMcpTool<{ rules: RuleHit[] }>('rules_for_code', { repo, path, ...(lines ? { lines } : {}) });
  if (q.isPending) return <Loader size="xs" />;
  if (q.isError) return <span className="faint small">Rules unavailable ({(q.error as Error).message})</span>;
  if (!q.data?.rules.length) return <span className="faint small">No rules apply to this code.</span>;
  return (
    <div className="rules-for-code">
      {q.data.rules.map((r) => {
        const t = parseNodeUri(r.uri);
        const href = t && 'id' in t && 'sectionId' in t ? `/standards/${t.id}#section-${t.sectionId}` : '#';
        return (
          <Link key={r.uri} to={href} className="rules-for-code-row">
            <LevelBadge level={r.level} />
            <span className="rules-for-code-title">{r.title}</span>
            <span className="faint small">
              {r.standardTitle}
              {r.why.includes('section') ? ' · via spec section' : ''}
              {r.deprecated ? ' · deprecated' : ''}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/** Hover popover on a code chip showing the rules for that code. */
export function RulesHover({ repo, path, lines, children }: { repo: string; path: string; lines?: string; children: React.ReactNode }) {
  return (
    <HoverCard openDelay={450} closeDelay={150} width={380} position="bottom-start" withinPortal shadow="md">
      <HoverCard.Target>{children}</HoverCard.Target>
      <HoverCard.Dropdown>
        <div className="rules-for-code-head small">
          Rules for <span className="mono">{path}</span>
          {lines ? <span className="mono faint">:{lines}</span> : null}
        </div>
        <RulesForCode repo={repo} path={path} lines={lines} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
