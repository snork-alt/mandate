import { useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Typography } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconChevronRight, IconCopy, IconLoader2, IconPlayerStop, IconSearch, IconTerminal2, IconTool } from '@tabler/icons-react';
import { answerSegments, type AskResult, type AskToolCall, type ReferenceCheck } from '@mandate/shared';
import { copyText } from '../../lib/copy';
import { CodeBlock } from '../CodeBlock';
import { renderSnippet } from '../../mcp/snippet';
import { markdownComponents } from '../Markdown';
import { GraphEmbed, RefChip, RefCheckContext, RefEmbed } from '../refs';
import { RefTable } from '../refs/TableEmbed';
import type { AskTurn } from './AskProvider';

const isRefHref = (h?: string) => !!h && /^(@mandate:)?mandate:\/\//.test(h);
const text = (children: ReactNode): string | undefined => (typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : undefined);

const answerComponents: Components = {
  ...markdownComponents,
  a: ({ href, children, node: _n, ...rest }) =>
    isRefHref(href) ? (
      <RefChip to={href!} label={text(children)} />
    ) : (
      <a href={href} {...rest} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

/** Markdown where reference links become reference chips (links keep their text as label). */
export function AnswerMarkdown({ children }: { children: string }) {
  return (
    <Typography className="markdown ask-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={answerComponents} urlTransform={(u) => u}>
        {children}
      </ReactMarkdown>
    </Typography>
  );
}

/** While streaming, an embed fence that is still open is hidden (it renders once complete). */
export const hideOpenFence = (md: string) => md.replace(/```mandate-[a-z]+[^\n]*\n(?:(?!```)[\s\S])*$/, '');

/** The finished answer: prose with ref chips, embeds in place, unresolved references listed visibly. */
export function AnswerView({ result }: { result: AskResult }) {
  const checks = useMemo(() => new Map<string, ReferenceCheck>(result.references.map((r) => [r.ref, r])), [result]);
  const unresolved = result.references.filter((r) => !r.resolved);
  return (
    <RefCheckContext.Provider value={checks}>
      <div className="ask-answer" data-testid="ask-answer">
        {answerSegments(result.answer).map((seg, i) => {
          if (seg.type === 'markdown') return <AnswerMarkdown key={i}>{seg.text}</AnswerMarkdown>;
          const e = result.embeds[seg.index];
          if (!e) return null;
          if (e.kind === 'mandate-embed') return <RefEmbed key={i} uri={e.ref} />;
          if (e.kind === 'mandate-table') return <div key={i} className="embed-card"><RefTable columns={e.columns} rows={e.rows} /></div>;
          if (e.kind === 'mandate-graph') return <GraphEmbed key={i} refs={e.refs} depth={e.depth} />;
          return (
            <div key={i} className="embed-card" data-invalid role="alert">
              <IconAlertTriangle size={13} /> Could not render {e.block}: {e.error}
            </div>
          );
        })}
        {unresolved.length > 0 && (
          <div className="ask-unresolved">
            <div className="rail-faint">Unresolved references ({unresolved.length})</div>
            <div className="ref-chips">
              {unresolved.map((r) => (
                <RefChip key={r.ref} to={r.ref} check={r} />
              ))}
            </div>
          </div>
        )}
        <div className="ask-answer-actions">
          <button type="button" onClick={() => void copyText(result.answer, 'Copied answer')}>
            <IconCopy size={12} /> Copy answer
          </button>
          <span className="rail-faint">
            <span className="ask-model-tag" title={`${result.provider}/${result.model}`} data-testid="answer-model">
              {result.modelLabel ?? result.model}
            </span>{' '}
            · {result.usage.inputTokens + result.usage.outputTokens} tokens
          </span>
        </div>
      </div>
    </RefCheckContext.Provider>
  );
}

const q = (v: unknown) => (typeof v === 'string' ? `“${v}”` : '');

/** One-line description of a tool call ("Searched “refresh token” · 6 hits"). */
export function stepTitle(name: string, args: unknown, summary?: string): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const tail = summary ? ` · ${summary}` : '';
  switch (name) {
    case 'search':
      return `Searched ${q(a.q)}${tail}`;
    case 'text_search':
      return `Text search ${q(a.q)}${tail}`;
    case 'symbol_search':
      return `Symbol ${q(a.name)}${tail}`;
    case 'code_search':
      return `Code references ${q(a.path ?? a.repo ?? a.glob)}${tail}`;
    case 'graph_query':
      return `Cypher${tail}`;
    case 'graph_neighbors':
    case 'graph_node':
      return `Looked at ${typeof a.uri === 'string' ? a.uri.replace(/^mandate:\/\//, '') : 'a node'}${tail}`;
    case 'graph_search':
      return `Graph search ${q(a.q ?? a.query)}${tail}`;
    case 'graph_schema':
      return `Read the graph schema${tail.replace(' · done', '')}`;
    default: {
      const human = name.replace(/_/g, ' ');
      return `${human.charAt(0).toUpperCase()}${human.slice(1)}${tail}`;
    }
  }
}

interface Hit { uri: string; sectionTitle?: string; snippet?: string }
interface Group { docUri: string; docTitle: string; hits: Hit[] }

/** Rich rendering of a tool result: search hits with <mark> snippets, Cypher table, neighbour lists. */
/** The Cypher a graph_query step ran (with params / time point), shown above its result. */
function CypherQuery({ args }: { args: unknown }) {
  const a = (args ?? {}) as { query?: unknown; params?: Record<string, unknown>; at?: unknown };
  if (typeof a.query !== 'string') return null;
  const params = a.params && Object.keys(a.params).length ? a.params : null;
  return (
    <div className="ask-cypher">
      <CodeBlock code={a.query.trim()} lang="cypher" />
      {(params || a.at != null) && (
        <div className="rail-faint ask-cypher-meta">
          {params && <span>params {JSON.stringify(params)}</span>}
          {a.at != null && <span>at {String(a.at)}</span>}
        </div>
      )}
    </div>
  );
}

export function ToolResult({ call }: { call: AskToolCall }) {
  if (call.name === 'graph_query') {
    return (
      <>
        <CypherQuery args={call.args} />
        <ToolResultBody call={call} />
      </>
    );
  }
  return <ToolResultBody call={call} />;
}

function ToolResultBody({ call }: { call: AskToolCall }) {
  const r = call.result as Record<string, unknown> | undefined;
  if (call.error) return <div className="ask-error">{call.error.code}: {call.error.message}</div>;
  if (!r) return null;
  if (call.name === 'search' && Array.isArray(r.groups)) {
    return (
      <div className="ask-hits">
        {(r.groups as Group[]).map((g) => (
          <div key={g.docUri}>
            <RefChip to={g.docUri} label={g.docTitle} />
            {g.hits.map((h) => (
              <div key={h.uri} className="ask-hit">
                {h.sectionTitle && <span className="ask-hit-title">{h.sectionTitle}</span>}
                {h.snippet && <div className="cmdk-snippet">{renderSnippet(h.snippet)}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (call.name === 'graph_query' && Array.isArray(r.columns) && Array.isArray(r.rows)) return <RefTable columns={r.columns as string[]} rows={r.rows as unknown[][]} truncated={!!r.truncated} />;
  if (call.name === 'text_search' && Array.isArray(r.matches)) {
    return (
      <div className="ask-hits">
        {(r.matches as { uri: string; docTitle: string; line: number; text: string }[]).map((m, i) => (
          <div key={i} className="ask-hit">
            <RefChip to={m.uri} label={`${m.docTitle} L${m.line}`} />
            <div className="cmdk-snippet cmdk-mono">{renderSnippet(m.text.trim())}</div>
          </div>
        ))}
      </div>
    );
  }
  const nodes = (r.nodes ?? (r.node ? [r.node] : undefined)) as { ref: string; label?: string }[] | undefined;
  if (Array.isArray(nodes)) {
    return (
      <div className="ref-chips">
        {nodes.map((n) => (
          <RefChip key={n.ref} to={n.ref} label={n.label} resolve={false} />
        ))}
      </div>
    );
  }
  // No raw JSON: the one-line summary is enough.
  return call.summary ? <div className="rail-faint">{call.summary}</div> : null;
}

const stepIcon = (name: string) => (name === 'graph_query' ? <IconTerminal2 size={13} /> : name.includes('search') ? <IconSearch size={13} /> : <IconTool size={13} />);

/** One tool call as a single quiet line; the details (result chips) only on click. */
export function ToolStep({ call }: { call: AskToolCall; open?: boolean }) {
  return (
    <details className="ask-step" data-ok={call.ok}>
      <summary>
        {call.ok ? stepIcon(call.name) : <IconAlertTriangle size={13} />}
        <span className="ask-step-title">{stepTitle(call.name, call.args, call.summary)}</span>
        <span className="rail-faint ask-step-ms">{call.ms} ms</span>
      </summary>
      <div className="ask-step-body">
        <ToolResult call={call} />
      </div>
    </details>
  );
}

/** All tool calls of a turn behind one collapsed line ("Used 3 tools"); open while still running. */
function ToolSteps({ calls, running }: { calls: AskToolCall[]; running: AskTurn['state']['running'] }) {
  const failed = calls.filter((c) => !c.ok).length;
  const ms = calls.reduce((n, c) => n + c.ms, 0);
  const label = running.length ? `Using tools… ${calls.length + 1}` : `Used ${calls.length} tool${calls.length === 1 ? '' : 's'}`;
  return (
    <details className="ask-steps" open={running.length > 0 || undefined}>
      <summary>
        {running.length ? <IconLoader2 size={13} className="ask-spin" /> : <IconTool size={13} />}
        <span>{label}</span>
        {failed > 0 && <span className="ask-steps-failed">{failed} failed</span>}
        {!running.length && <span className="rail-faint ask-step-ms">{ms} ms</span>}
        <IconChevronRight size={12} className="ask-steps-chevron" />
      </summary>
      <div className="ask-steps-list">
        {calls.map((c) => (
          <ToolStep key={c.id} call={c} />
        ))}
        {running.map((r) => (
          <div key={r.id} className="ask-step-running">
            <IconLoader2 size={13} className="ask-spin" /> <span className="ask-step-title">{stepTitle(r.name, r.args)}…</span>
          </div>
        ))}
      </div>
    </details>
  );
}

export function AskTurnView({ turn, stepsOpen }: { turn: AskTurn; stepsOpen?: boolean }) {
  const { state } = turn;
  const steps = state.toolCalls.length + state.running.length;
  return (
    <div className="ask-turn">
      <div className="ask-q">{turn.question}</div>
      {steps > 0 && (
        <ToolSteps calls={state.toolCalls} running={state.running} />
      )}
      {state.result ? (
        <AnswerView result={state.result} />
      ) : (
        state.text && (
          <div className="ask-answer" data-streaming>
            <AnswerMarkdown>{hideOpenFence(state.text)}</AnswerMarkdown>
          </div>
        )
      )}
      {turn.running && !state.text && state.running.length === 0 && <div className="rail-faint ask-thinking"><IconLoader2 size={13} className="ask-spin" /> Thinking…</div>}
      {state.stopped && <div className="rail-faint"><IconPlayerStop size={12} /> Stopped</div>}
      {state.error && (
        <div className="ask-error" role="alert">
          <IconAlertTriangle size={13} /> {state.error.message}
        </div>
      )}
    </div>
  );
}
