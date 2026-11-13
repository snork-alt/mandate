/**
 * Overview tab "Health": coverage KPI tiles, maturity by category (stacked bars), verification gaps (worst first) and
 * integrity warnings grouped by kind. CSS / SVG only; existing colour tokens and type scale.
 */
import { useState, type ReactNode } from 'react';
import { HoverCard, SegmentedControl, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBox,
  IconCategory,
  IconChevronRight,
  IconCircleCheck,
  IconCode,
  IconFileText,
  IconLink,
  IconListCheck,
  IconRuler2,
  IconShieldCheck,
} from '@tabler/icons-react';
import { Link } from 'react-router';
import { MATURITY_LABELS, MATURITY_STEPS, type MaturityStep, type ProjectOverview } from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import { RefChip } from '../refs/RefChip';
import { CopyPromptButton, ItemMenu } from '../decisions/DecisionActions';
import { allPrompts, itemPrompt } from '../../lib/prompts';
import { categoryLabel } from '../../lib/specs';
import { compactTime } from '../../lib/time';
import { STEP_COLOR } from '../../lib/overview';
import { Card, Empty, pct, plural } from './parts';

/* ---------------------------------------------------------------- shared bits */

export interface Segment {
  key: string;
  label: string;
  n: number;
  color: string;
}

/** Horizontal stacked bar; the hover card lists every segment (the legend). */
export function SegBar({ segs, label, height = 8, showCounts = false }: { segs: Segment[]; label: string; height?: number; showCounts?: boolean }) {
  const total = segs.reduce((n, s) => n + s.n, 0);
  return (
    <Tooltip
      openDelay={200}
      multiline
      label={
        <span className="ov-legend-tip">
          {segs.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} /> {s.label}: {s.n}
            </span>
          ))}
        </span>
      }
    >
      <span className="ov-segbar" role="img" aria-label={`${label}: ${segs.filter((s) => s.n).map((s) => `${s.n} ${s.label}`).join(', ') || 'none'}`} style={{ height }}>
        {total === 0 ? <span className="ov-seg-empty" /> : segs.map((s) => (s.n ? <span key={s.key} data-seg={s.key} style={{ flexGrow: s.n, background: s.color }}>{showCounts && s.n / total >= 0.12 ? s.n : null}</span> : null))}
      </span>
    </Tooltip>
  );
}

/** Small donut (conic-gradient) for a single ratio. */
function Ring({ value, label }: { value: number; label: string }) {
  return <span className="ov-ring" role="img" aria-label={`${label}: ${value}%`} style={{ ['--p' as string]: `${value}%` }} />;
}

export const CRIT_COLORS = {
  verified: 'var(--mantine-color-teal-6)',
  waived: 'var(--mantine-color-teal-2)',
  stale: 'var(--mantine-color-orange-5)',
  failing: 'var(--mantine-color-red-6)',
  unverified: 'var(--app-border-strong)',
};
type Crit = { total: number; verified: number; waived: number; failing: number; stale: number; unverified: number };
/** `verified` includes waived criteria (as the maturity rollup counts them). */
export const critSegs = (c: Crit): Segment[] => [
  { key: 'verified', label: 'Verified', n: Math.max(0, c.verified - c.waived), color: CRIT_COLORS.verified },
  { key: 'waived', label: 'Waived', n: c.waived, color: CRIT_COLORS.waived },
  { key: 'stale', label: 'Stale', n: c.stale, color: CRIT_COLORS.stale },
  { key: 'failing', label: 'Failing', n: c.failing, color: CRIT_COLORS.failing },
  { key: 'unverified', label: 'Unverified', n: c.unverified, color: CRIT_COLORS.unverified },
];

/* ---------------------------------------------------------------- coverage */

function Kpi({ to, label, value, viz, caption, testId }: { to: string; label: string; value: number | null; viz: ReactNode; caption: ReactNode; testId: string }) {
  return (
    <Link to={to} className="ov-kpi" data-testid={testId}>
      <span className="ov-kpi-label">{label}</span>
      <span className="ov-kpi-main">
        <span className="ov-kpi-value">{value === null ? 'n/a' : `${value}%`}</span>
        <span className="ov-kpi-viz">{viz}</span>
      </span>
      <span className="ov-kpi-caption">{caption}</span>
      {/* Trend slot: no 30-day history is derivable cheaply yet, so it stays empty (never fake data). */}
      <span className="ov-kpi-trend" aria-hidden />
    </Link>
  );
}

export function Coverage({ o, projectId }: { o: ProjectOverview; projectId: string }) {
  const c = o.coverage;
  const a = c.audits;
  const gaps = c.criteria.total - c.criteria.verified + a.never + a.stale;
  const auditSegs: Segment[] = [
    { key: 'recent', label: 'Recent', n: a.recent, color: CRIT_COLORS.verified },
    { key: 'stale', label: 'Stale', n: a.stale, color: CRIT_COLORS.stale },
    { key: 'never', label: 'Never audited', n: a.never, color: CRIT_COLORS.unverified },
  ];
  return (
    <Card id="coverage" icon={<IconShieldCheck size={15} />} title="Coverage" wide action={gaps > 0 ? <CopyPromptButton prompt={allPrompts.coverage(projectId)} label="Copy prompt to raise coverage" /> : undefined}>
      <div className="ov-kpis">
        <Kpi
          testId="kpi-criteria"
          to="/specs?maturity=stale,failing,implemented"
          label="Criteria verified"
          value={c.criteria.total ? pct(c.criteria.verified, c.criteria.total) : null}
          viz={<SegBar segs={critSegs(c.criteria)} label="Must criteria" />}
          caption={c.criteria.total ? `${c.criteria.verified} of ${c.criteria.total} must criteria` : 'No acceptance criteria yet'}
        />
        <Kpi
          testId="kpi-sections"
          to="/specs?maturity=specified,in_progress"
          label="Sections implemented"
          value={c.sections.total ? pct(c.sections.implemented, c.sections.total) : null}
          viz={<Ring value={pct(c.sections.implemented, c.sections.total)} label="Sections implemented" />}
          caption={c.sections.total ? `${c.sections.implemented} of ${c.sections.total} sections` : 'No specified sections yet'}
        />
        <Kpi
          testId="kpi-audits"
          to="/audits"
          label="Audit freshness"
          value={a.total ? pct(a.recent, a.total) : null}
          viz={<SegBar segs={auditSegs} label="Audits" />}
          caption={a.total ? `${a.recent} recent · ${a.stale} stale · ${a.never} never` : 'No specs to audit yet'}
        />
        <Kpi
          testId="kpi-lineage"
          to="/lineage"
          label="Lineage recorded"
          value={c.lineage && c.lineage.contentEdits ? pct(c.lineage.withCause, c.lineage.contentEdits) : null}
          viz={c.lineage ? <Ring value={pct(c.lineage.withCause, c.lineage.contentEdits)} label="Lineage recorded" /> : null}
          caption={c.lineage ? (c.lineage.contentEdits ? `${c.lineage.withCause} of ${c.lineage.contentEdits} edits say why` : 'No content edits yet') : 'Needs the search index'}
        />
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- maturity by category */

const STEP_INDEX = new Map(MATURITY_STEPS.map((s, i) => [s, i]));
type Cat = ProjectOverview['byCategory'][number];
const avgStep = (c: Cat) => (c.total ? c.specs.reduce((n, s) => n + (STEP_INDEX.get(s.step) ?? 0), 0) / c.total : 0);
const catName = (c: string) => (c === 'uncategorized' ? 'General' : categoryLabel(c));

export function sortCategories(cats: Cat[], by: 'maturity' | 'name'): Cat[] {
  return [...cats].sort((a, b) => (by === 'name' ? catName(a.category).localeCompare(catName(b.category)) : avgStep(a) - avgStep(b) || catName(a.category).localeCompare(catName(b.category))));
}

function CatSegment({ c, step }: { c: Cat; step: MaturityStep }) {
  const n = c.steps[step];
  const specs = c.specs.filter((s) => s.step === step);
  return (
    <HoverCard openDelay={200} closeDelay={80} width={260} shadow="md" withinPortal>
      <HoverCard.Target>
        <span className="ov-catseg" data-step={step} style={{ flexGrow: n, background: STEP_COLOR[step] }} tabIndex={0} aria-label={`${n} ${MATURITY_LABELS[step]} in ${catName(c.category)}`}>
          {n / c.total >= 0.14 ? n : null}
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown p={10}>
        <div className="ov-hover-title">
          {MATURITY_LABELS[step]} · {catName(c.category)}
        </div>
        <ul className="ov-hover-list">
          {specs.map((s) => (
            <li key={s.id}>
              <Link to={`/specs/${s.id}`}>{s.title}</Link>
            </li>
          ))}
        </ul>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

export function ByCategory({ o }: { o: ProjectOverview }) {
  const [by, setBy] = useState<'maturity' | 'name'>('maturity');
  const cats = sortCategories(o.byCategory, by);
  return (
    <Card
      id="categories"
      icon={<IconCategory size={15} />}
      title="Maturity by category"
      count={o.byCategory.length}
      action={
        o.byCategory.length > 1 ? (
          <SegmentedControl size="xs" value={by} onChange={(v) => setBy(v as 'maturity' | 'name')} data={[{ value: 'maturity', label: 'Least mature' }, { value: 'name', label: 'A–Z' }]} aria-label="Sort categories" data-testid="cat-sort" />
        ) : undefined
      }
    >
      {cats.length === 0 ? (
        <Empty icon={<IconFileText size={18} stroke={1.5} />} title="No specs yet" />
      ) : (
        <>
          <div className="ov-legend" aria-hidden>
            {MATURITY_STEPS.map((s) => (
              <span key={s}>
                <i style={{ background: STEP_COLOR[s] }} /> {MATURITY_LABELS[s]}
              </span>
            ))}
          </div>
          <ul className="ov-list ov-cats" data-testid="cat-rows">
            {cats.map((c) => (
              <li key={c.category} className="ov-cat">
                <Link to={`/specs?category=${encodeURIComponent(c.category)}`} className="ov-cat-name">
                  {catName(c.category)}
                </Link>
                <span className="ov-catbar">{MATURITY_STEPS.map((s) => (c.steps[s] ? <CatSegment key={s} c={c} step={s} /> : null))}</span>
                <span className="ov-cat-n">{c.total}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- verification gaps */

export function VerificationGaps({ o }: { o: ProjectOverview }) {
  const [all, setAll] = useState(false);
  const rows = all ? o.gaps : o.gaps.slice(0, 8);
  return (
    <Card id="gaps" icon={<IconListCheck size={15} />} title="Verification gaps" count={o.gaps.length} wide>
      {o.gaps.length === 0 ? (
        <Empty icon={<IconCircleCheck size={18} stroke={1.5} />} title="All criteria verified ✓">
          Every specified spec has its must criteria verified and a recent audit.
        </Empty>
      ) : (
        <>
          <table className="ov-table" data-testid="gaps-table">
            <thead>
              <tr>
                <th scope="col">Spec</th>
                <th scope="col">Must criteria</th>
                <th scope="col" className="num">
                  Verified
                </th>
                <th scope="col">Last audit</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const uri = buildRef({ kind: 'specs', id: g.id });
                const action = g.criteria.failing || g.criteria.stale || g.criteria.unverified ? 'verify' : 'audit';
                return (
                  <tr key={g.id} data-testid="gap-row">
                    <th scope="row">
                      <Link to={`/specs/${g.id}`} className="ov-table-title">
                        {g.title}
                      </Link>
                    </th>
                    <td className="bar">
                      <SegBar segs={critSegs(g.criteria)} label={`${g.title} must criteria`} height={6} />
                    </td>
                    <td className="num">
                      {g.criteria.verified} / {g.criteria.total}
                    </td>
                    <td>
                      {g.audit ? (
                        <span className={g.audit.stale ? 'ov-audit-age' : 'ov-muted'} data-stale={g.audit.stale || undefined}>
                          {compactTime(g.audit.at)}
                          {g.audit.stale ? ' · stale' : ''}
                        </span>
                      ) : (
                        <span className="ov-badge" data-tone="muted">
                          Never audited
                        </span>
                      )}
                    </td>
                    <td className="menu">
                      <ItemMenu label={g.title} prompt={itemPrompt(action, uri, action === 'verify' && !g.audit ? 'Then audit it with audit_plan.' : '')} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {o.gaps.length > 8 && (
            <button type="button" className="ov-show-all" onClick={() => setAll((x) => !x)} aria-expanded={all}>
              {all ? 'Show fewer' : `Show all (${o.gaps.length})`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- integrity warnings by kind */

/** Plain-language labels for integrity warning rules. */
export const RULE_LABEL: Record<string, string> = {
  spec_section_without_criteria: 'Sections without acceptance criteria',
  spec_done_without_criteria: 'Done specs without acceptance criteria',
  component_unreferenced: 'Components no spec affects',
  component_no_standards: 'Components without standards',
  component_no_code: 'Components that own no code',
  unowned_code_ref: 'Code no component owns',
  owns_matches_nothing: 'Ownership globs that match nothing',
  self_approved_override: 'Self-approved acceptances',
  external_follows_internal: 'External components following code rules',
  audit_pass_contradicted: 'Audit passes contradicted by findings',
  fix_misses_finding_code: 'Fix work orders missing the finding\'s code',
  done_spec_drift: 'Done specs that drifted',
};
const RULE_ICON = (rule: string) =>
  rule.startsWith('component') || rule.startsWith('external') ? <IconBox size={14} /> : rule.includes('code') || rule.startsWith('owns') ? <IconCode size={14} /> : rule.includes('audit') || rule.includes('fix') ? <IconListCheck size={14} /> : rule.includes('approved') ? <IconRuler2 size={14} /> : rule.includes('link') ? <IconLink size={14} /> : <IconFileText size={14} />;
export const ruleLabel = (rule: string) => RULE_LABEL[rule] ?? rule.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function WarningGroup({ g, max, projectId }: { g: ProjectOverview['warningGroups'][number]; max: number; projectId: string }) {
  const [open, setOpen] = useState(false);
  const label = ruleLabel(g.rule);
  const prompt = `Use Mandate (project ${projectId}): fix the integrity warnings "${g.rule}" (${g.count}; git_status integrity lists them with hints) through Mandate, one element at a time, and tell me which are acceptable gaps.`;
  return (
    <li className="ov-wgroup" data-rule={g.rule}>
      <div className="ov-wgroup-row">
        <button type="button" className="ov-wgroup-toggle" aria-expanded={open} onClick={() => setOpen((x) => !x)} data-testid={`wgroup-${g.rule}`}>
          <IconChevronRight size={13} className="ov-chev" />
          <span className="ov-wgroup-icon" aria-hidden>
            {RULE_ICON(g.rule)}
          </span>
          <span className="ov-wgroup-label">{label}</span>
          <span className="ov-wgroup-bar" aria-hidden>
            <span style={{ width: `${Math.max(4, pct(g.count, max))}%` }} />
          </span>
          <span className="ov-wgroup-n">{g.count}</span>
        </button>
        <CopyPromptButton prompt={prompt} label="Copy prompt" testId={`copy-${g.rule}`} />
      </div>
      {open && (
        <ul className="ov-wgroup-items" data-testid={`witems-${g.rule}`}>
          {g.items.map((i) => (
            <li key={i.uri} className="ov-witem" title={i.message}>
              <RefChip to={i.uri} />
              <ItemMenu
                label={`${g.rule} on ${i.uri}`}
                prompt={itemPrompt('fix_integrity', i.uri, g.rule)}
                actions={[{ id: 'snooze', label: 'Snooze', dialog: { type: 'snooze', rule: g.rule, uri: i.uri, title: `${label}: ${i.uri.split('/').slice(-1)[0]}` } }]}
              />
            </li>
          ))}
          {g.count > g.items.length && <li className="ov-muted">+{g.count - g.items.length} more</li>}
        </ul>
      )}
    </li>
  );
}

export function Warnings({ o, projectId }: { o: ProjectOverview; projectId: string }) {
  const groups = o.warningGroups;
  const max = Math.max(1, ...groups.map((g) => g.count));
  return (
    <Card id="warnings" icon={<IconAlertTriangle size={15} />} title="Integrity warnings" count={o.attention.integrityWarnings} action={groups.length ? <CopyPromptButton prompt={allPrompts.warnings(projectId)} /> : undefined}>
      {groups.length === 0 ? (
        <Empty icon={<IconCircleCheck size={18} stroke={1.5} />} title="No open integrity warnings ✓">
          {o.attention.integritySnoozed ? `${plural(o.attention.integritySnoozed, 'warning')} snoozed.` : 'Gaps such as unowned code or components without standards appear here.'}
        </Empty>
      ) : (
        <>
          <ul className="ov-list ov-wgroups">
            {groups.map((g) => (
              <WarningGroup key={g.rule} g={g} max={max} projectId={projectId} />
            ))}
          </ul>
          {o.attention.integritySnoozed > 0 && <div className="ov-foot ov-muted">{plural(o.attention.integritySnoozed, 'warning')} snoozed</div>}
        </>
      )}
    </Card>
  );
}
