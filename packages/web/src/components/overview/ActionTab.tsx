/** Overview tab "Action needed": decisions, blocked items, specs needing attention, open must findings. */
import { Button, Skeleton, Tooltip } from "@mantine/core";
import { copyText } from "../../lib/copy";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconClipboardList,
  IconFileText,
  IconGavel,
  IconListCheck,
  IconLock,
  IconMessageReport,
  IconShieldCheck,
  IconUserCheck,
  IconRuler2,
  IconClockPause,
  IconSparkles,
} from "@tabler/icons-react";
import { Link } from "react-router";
import {
  DECISION_KINDS,
  type Decision,
  type DecisionKind,
  type DecisionsList,
  type OverviewBlocked,
  type ProjectOverview,
} from "@mandate/shared";
import { buildRef } from "@mandate/shared/refs";
import { refHref } from "../refs/kinds";
import { RefChip } from "../refs/RefChip";
import {
  CopyPromptButton,
  ItemMenu,
  feedbackActions,
  type ItemAction,
} from "../decisions/DecisionActions";
import {
  allPrompts,
  decisionPrompt,
  decisionsPrompt,
  itemPrompt,
  type ItemAction as PromptAction,
} from "../../lib/prompts";
import type { AttentionFocus } from "../../lib/overview";
import { Capped, Card, Empty, When, plural } from "./parts";
import { QuestionGroup } from "../questions/QuestionGroup";

const CAP = 5;

/* ---------------------------------------------------------------- decisions */

export const DECISION_GROUP: Record<DecisionKind, string> = {
  integrity_error: "Integrity errors",
  feedback_open: "Open feedback",
  feedback_accepted: "Accepted feedback without a work order",
  waiver_pending: "Waivers not in effect",
  approval_override: "Approval overrides to review",
  standard_draft: "Draft standards awaiting confirmation",
  stale_claim: "Stale claims",
  audit_contradicted: "Contradicted audit passes",
  spec_drifted: "Drifted done specs",
  question: "Questions from agents",
};

/** Direct decisions per kind (pure human decisions only); everything else goes through the agent prompt. */
export function decisionActions(d: Decision): ItemAction[] {
  if (d.kind === "feedback_open")
    return feedbackActions(d.ref, d.title, { status: "open" });
  if (d.kind === "feedback_accepted")
    return feedbackActions(d.ref, d.title, { status: "accepted" });
  if (d.kind === "stale_claim") {
    const m = /^claimed by (\S+); last heartbeat (.+)$/.exec(d.context ?? "");
    return [
      {
        id: "release",
        label: "Release claim",
        primary: true,
        dialog: {
          type: "release",
          ref: d.ref,
          title: d.ref.split("/").pop() ?? d.ref,
          ...(m ? { agent: m[1], heartbeat: m[2] } : {}),
        },
      },
    ];
  }
  if (d.kind === "waiver_pending" && d.feedback) {
    const fb = buildRef({ kind: "feedback", id: d.feedback });
    const title = `${d.feedback} (waiver of ${d.title})`;
    return [
      {
        id: "approve",
        label: d.selfApproval ? "Approve with override" : "Approve",
        primary: true,
        dialog: {
          type: "accept",
          ref: fb,
          title,
          selfApproval: d.selfApproval,
        },
      },
      {
        id: "decline",
        label: "Decline",
        danger: true,
        dialog: { type: "reject", ref: fb, title },
      },
    ];
  }
  return [];
}

/** Group icon per decision kind (tinted in CSS by data-kind). */
const GROUP_ICON: Partial<Record<DecisionKind, typeof IconGavel>> = {
  integrity_error: IconAlertTriangle,
  feedback_open: IconMessageReport,
  feedback_accepted: IconMessageReport,
  waiver_pending: IconShieldCheck,
  approval_override: IconUserCheck,
  standard_draft: IconRuler2,
  stale_claim: IconClockPause,
  audit_contradicted: IconListCheck,
  spec_drifted: IconFileText,
};

/** One decision: element title (links to it) + one muted line of why, age, then a consistent action cluster. */
function DecisionRow({ d, overrideOk }: { d: Decision; overrideOk: boolean }) {
  // Self-approvals are offered only to eligible users (admins / sole active user).
  const actions = decisionActions(d).filter((a) => !(a.dialog.type === "accept" && a.dialog.selfApproval && !overrideOk));
  const suggested = d.suggested ? d.options.find((x) => x.id === d.suggested)?.label : undefined;
  const why = d.context ?? d.question;
  const prompt = decisionPrompt(d);
  const hasPrimary = actions.some((a) => a.primary);
  return (
    <li className="dec-row" data-kind={d.kind}>
      <div className="dec-main">
        <Tooltip label={d.question} multiline maw={420} openDelay={400} withinPortal>
          <Link to={refHref(d.ref) ?? "#"} className="dec-title">
            {d.title}
          </Link>
        </Tooltip>
        <div className="dec-why">{why}</div>
      </div>
      <div className="dec-side">
        {suggested && <span className="dec-suggested">{suggested}</span>}
        {d.since && (
          <span className="dec-age">
            <When iso={d.since} />
          </span>
        )}
        {!hasPrimary && (
          <Tooltip label="Copy a prompt that asks your coding agent to handle this" openDelay={300}>
            <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconSparkles size={13} />} onClick={() => void copyText(prompt, "Prompt copied: paste it into your coding agent")}>
              Ask agent
            </Button>
          </Tooltip>
        )}
        <ItemMenu label={d.title} prompt={prompt} actions={actions} />
      </div>
    </li>
  );
}

export function Decisions({
  q,
  projectId,
  overrideOk,
}: {
  q: { data?: DecisionsList; isPending: boolean; error: unknown };
  projectId: string;
  overrideOk: boolean;
}) {
  const items = q.data?.items ?? [];
  const groups = DECISION_KINDS.map((k) => ({
    k,
    items: items.filter((d) => d.kind === k),
  })).filter((g) => g.items.length);
  return (
    <Card
      id="decisions"
      icon={<IconGavel size={15} />}
      title="Needs a decision"
      count={q.data?.total}
      wide
      action={
        q.data && q.data.total > 0 ? (
          <CopyPromptButton
            prompt={decisionsPrompt(projectId)}
            label="Resolve with your coding agent"
            testId="resolve-with-agent"
          />
        ) : undefined
      }
    >
      {q.isPending ? (
        <div className="ov-skeleton">
          {[0, 1, 2].map((i) => (
            <Skeleton
              key={i}
              height={14}
              width={`${85 - i * 15}%`}
              radius="sm"
            />
          ))}
        </div>
      ) : q.error ? (
        <Empty
          icon={<IconAlertTriangle size={18} stroke={1.5} />}
          title="Pending decisions could not be loaded"
        >
          {(q.error as Error).message}
        </Empty>
      ) : groups.length === 0 ? (
        <Empty
          icon={<IconCircleCheck size={18} stroke={1.5} />}
          title="No decisions pending"
        >
          Questions from coding agents, open feedback, waivers awaiting
          approval, approval overrides, draft standards, stale claims and
          integrity errors appear here.
        </Empty>
      ) : (
        <div className="ov-groups ov-groups-cols">
          {groups.map((g) =>
            g.k === "question" ? (
              <QuestionGroup
                key={g.k}
                items={g.items}
                title={`${DECISION_GROUP[g.k]} · ${q.data!.counts[g.k] ?? g.items.length}`}
              />
            ) : (
              <div
                key={g.k}
                className="ov-group"
                data-testid={`decisions-${g.k}`}
              >
                <div className="dec-group-head" data-kind={g.k}>
                  {(() => {
                    const I = GROUP_ICON[g.k] ?? IconGavel;
                    return (
                      <span className="dec-group-icon">
                        <I size={13} />
                      </span>
                    );
                  })()}
                  <span>{DECISION_GROUP[g.k]}</span>
                  <span className="dec-group-count">{q.data!.counts[g.k]}</span>
                </div>
                <Capped
                  items={g.items}
                  cap={CAP}
                  render={(d) => (
                    <DecisionRow
                      key={`${d.kind}|${d.ref}`}
                      d={d}
                      overrideOk={overrideOk}
                    />
                  )}
                />
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- blocked */

function BlockedRow({ b }: { b: OverviewBlocked }) {
  return (
    <li className="ov-blocked">
      <div className="ov-blocked-what">
        <span className="ov-blocked-icon" aria-hidden>
          {b.kind === "work_order" ? (
            <IconClipboardList size={14} />
          ) : (
            <IconFileText size={14} />
          )}
        </span>
        <Link
          to={
            b.kind === "work_order"
              ? `/work-orders/${b.id}`
              : `/specs/${b.specId}#section-${b.uri.split("/sections/")[1]}`
          }
          className="ov-blocked-title"
        >
          {b.kind === "work_order" && (
            <span className="mono ov-id">{b.id}</span>
          )}{" "}
          {b.title}
        </Link>
        {b.kind === "section" && (
          <span className="ov-muted">in {b.specTitle ?? b.specId}</span>
        )}
      </div>
      <span className="ov-row-menu">
        <ItemMenu
          label={b.title}
          prompt={itemPrompt("resolve_blocker", b.uri)}
        />
      </span>
      <ul className="ov-chain" aria-label="Blocked by">
        {b.blockedBy.length === 0 && (
          <li className="ov-muted">Waiting on a dependency</li>
        )}
        {b.blockedBy.slice(0, 3).map((x) => (
          <li key={x.uri} className="ov-chain-item">
            <IconLock size={12} className="ov-chain-lock" />
            <span className="ov-muted">waits on</span>
            <RefChip to={x.uri} />
            <span className="ov-muted">
              {x.state === "work_order"
                ? x.workOrder
                  ? `${x.workOrder.status.replace(/_/g, " ")}${x.workOrder.agent ? ` · ${x.workOrder.agent}` : ""}`
                  : "not done"
                : x.state === "broken"
                  ? "missing or archived"
                  : x.workOrder
                    ? `not implemented · ${x.workOrder.id} ${x.workOrder.status.replace(/_/g, " ")}`
                    : "not implemented · no work order yet"}
            </span>
          </li>
        ))}
        {b.blockedBy.length > 3 && (
          <li className="ov-muted">+{b.blockedBy.length - 3} more</li>
        )}
      </ul>
    </li>
  );
}

export function Blocked({
  o,
  projectId,
}: {
  o: ProjectOverview;
  projectId: string;
}) {
  return (
    <Card
      id="blocked"
      icon={<IconLock size={15} />}
      title="Blocked"
      count={o.blockedTotal}
      action={
        o.blockedTotal > 0 ? (
          <CopyPromptButton prompt={allPrompts.blocked(projectId)} />
        ) : undefined
      }
    >
      {o.blocked.length === 0 ? (
        <Empty
          icon={<IconCircleCheck size={18} stroke={1.5} />}
          title="Nothing is blocked"
        >
          Sections and work orders show up here when they depend on work that is
          not implemented yet.
        </Empty>
      ) : (
        <>
          <Capped
            items={o.blocked}
            cap={CAP}
            render={(b) => <BlockedRow key={b.uri} b={b} />}
          />
          {o.blockedTotal > o.blocked.length && (
            <div className="ov-foot ov-muted">
              +{o.blockedTotal - o.blocked.length} more not listed
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- specs needing attention, must findings */

const OVERLAY_ACTION: Record<string, PromptAction> = {
  failing: "fix_failing",
  drifted: "reverify_drift",
  blocked: "resolve_blocker",
  stale: "verify",
};

export function AttentionSpecs({
  o,
  projectId,
  focus,
}: {
  o: ProjectOverview;
  projectId: string;
  focus?: AttentionFocus;
}) {
  const filter =
    focus && ["failing", "drifted", "blocked", "stale"].includes(focus)
      ? focus
      : undefined;
  const list = o.attention.specs.filter((s) => !filter || s.overlay === filter);
  return (
    <Card
      id="attention"
      icon={<IconAlertTriangle size={15} />}
      title={
        filter
          ? `Specs needing attention: ${filter}`
          : "Specs needing attention"
      }
      count={list.length}
      action={
        <>
          {filter && (
            <Link to="?tab=action" className="ov-more" replace>
              Show all
            </Link>
          )}
          {list.length > 0 && (
            <CopyPromptButton prompt={allPrompts.attention(projectId)} />
          )}
        </>
      }
    >
      {list.length === 0 ? (
        <Empty
          icon={<IconCircleCheck size={18} stroke={1.5} />}
          title={filter ? `No ${filter} specs` : "Every spec is on track"}
        >
          Specs with failing, drifted, blocked or stale verification show up
          here with what to do next.
        </Empty>
      ) : (
        <Capped
          items={list}
          cap={CAP}
          render={(s) => {
            const kind = s.overlay;
            const uri = buildRef({ kind: "specs", id: s.id });
            return (
              <li key={s.id} className="ov-spec" data-overlay={kind}>
                <div className="ov-decision-row">
                  <div className="ov-decision-main">
                    <Link to={`/specs/${s.id}`} className="ov-blocked-title">
                      {s.title}
                    </Link>
                    <div className="ov-decision-meta">
                      <span
                        className="ov-status"
                        data-status={
                          kind === "failing" || kind === "drifted"
                            ? "danger"
                            : "warn"
                        }
                      >
                        {kind[0]!.toUpperCase() + kind.slice(1)}
                      </span>
                      <span className="ov-muted">{s.label}</span>
                    </div>
                    {s.reason && (
                      <div className="ov-muted ov-reason">{s.reason}</div>
                    )}
                  </div>
                  <ItemMenu
                    label={s.title}
                    prompt={itemPrompt(OVERLAY_ACTION[kind] ?? "verify", uri)}
                  />
                </div>
              </li>
            );
          }}
        />
      )}
    </Card>
  );
}

export function MustFindings({ o }: { o: ProjectOverview }) {
  const list = o.mustFindingSpecs;
  return (
    <Card
      id="findings"
      icon={<IconListCheck size={15} />}
      title="Open must findings"
      count={o.attention.mustFindings}
    >
      {list.length === 0 ? (
        <Empty
          icon={<IconCircleCheck size={18} stroke={1.5} />}
          title="No open must findings"
        >
          Must findings of the latest audits appear here until a fix work order
          resolves them.
        </Empty>
      ) : (
        <Capped
          items={list}
          cap={CAP}
          render={(s) => (
            <li key={s.id} className="ov-spec">
              <div className="ov-decision-row">
                <div className="ov-decision-main">
                  <Link
                    to={refHref(s.audit) ?? `/specs/${s.id}`}
                    className="ov-blocked-title"
                  >
                    {s.title}
                  </Link>
                  <div className="ov-decision-meta">
                    <span className="ov-status" data-status="danger">
                      {plural(s.openMust, "must finding")}
                    </span>
                    <RefChip to={s.audit} />
                  </div>
                </div>
                <ItemMenu
                  label={s.title}
                  prompt={itemPrompt(
                    "fix_failing",
                    buildRef({ kind: "specs", id: s.id }),
                    "Start with the open must findings of its latest audit (audit_findings_to_work_orders).",
                  )}
                />
              </div>
            </li>
          )}
        />
      )}
    </Card>
  );
}
