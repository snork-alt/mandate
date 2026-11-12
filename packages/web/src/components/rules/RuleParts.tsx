import { HoverCard, Loader, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconX } from '@tabler/icons-react';
import type { CriterionState, RuleHit, Section } from '@mandate/shared';
import { ruleExamples } from '@mandate/doc';
import { buildCodeRef, parseNodeUri } from '@mandate/shared/refs';
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
import { CodeRulesLines } from '../refs/CodeRules';
import { LineageButton, WhereUsedButton } from '../lineage/LineageButton';
import { Contributors } from '../people/People';
import { bareRef } from '../../lib/lineage';

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

/** Why, scope, check and examples of a rule as a compact details list (no chips). */
export function RuleMeta({ section }: { section: Section }) {
  const scope = section.scope;
  const scopeItems = [...(scope?.paths ?? []).map((p) => ({ key: p, mono: true, text: p })), ...(scope?.languages ?? []).map((l) => ({ key: l, mono: false, text: l }))];
  return (
    <>
      {section.rationale && (
        <p className="rule-why">
          <span className="rule-why-label">Why</span> {section.rationale}
        </p>
      )}
      {(scopeItems.length > 0 || section.check || (section.examples?.length ?? 0) > 0) && (
        <dl className="rule-facts">
          {scopeItems.length > 0 && (
            <>
              <dt>Applies to</dt>
              <dd>
                {scopeItems.map((x, i) => (
                  <span key={x.key}>
                    {i > 0 && <span className="rule-sep"> · </span>}
                    <span className={x.mono ? 'mono' : undefined}>{x.text}</span>
                  </span>
                ))}
              </dd>
            </>
          )}
          {section.check && (
            <>
              <dt>Check</dt>
              <dd>
                <span className="rule-check-kind">{section.check.kind}</span>
                {section.check.command && (
                  <Tooltip label="Copy command" openDelay={300}>
                    <button type="button" className="rule-check-cmd mono" onClick={() => void copyText(section.check!.command!, 'Copied command')}>
                      {section.check.command}
                      <IconCopy size={11} />
                    </button>
                  </Tooltip>
                )}
                {section.check.note && <span className="rule-sep"> · {section.check.note}</span>}
              </dd>
            </>
          )}
          {(section.examples?.length ?? 0) > 0 && (
            <>
              <dt>Examples</dt>
              <dd className="rule-examples">
                {section.examples!.map((e) => (
                  <ExampleChip key={e} uri={e} />
                ))}
              </dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}

/** Body of a rule: prose, then Do / Don't examples stacked (full width, never truncated), then the details list. */
export function RuleBody({ section }: { section: Section }) {
  const { prose, do: good, dont: bad } = ruleExamples(section.body);
  return (
    <div className="rule-body">
      {prose && <Markdown>{prose}</Markdown>}
      {good.map((b, i) => (
        <div key={`do-${i}`} className="rule-example" data-kind="do">
          <div className="rule-example-label">
            <IconCheck size={13} /> Do
          </div>
          <CodeBlock code={b.code} lang={b.lang} bare />
        </div>
      ))}
      {bad.map((b, i) => (
        <div key={`dont-${i}`} className="rule-example" data-kind="dont">
          <div className="rule-example-label">
            <IconX size={13} /> Don't
          </div>
          <CodeBlock code={b.code} lang={b.lang} bare />
        </div>
      ))}
      <RuleMeta section={section} />
    </div>
  );
}

/** A rule in a standard: a document entry separated by a hairline (no card), level as a small tag. */
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
        <Tooltip label={LEVEL_META[section.level ?? 'should'].hint} multiline maw={320} openDelay={300}>
          <span className="rule-level" data-level={section.level ?? 'should'}>
            {LEVEL_META[section.level ?? 'should'].label.toLowerCase()}
          </span>
        </Tooltip>
        <h3 className="rule-title">{section.title}</h3>
        {state && <CriterionStateIcon state={state.state} />}
        {target && (
          <span className="section-people rule-people">
            <Contributors refUri={bareRef(target.ref)} size="xs" max={3} form="compact" />
          </span>
        )}
        {section.archived && (
          <span className="link-badge" data-tone="muted">
            Archived
          </span>
        )}
        <span className="section-actions">
          {target && parseNodeUri(bareRef(target.ref))?.kind === 'standards' && <WhereUsedButton refUri={bareRef(target.ref)} />}
          {target && <LineageButton refUri={bareRef(target.ref)} label="rule" />}
          {target && <CopyRef target={target} />}
        </span>
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

/** Work orders that touched this file (`code_owner.workOrders`): "touched by q-0003". */
function TouchedBy({ repo, path }: { repo: string; path: string }) {
  const q = useMcpTool<{ workOrders?: { id: string; title?: string; status: string; change?: string; lines?: string[] }[] }>('code_owner', { repo, path });
  const list = q.data?.workOrders ?? [];
  if (!list.length) return null;
  return (
    <div className="wo-touched-by">
      {list.slice(0, 5).map((w) => (
        <div key={w.id}>
          Touched by{' '}
          <Link to={`/work-orders/${w.id}`} className="mono">
            {w.id}
          </Link>
          <span className="faint">
            {' '}
            · {w.status.replace('_', ' ')}
            {w.change ? ` · ${w.change}` : ''}
            {w.lines?.length ? ` · L${w.lines.join(', L')}` : ''}
          </span>
        </div>
      ))}
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
        <div className="ref-preview-people" data-testid="code-people">
          <span className="faint">Touched by</span>
          {/* The file (work orders record touched files, not ranges). */}
          <Contributors refUri={buildCodeRef({ repo, path })} size="xs" max={5} form="compact" />
        </div>
        <TouchedBy repo={repo} path={path} />
        <RulesForCode repo={repo} path={path} lines={lines} />
        <CodeRulesLines refUri={buildCodeRef({ repo, path, lines })} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
