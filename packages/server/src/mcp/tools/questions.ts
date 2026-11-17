/**
 * Questions through Mandate: an agent asks the user (`question_ask`, AskUserQuestion shape + recommended), keeps
 * working, and picks the answer up later (`notifications/mandate/question_answered` to the asking session, or
 * `questions_list { mine, status: answered }`). The user answers in the web UI (`question_answer`, uiAllowed); on
 * agents never answer for the user. Answered questions are proof: a write
 * citing one as `cause` records who confirmed / approved (`questionProof`).
 */
import {
  questionAnswerInputSchema,
  questionAskInputSchema,
  questionCancelInputSchema,
  questionGetInputSchema,
  questionsListInputSchema,
  SERVICE_USER_PREFIX,
  type Question,
  type QuestionActor,
  type QuestionPurpose,
} from '@mandate/shared';
import { clientIdentity } from '../../projects/settings.js';
import { questionCauses, QuestionError } from '../../storage/questions.js';
import { defineTool, principalUser, UI_AGENT, type ToolContext, type WriteMeta } from '../define.js';
import { ToolError } from '../errors.js';

export const QUESTION_ANSWERED_NOTIFICATION = 'notifications/mandate/question_answered';

const actor = (ctx: ToolContext): QuestionActor => {
  const user = principalUser(ctx);
  return { agent: ctx.commit!.agent, ...(user ? { user } : {}), ...(ctx.principal?.kind === 'ui' ? {} : { client: clientIdentity(ctx).id }) };
};
const meta = (ctx: ToolContext, commits: string[]) => ({
  agent: ctx.commit!.agent,
  ...(ctx.commit!.branch ? { branch: ctx.commit!.branch } : {}),
  trailers: { ...ctx.commit!.trailers },
  onCommit: (sha: string) => commits.push(sha),
});
const done = (q: Question, commits: string[], extra: Record<string, unknown> = {}) => ({ question: q, ref: q.uri, commit: commits.at(-1) ?? null, commits, ...extra, warnings: [] });

/** Elements a question concerns: the element itself or one of its sections. */
const about = (q: Question, ref: string) => q.context.some((c) => c === ref || c.startsWith(`${ref}/`));

/**
 * Validate the answered questions a write cites as cause, for a purpose. Returns the proof (question id and who
 * answered) or null when the write cites no question of that purpose. Throws when a cited question of the purpose is
 * not answered, or was answered by someone who may not confirm (team: a signed-in user, who needs push access to
 * answer in the web UI; never an agent).
 */
export async function questionProof(ctx: ToolContext, purposes: QuestionPurpose[]): Promise<{ id: string; by: string; user?: string } | null> {
  const ids = questionCauses(ctx.commit?.causes);
  let proof: { id: string; by: string; user?: string } | null = null;
  for (const id of ids) {
    const q = await ctx.storage.questionService.get(id);
    if (!purposes.includes(q.purpose)) continue;
    if (q.status !== 'answered' || !q.answer) throw new QuestionError('question_not_answered', `question ${id} is ${q.status}: only an answered question proves the user's ${q.purpose.replace('_', ' ')}`);
    const user = q.answer.by.user;
    if (ctx.settings && (!user || user.startsWith(SERVICE_USER_PREFIX) || q.answer.via !== 'ui')) {
      throw new QuestionError('question_ineligible', `question ${id} was not answered by a signed-in user with write access (answered by ${user ?? q.answer.by.agent})`, 403);
    }
    proof ??= { id, by: user ?? q.answer.by.agent, ...(user ? { user } : {}) };
  }
  return proof;
}

/** Commit metadata with extra trailers (proof of a confirmation / approval). */
export const withTrailers = (ctx: ToolContext, extra: Record<string, string>): ToolContext => ({ ...ctx, commit: { ...(ctx.commit as WriteMeta), trailers: { ...ctx.commit!.trailers, ...extra } } });

const ASK_DESC = `Ask the USER a question through Mandate instead of your harness's question tool: 1-4 questions, each with a header (max 12 chars), 2-4 options { label, description }, the recommended label and multiSelect; optional title (e.g. the standard's name), badge (e.g. MUST) and evidence [{ ref: repo:path#Lx-Ly, conforming, violating }]. purpose: decision | standard_confirmation | approval | clarification | other; context: the refs it concerns; blocking: true if nothing can progress without it. Keep working on what does not depend on it; the answer is pushed (never poll) or via list { of: "questions", mine: true, status: "answered" }. Cite the answered question as cause of the writes it decides.
Example: {"purpose":"decision","context":["mandate://specs/login-sso"],"questions":[{"header":"Session","question":"How long should remember-me last?","options":[{"label":"30 days","description":"Common default"},{"label":"7 days","description":"Safer"}],"recommended":"30 days"}]}`;

export const questionTools = [
  defineTool({
    name: 'question_ask',
    title: 'Ask the user',
    kind: 'write',
    description: ASK_DESC,
    input: questionAskInputSchema,
    run: async (a, ctx) => {
      if (ctx.principal?.kind === 'ui') throw new ToolError('forbidden', 'questions are asked by agents', 'answer with question_answer');
      const commits: string[] = [];
      const q = await ctx.storage.questionService.ask(a as never, actor(ctx), meta(ctx, commits));
      // The asking session gets a notification when the question is answered (while it stays connected).
      ctx.session?.asked?.add(q.id);
      return done(q, commits, { next: 'Continue with work that does not depend on the answer; check list { of: "questions", mine: true, status: "answered" } at checkpoints. If everything is blocked, tell the user and stop.' });
    },
  }),
  defineTool({
    name: 'question_get',
    title: 'Get a question',
    kind: 'read',
    description: `A question with its status (open | answered | cancelled | superseded | expired) and the answer (answers by question id, notes, who).
Example: {"id":"ask-0001"}`,
    input: questionGetInputSchema,
    run: async (a, ctx) => ({ question: await ctx.storage.questionService.get(a.id) }),
  }),
  defineTool({
    name: 'questions_list',
    title: 'List questions',
    kind: 'read',
    description: `Questions asked through Mandate, newest first. status: open (default) | answered | closed | all; mine: only your client's; context: about an element; since: answered / asked after an ISO time. Other agents: check { mine: true, status: "answered", since } at checkpoints.
Example: {"mine":true,"status":"answered"}`,
    input: questionsListInputSchema,
    run: async (a, ctx) => {
      const me = clientIdentity(ctx).id;
      const all = (await ctx.storage.questionService.list()).filter(
        (q) =>
          (a.status === 'all' || (a.status === 'closed' ? q.status !== 'open' : q.status === a.status)) &&
          (!a.mine || q.asker.client === me) &&
          (!a.context || about(q, a.context.replace(/^@mandate:/, ''))) &&
          (!a.since || (q.answer?.at ?? q.cancelled?.at ?? q.createdAt) > a.since),
      );
      const items = all.sort((x, y) => (y.answer?.at ?? y.createdAt).localeCompare(x.answer?.at ?? x.createdAt));
      return { items: items.slice(0, a.limit), total: items.length };
    },
  }),
  defineTool({
    name: 'question_cancel',
    title: 'Cancel a question',
    kind: 'write',
    description: `Withdraw an open question (it no longer matters), with a reason. Answered or cancelled questions are frozen.
Example: {"id":"ask-0001","reason":"decided by the spec"}`,
    input: questionCancelInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      return done(await ctx.storage.questionService.cancel(a.id, a.reason, actor(ctx), meta(ctx, commits)), commits);
    },
  }),
  defineTool({
    name: 'question_answer',
    title: 'Answer a question',
    kind: 'write',
    uiAllowed: true,
    description: `Record the user's answer (the web UI does this). Agents cannot answer (the user answers in the web UI); never answer for the user. answers: { <question id>: label | [labels] (multiSelect) | free text }.
Example: {"id":"ask-0001","answers":{"q1":"30 days"}}`,
    input: questionAnswerInputSchema,
    run: async (a, ctx) => {
      const ui = ctx.principal?.kind === 'ui';
      if (!ui && ctx.settings) throw new ToolError('forbidden', 'questions are answered by the user in the Mandate web UI', 'tell the user the question is waiting in Mandate (Questions, or Actions)');
      const commits: string[] = [];
      const by = ui ? { agent: UI_AGENT, ...(principalUser(ctx) ? { user: principalUser(ctx)! } : {}) } : actor(ctx);
      return done(await ctx.storage.questionService.answer(a.id, a.answers, by, { ...(a.notes ? { notes: a.notes } : {}), via: ui ? 'ui' : 'chat' }, meta(ctx, commits)), commits);
    },
  }),
];
