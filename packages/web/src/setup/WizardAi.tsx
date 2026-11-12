/**
 * The setup wizard's AI steps: Ask models (a list of many models with a default, plus an inline "Add a model" panel)
 * and Semantic search (embedding provider cards, model, key, Test detects the vector size). Both are optional. They use
 * the same APIs as Settings; keys are write-only (sent once to ~/.mandate/secrets.env, never read back or logged).
 */
import { Button, TextInput } from '@mantine/core';
import { IconCheck, IconInfoCircle, IconMessageCircle, IconPencil, IconPlus, IconStar, IconTrash, IconX } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { UiApiError } from '../lib/ui';
import { modelConfigId, SECRET_DEFAULTS, setupApi, type AskModelConfig, type AskProvider, type EmbeddingPreset, type SetupState } from './api';
import { pickChatModel, usePatchConfig } from './sections';
import { REMOTE_PRESETS } from './SearchSection';
import { Chip, ContinueButton, ENV_RE, Field, hostOf, KeyChip, keyEnvForUrl, markOfUrl, ModelCombo, ProviderMark, ResultLine, SECRET_HINT, SecretInput, StepHead, TestBtn, WizardFooter, type MarkKind } from './wizardKit';
import { errText } from './WizardSteps';

type Result = { ok: boolean; text: string; sub?: string } | null;

/* ------------------------------------------------------------------ Ask models */

type AskKind = 'anthropic' | 'openai' | 'google' | 'compatible';
const ASK_KINDS: { id: AskKind; label: string; sub: string; mark: MarkKind; provider: AskProvider; keyEnv: string; name: string }[] = [
  { id: 'anthropic', label: 'Anthropic', sub: 'Claude models', mark: 'anth', provider: 'anthropic', keyEnv: SECRET_DEFAULTS.anthropic, name: 'Anthropic' },
  { id: 'openai', label: 'OpenAI', sub: 'GPT models', mark: 'oai', provider: 'openai', keyEnv: SECRET_DEFAULTS.openai, name: 'OpenAI' },
  { id: 'google', label: 'Google', sub: 'Gemini models', mark: 'goog', provider: 'google', keyEnv: SECRET_DEFAULTS.google, name: 'Google' },
  { id: 'compatible', label: 'Other URL', sub: 'OpenAI-compatible', mark: 'url', provider: 'openai-compatible', keyEnv: '', name: '' },
];
const DEFAULT_HOST: Partial<Record<AskProvider, string>> = { anthropic: 'api.anthropic.com', openai: 'api.openai.com', google: 'generativelanguage.googleapis.com' };
const kindOf = (m: AskModelConfig) => ASK_KINDS.find((k) => k.provider === m.provider) ?? ASK_KINDS[3]!;
const markOf = (m: AskModelConfig): MarkKind => (m.provider === 'openai-compatible' ? markOfUrl(m.baseUrl) : kindOf(m).mark);
const subOf = (m: AskModelConfig) => {
  const host = m.baseUrl ? hostOf(m.baseUrl) : (DEFAULT_HOST[m.provider] ?? '');
  return m.provider === 'openai-compatible' ? host : `${kindOf(m).name} · ${host}`;
};
const strip = (ms: AskModelConfig[]) => ms.map(({ apiKeySet: _s, ...m }) => m);
const fmtSecs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Is a key already stored under this env var (for an Ask model or semantic search)? Returns who uses it. */
function keyOwner(state: SetupState, env: string): string | null {
  if (!env) return null;
  const m = state.config.ask.models.find((x) => x.apiKeyEnv === env && x.apiKeySet);
  if (m) return m.model;
  const e = state.config.embedding;
  return e.apiKeyEnv === env && e.apiKeySet ? 'semantic search' : null;
}

/** The inline "Add a model" / "Edit model" panel. */
function ModelPanel({ state, editing, onClose }: { state: SetupState; editing: AskModelConfig | null; onClose: () => void }) {
  const ask = state.config.ask;
  const [kind, setKind] = useState<AskKind>(editing ? kindOf(editing).id : 'anthropic');
  const k = ASK_KINDS.find((x) => x.id === kind)!;
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '');
  const [model, setModel] = useState(editing?.model ?? '');
  const [keyEnv, setKeyEnv] = useState(editing ? (editing.apiKeyEnv ?? '') : k.keyEnv);
  const [key, setKey] = useState('');
  const [result, setResult] = useState<Result>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = usePatchConfig();
  const suggestedEnv = kind === 'compatible' ? keyEnvForUrl(baseUrl) : k.keyEnv;
  const saved = !!keyOwner(state, keyEnv);
  const urlOk = /^https?:\/\/[^\s/]+/.test(baseUrl.trim());
  const conn = () => ({ provider: k.provider, ...(kind === 'compatible' ? { baseUrl: baseUrl.trim().replace(/\/+$/, '') } : {}), ...(key.trim() ? { apiKey: key.trim() } : keyEnv && saved ? { apiKeyEnv: keyEnv } : {}) });
  const canReach = (kind !== 'compatible' || urlOk) && (kind === 'compatible' || saved || !!key.trim());
  const list = useMutation({ mutationFn: () => setupApi.askModels(conn()), onSuccess: (r) => r.ok && setModel((m) => m || (pickChatModel(r.models, r.suggested) ?? '')) });
  const pick = (id: AskKind) => {
    const nk = ASK_KINDS.find((x) => x.id === id)!;
    setKind(id);
    setKeyEnv(id === 'compatible' ? keyEnvForUrl(baseUrl) : nk.keyEnv);
    setModel('');
    setResult(null);
    list.reset();
  };
  // Load the list as soon as the provider can be reached with a saved key.
  useEffect(() => {
    if (canReach && !key.trim()) list.mutate();
  }, [kind, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const test = useMutation({
    mutationFn: () => setupApi.askTest({ ...conn(), model: model.trim() }),
    onSuccess: (r) => setResult(r.ok ? { ok: true, text: 'It works', sub: `replied in ${fmtSecs(r.ms)}` } : { ok: false, text: r.message }),
    onError: (e) => setResult({ ok: false, text: errText(e) }),
  });
  const add = useMutation({
    mutationFn: async () => {
      if (kind === 'compatible' && !urlOk) throw new UiApiError('invalid_input', 'Enter the base URL of the OpenAI-compatible server', 'ask.baseUrl');
      if (!model.trim()) throw new UiApiError('invalid_input', 'Pick or type a model name', 'ask.model');
      if (keyEnv && !ENV_RE.test(keyEnv)) throw new UiApiError('invalid_input', 'The key variable uses capital letters, digits and _ (e.g. ANTHROPIC_API_KEY)', 'ask.apiKeyEnv');
      if (kind !== 'compatible' && !keyEnv) throw new UiApiError('invalid_input', 'Name the key variable', 'ask.apiKeyEnv');
      if (kind !== 'compatible' && !saved && !key.trim()) throw new UiApiError('invalid_input', 'Paste the API key (or skip the Ask models for now)', 'ask.apiKey');
      if (key.trim() && !keyEnv) throw new UiApiError('invalid_input', 'Name the key variable for this key', 'ask.apiKeyEnv');
      const id = modelConfigId(kind === 'compatible' ? 'compatible' : k.provider, model.trim());
      const others = ask.models.filter((m) => m.id !== editing?.id);
      if (others.some((m) => m.id === id)) throw new UiApiError('invalid_input', 'This model is already in the list', 'ask.model');
      if (key.trim()) await setupApi.secret(keyEnv, key.trim());
      const next: AskModelConfig = { ...(editing ? strip([editing])[0] : {}), id, provider: k.provider, model: model.trim(), baseUrl: kind === 'compatible' ? baseUrl.trim().replace(/\/+$/, '') : null, apiKeyEnv: keyEnv || null };
      const models = editing ? ask.models.map((m) => (m.id === editing.id ? next : m)) : [...ask.models, next];
      const def = editing && ask.default === editing.id ? id : (ask.default ?? id);
      await patch({ ask: { models: strip(models), default: def } as never });
    },
    onSuccess: () => {
      setKey('');
      onClose();
    },
    onError: (e) => setError(errText(e)),
  });
  return (
    <div className="wz-addp" data-testid="add-model">
      <div className="wz-addp-h">
        <b>{editing ? 'Edit model' : 'Add a model'}</b>
        <button type="button" className="wz-iconbtn" aria-label="Close" onClick={onClose} data-testid="add-model-close">
          <IconX size={15} />
        </button>
      </div>
      <div className="wz-addp-b">
        <Field label="Provider">
          <div className="wz-ptiles" role="radiogroup">
            {ASK_KINDS.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === kind} className="wz-pt" data-on={p.id === kind || undefined} onClick={() => pick(p.id)} data-testid={`wz-ask-${p.id}`}>
                <ProviderMark kind={p.mark} small />
                <span className="wz-pt-text">
                  <span className="wz-pt-n">{p.label}</span>
                  <span className="wz-pt-s">{p.sub}</span>
                </span>
                {p.id === kind && (
                  <span className="wz-pt-tick">
                    <IconCheck size={10} stroke={3.2} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </Field>
        {kind === 'compatible' && (
          <Field label="Base URL" hint="An OpenAI-compatible /v1 endpoint, e.g. http://localhost:11434/v1 for Ollama.">
            <TextInput
              className="wz-input wz-mono-input"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (keyEnv === keyEnvForUrl(baseUrl)) setKeyEnv(keyEnvForUrl(v));
                setBaseUrl(v);
                setResult(null);
              }}
              aria-label="Base URL"
              data-testid="wz-ask-base"
            />
          </Field>
        )}
        <Field
          label="Model"
          aside={list.data?.ok ? <span className="wz-aside">{list.data.models.length} models loaded</span> : null}
          error={list.data && !list.data.ok ? list.data.message : list.isError ? errText(list.error) : null}
          hint={<span className="wz-hint-swap" data-phone="Load models, then search the list or type any name.">Search the list, or type any model name.</span>}
        >
          <ModelCombo value={model} onChange={(v) => (setModel(v), setResult(null))} models={list.data?.ok ? list.data.models : null} onLoad={() => list.mutate()} loading={list.isPending} loadDisabled={!canReach} placeholder={kind === 'compatible' ? 'llama3.1' : 'Type or pick a model'} testId="wz-ask-model" />
        </Field>
        <div className="wz-grid2">
          <Field label="Key variable" aside={keyEnv && keyEnv === suggestedEnv ? <Chip className="wz-chip-xs">Suggested</Chip> : null} hint={kind === 'compatible' ? 'Leave empty if the server needs no key.' : 'The environment variable that holds the key.'}>
            <TextInput className="wz-input wz-mono-input" value={keyEnv} onChange={(e) => (setKeyEnv(e.currentTarget.value.toUpperCase()), setResult(null))} aria-label="Key variable" data-testid="wz-ask-keyenv" />
          </Field>
          <Field label="API key" aside={saved ? <Chip tone="ok" icon={<IconCheck size={12} stroke={2.4} />}>Saved</Chip> : null} hint={saved && keyOwner(state, keyEnv) !== editing?.model ? <>Already saved for {keyOwner(state, keyEnv)}. {SECRET_HINT}</> : SECRET_HINT}>
            <SecretInput value={key} onChange={(v) => (setKey(v), setResult(null))} saved={saved} testId="wz-ask-key" />
          </Field>
        </div>
      </div>
      <div className="wz-addp-f">
        <TestBtn loading={test.isPending} disabled={!model.trim() || !canReach} onClick={() => test.mutate()} testId="wz-ask-test" />
        {result ? <ResultLine result={result} /> : <span className="wz-hint wz-hide-phone">Test the model before adding it.</span>}
        <span className="wz-sp" />
        <button type="button" className="wz-btn wz-ghost wz-hide-phone" onClick={onClose}>
          Cancel
        </button>
        <Button className="wz-primary wz-add" leftSection={editing ? <IconCheck size={15} /> : <IconPlus size={15} />} loading={add.isPending} disabled={!model.trim()} onClick={() => (setError(null), add.mutate())} data-testid="add-model-submit">
          {editing ? 'Save model' : 'Add model'}
        </Button>
      </div>
      {error && (
        <div className="wz-err wz-addp-err" data-testid="wz-ask-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** The Ask models list (add, make default, edit, remove; each change is saved at once). */
export function AskModels({ state, panel, setPanel }: { state: SetupState; panel: AskModelConfig | 'new' | null; setPanel: (p: AskModelConfig | 'new' | null) => void }) {
  const ask = state.config.ask;
  const patch = usePatchConfig();
  const def = ask.default && ask.models.some((m) => m.id === ask.default) ? ask.default : (ask.models[0]?.id ?? null);
  const change = useMutation({
    mutationFn: (p: { models: AskModelConfig[]; default: string | null }) => patch({ ask: { models: strip(p.models), default: p.default } as never }),
  });
  const remove = (m: AskModelConfig) => {
    const models = ask.models.filter((x) => x.id !== m.id);
    change.mutate({ models, default: def === m.id ? (models[0]?.id ?? null) : def });
    if (panel !== 'new' && panel?.id === m.id) setPanel(null);
  };
  if (!ask.models.length && !panel)
    return (
      <div className="wz-empty" data-testid="ask-empty">
        <div className="wz-orb">
          <IconMessageCircle size={22} />
        </div>
        <div className="wz-empty-t">No models yet</div>
        <div className="wz-empty-d">Add a model from Anthropic, OpenAI, Google, or any OpenAI-compatible URL. You can add more later.</div>
        <Button className="wz-primary wz-mt20" leftSection={<IconPlus size={15} />} onClick={() => setPanel('new')} data-testid="add-model-open">
          Add model
        </Button>
        <div className="wz-row-c wz-g8 wz-mt24">
          {(['anth', 'oai', 'goog', 'url'] as const).map((m) => (
            <ProviderMark key={m} kind={m} small />
          ))}
        </div>
      </div>
    );
  return (
    <>
      {ask.models.length > 0 && (
        <>
          <div className="wz-listhead">
            <div>
              <div className="wz-sec-t" data-testid="ask-count">
                {ask.models.length} model{ask.models.length === 1 ? '' : 's'}
              </div>
              <div className="wz-sec-d">People choose a model when they ask; the default is preselected.</div>
            </div>
            <Button variant="default" size="compact-sm" className="wz-sec wz-sec-sm" leftSection={<IconPlus size={14} />} disabled={!!panel} onClick={() => setPanel('new')} data-testid="add-model-open">
              Add model
            </Button>
          </div>
          <div className="wz-mlist" data-testid="model-list">
            {ask.models.map((m) => (
              <div key={m.id} className="wz-mrow" data-testid={`model-${m.id}`}>
                <ProviderMark kind={markOf(m)} />
                <div className="wz-mmain">
                  <div className="wz-mname">{m.model}</div>
                  <div className="wz-msub">{subOf(m)}</div>
                </div>
                <div className="wz-mmeta">
                  <div>
                    <KeyChip ok={!!m.apiKeySet} none={!m.apiKeyEnv} />
                  </div>
                  <div>
                    {def === m.id ? (
                      <Chip tone="accent" icon={<IconStar size={12} stroke={2.2} />} testId="model-default">
                        Default
                      </Chip>
                    ) : (
                      <button type="button" className="wz-btn wz-ghost wz-btn-sm wz-mkdef" onClick={() => change.mutate({ models: ask.models, default: m.id })} data-testid={`make-default-${m.id}`}>
                        Make default
                      </button>
                    )}
                  </div>
                </div>
                <div className="wz-mact">
                  <button type="button" className="wz-btn wz-ghost wz-btn-sm wz-txt" onClick={() => setPanel(m)} data-testid={`edit-${m.id}`}>
                    Edit
                  </button>
                  <button type="button" className="wz-btn wz-ghost wz-btn-sm wz-txt wz-rm" onClick={() => remove(m)} data-testid={`remove-${m.id}`}>
                    Remove
                  </button>
                  <button type="button" className="wz-iconbtn wz-ico" aria-label={`Edit ${m.model}`} onClick={() => setPanel(m)}>
                    <IconPencil size={15} />
                  </button>
                  <button type="button" className="wz-iconbtn wz-ico" aria-label={`Remove ${m.model}`} onClick={() => remove(m)}>
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {change.isError && <div className="wz-err wz-mt10">{errText(change.error)}</div>}
        </>
      )}
      {panel && <ModelPanel key={panel === 'new' ? 'new' : panel.id} state={state} editing={panel === 'new' ? null : panel} onClose={() => setPanel(null)} />}
    </>
  );
}

/** Step 3 (optional): the Ask models. */
export function AskStep({ state, onBack, onNext }: { state: SetupState; onBack: () => void; onNext: (skipped: boolean) => void }) {
  const [panel, setPanel] = useState<AskModelConfig | 'new' | null>(null);
  const [warn, setWarn] = useState(false);
  const n = state.config.ask.models.length;
  return (
    <section className="wz-main" data-testid="wz-ask">
      <div className="wz-body">
        <StepHead n={3} title="Ask models" optional>
          Models that answer questions about your specs in the Ask panel. Add as many as you like and pick a default. Coding agents don’t need one.
        </StepHead>
        <AskModels state={state} panel={panel} setPanel={(p) => (setPanel(p), setWarn(false))} />
        {warn && <div className="wz-err wz-mt16">Press “Add model” to keep this model, or close the panel.</div>}
      </div>
      <WizardFooter onBack={onBack} onSkip={() => onNext(n === 0)}>
        <ContinueButton onClick={() => (panel ? setWarn(true) : onNext(n === 0))} />
      </WizardFooter>
    </section>
  );
}

/* ------------------------------------------------------------------ Semantic search */

type EmbKind = Extract<EmbeddingPreset, 'ollama' | 'openai' | 'cheaperinference' | 'custom'>;
const OLLAMA_URL = 'http://localhost:11434/v1';
const EMB_KINDS: { id: EmbKind; label: string; sub: string; tag: string; mark: MarkKind }[] = [
  { id: 'ollama', label: 'Ollama (local)', sub: 'Runs on this server', tag: 'Free', mark: 'oll' },
  { id: 'openai', label: 'OpenAI', sub: 'text-embedding-3', tag: 'Pay per use', mark: 'oai' },
  { id: 'cheaperinference', label: 'Cheaper Inference', sub: 'Qwen3, Gemini, Mistral…', tag: 'Pay per use', mark: 'ci' },
  { id: 'custom', label: 'Custom URL', sub: 'Any /v1 server', tag: '', mark: 'url' },
];
const embUrl = (k: EmbKind) => (k === 'ollama' ? OLLAMA_URL : (REMOTE_PRESETS.find((p) => p.id === k)?.baseUrl ?? ''));
const embEnv = (k: EmbKind) => (k === 'ollama' ? '' : (REMOTE_PRESETS.find((p) => p.id === k)?.apiKeyEnv ?? ''));
const embDefaultModel = (k: EmbKind) => (k === 'ollama' ? 'nomic-embed-text' : k === 'openai' ? 'text-embedding-3-small' : '');
const fmtUsd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? 'under $0.01' : `about $${n.toFixed(2)}`);

function initialEmb(state: SetupState): EmbKind {
  const e = state.config.embedding;
  if (e.provider !== 'none') {
    if (e.preset && e.preset !== 'ollama') return e.preset as EmbKind;
    if (e.preset === 'ollama' || /:11434(\/|$)/.test(e.baseUrl)) return 'ollama';
    return (REMOTE_PRESETS.find((p) => p.baseUrl === e.baseUrl.replace(/\/+$/, ''))?.id as EmbKind) ?? 'custom';
  }
  return keyOwner(state, 'OPENAI_API_KEY') ? 'openai' : keyOwner(state, 'CHEAPERINFERENCE_API_KEY') ? 'cheaperinference' : 'ollama';
}

/** Step 4 (optional): semantic search (embeddings). */
export function SearchStep({ state, onBack, onNext }: { state: SetupState; onBack: () => void; onNext: (skipped: boolean) => void }) {
  const e = state.config.embedding;
  const on = e.provider !== 'none';
  const first = initialEmb(state);
  const same = (k: EmbKind) => on && k === first;
  const [kind, setKind] = useState<EmbKind>(first);
  const [baseUrl, setBaseUrl] = useState(same(first) ? e.baseUrl : embUrl(first));
  const [model, setModel] = useState(same(first) ? e.model : embDefaultModel(first));
  const [keyEnv, setKeyEnv] = useState(same(first) && e.apiKeyEnv ? e.apiKeyEnv : embEnv(first));
  const [key, setKey] = useState('');
  const [dims, setDims] = useState<number | null>(same(first) ? e.dimensions : null);
  const [result, setResult] = useState<Result>(null);
  const patch = usePatchConfig();
  const local = kind === 'ollama';
  const urlOk = /^https?:\/\/[^\s/]+/.test(baseUrl.trim());
  const pick = (k: EmbKind) => {
    setKind(k);
    setBaseUrl(same(k) ? e.baseUrl : embUrl(k));
    setModel(same(k) ? e.model : embDefaultModel(k));
    setKeyEnv(same(k) && e.apiKeyEnv ? e.apiKeyEnv : embEnv(k));
    setKey('');
    setDims(same(k) ? e.dimensions : null);
    setResult(null);
    list.reset();
  };
  const detect = useQuery({ queryKey: ['setup', 'embedding'], queryFn: setupApi.embeddingDetect, retry: false, enabled: local });
  const keys = useQuery({
    queryKey: ['setup', 'embedding', 'keys', baseUrl, keyEnv],
    queryFn: () => setupApi.embeddingKeys({ baseUrl: baseUrl.trim(), ...(ENV_RE.test(keyEnv) ? { apiKeyEnv: keyEnv } : {}) }),
    enabled: !local && urlOk,
    retry: false,
  });
  const usedBy = keys.data?.candidates.find((c) => c.apiKeyEnv === keyEnv && c.apiKeySet)?.label ?? keyOwner(state, keyEnv);
  const saved = !!keyEnv && (!!keys.data?.apiKeyEnvSet || !!usedBy);
  const keyOptional = kind === 'custom';
  const ready = local || (urlOk && (saved || keyOptional));
  const conn = () => ({ baseUrl: baseUrl.trim().replace(/\/+$/, ''), preset: kind, ...(!local && keyEnv && (saved || key.trim()) ? { apiKeyEnv: keyEnv } : {}) });
  /** A typed key goes to secrets.env first (write-only). */
  const storeKey = async () => {
    if (!key.trim() || local) return;
    if (!ENV_RE.test(keyEnv)) throw new UiApiError('invalid_input', 'The key variable uses capital letters, digits and _ (e.g. OPENAI_API_KEY)', 'embedding.apiKeyEnv');
    await setupApi.secret(keyEnv, key.trim());
    setKey('');
    await keys.refetch();
  };
  const list = useMutation({
    mutationFn: async () => {
      await storeKey();
      return setupApi.embeddingModels(conn());
    },
    onSuccess: (r) => r.ok && !model && r.suggested && setModel(r.suggested),
  });
  useEffect(() => {
    if (!local && ready && !list.data) list.mutate();
  }, [kind, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const test = useMutation({
    mutationFn: async () => {
      await storeKey();
      return setupApi.embeddingTest({ ...conn(), model: model.trim() });
    },
    onSuccess: (r) => {
      if (r.ok && r.dimensions) setDims(r.dimensions);
      setResult(r.ok ? { ok: true, text: 'It works', sub: r.dimensions ? `${r.dimensions.toLocaleString('en-US')} dimensions detected` : undefined } : { ok: false, text: r.message });
    },
    onError: (err) => setResult({ ok: false, text: errText(err) }),
  });
  const price = list.data?.models.find((m) => m.id === model.trim())?.pricePerMTok ?? null;
  const estimate = useQuery({
    queryKey: ['setup', 'embedding', 'estimate', model.trim(), price],
    queryFn: () => setupApi.embeddingEstimate({ model: model.trim(), pricePerMTok: price }),
    enabled: !local && !!model.trim(),
    retry: false,
  });
  const cost = estimate.data?.costUsd;
  const models = local ? (detect.data?.models ?? null) : list.data?.ok ? list.data.models.map((m) => m.id) : null;
  const nomic = local && /^nomic-embed-text/.test(model.trim());
  const save = useMutation({
    mutationFn: async () => {
      if (!urlOk) throw new UiApiError('invalid_input', 'Enter the embeddings URL', 'embedding.baseUrl');
      if (!model.trim()) throw new UiApiError('invalid_input', 'Pick or type the embedding model', 'embedding.model');
      const withKey = !local && !!keyEnv && (saved || !!key.trim());
      if (!local && !keyOptional && !withKey) throw new UiApiError('invalid_input', 'Paste the API key first (or skip semantic search for now)', 'embedding.apiKey');
      const size = dims ?? (nomic ? 768 : null);
      if (!size) throw new UiApiError('invalid_input', 'Press “Test” so Mandate can check the model and its vector size', 'embedding');
      await storeKey();
      const p = await setupApi.embeddingPreset(model.trim()).catch(() => null);
      await patch({
        embedding: {
          provider: 'openai-compatible',
          preset: kind,
          baseUrl: baseUrl.trim().replace(/\/+$/, ''),
          model: model.trim(),
          apiKeyEnv: withKey ? keyEnv : null,
          dimensions: size,
          requestDimensions: null,
          ...(p ? { documentPrefix: p.documentPrefix, queryPrefix: p.queryPrefix, maxInputTokens: p.maxInputTokens, batchSize: p.batchSize } : nomic ? { documentPrefix: 'search_document: ', queryPrefix: 'search_query: ', maxInputTokens: 2048, batchSize: 32 } : {}),
        } as never,
      });
    },
    onSuccess: () => onNext(false),
  });
  const d = detect.data;
  return (
    <section className="wz-main" data-testid="wz-search">
      <div className="wz-body">
        <StepHead n={4} title="Semantic search" optional>
          Finds specs by meaning, not just matching words. Keyword search works without it.
        </StepHead>
        <Field label="Embedding provider">
          <div className="wz-pcards" role="radiogroup">
            {EMB_KINDS.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === kind} className="wz-pc" data-on={p.id === kind || undefined} onClick={() => pick(p.id)} data-testid={`wz-emb-${p.id}`}>
                <ProviderMark kind={p.mark} />
                <span>
                  <span className="wz-pc-n">{p.label}</span>
                  <span className="wz-pc-s">{p.sub}</span>
                </span>
                {p.tag ? <Chip className="wz-pc-tag">{p.tag}</Chip> : <span className="wz-pc-tag wz-pc-tag-empty" />}
                {p.id === kind ? (
                  <span className="wz-pc-tick">
                    <IconCheck size={11} stroke={3} />
                  </span>
                ) : (
                  <span className="wz-pc-rad" />
                )}
              </button>
            ))}
          </div>
        </Field>
        <div className="wz-stack wz-g20 wz-mt24">
          {kind === 'custom' && (
            <Field label="Base URL" hint="Any OpenAI-compatible /v1 endpoint (Together, Fireworks, vLLM, LM Studio…).">
              <TextInput className="wz-input wz-mono-input" placeholder="https://api.example.com/v1" value={baseUrl} onChange={(ev) => (setBaseUrl(ev.currentTarget.value), setDims(null), setResult(null))} aria-label="Base URL" data-testid="wz-embed-base" />
            </Field>
          )}
          {local && d && (
            <div className="wz-hint" data-testid="wz-ollama-status">
              {d.ollama ? (d.hasNomic ? `Ollama is running at ${d.baseUrl}; nomic-embed-text is installed.` : `Ollama is running. Install the model: ollama pull nomic-embed-text`) : 'Ollama is not running on this server. Install it from ollama.com, then: ollama pull nomic-embed-text'}
            </div>
          )}
          <div className={local ? '' : 'wz-grid2'}>
            <Field label="Model" aside={!local && list.data?.ok ? <span className="wz-aside">{list.data.total} models</span> : null} error={!local && list.data && !list.data.ok ? list.data.message : null}>
              <ModelCombo value={model} onChange={(v) => (setModel(v), setDims(null), setResult(null))} models={models} placeholder="Type or pick a model" testId="wz-embed-model" />
            </Field>
            {!local && (
              <Field
                label="Key variable"
                hint={
                  saved && usedBy ? (
                    <>
                      Already saved for {usedBy}. {SECRET_HINT}
                    </>
                  ) : keyOptional ? (
                    'Leave empty if the server needs no key.'
                  ) : (
                    'The environment variable that holds the key.'
                  )
                }
              >
                <TextInput
                  className="wz-input wz-mono-input"
                  value={keyEnv}
                  onChange={(ev) => (setKeyEnv(ev.currentTarget.value.toUpperCase()), setResult(null))}
                  rightSection={
                    saved ? (
                      <Chip tone="ok" icon={<IconCheck size={12} stroke={2.4} />} testId="wz-embed-saved">
                        Saved
                      </Chip>
                    ) : null
                  }
                  rightSectionWidth={saved ? 76 : undefined}
                  aria-label="Key variable"
                  data-testid="wz-embed-keyenv"
                />
              </Field>
            )}
          </div>
          {!local && !saved && keyEnv && (
            <Field label="API key" hint={SECRET_HINT}>
              <SecretInput value={key} onChange={(v) => (setKey(v), setResult(null))} testId="wz-embed-key" />
            </Field>
          )}
          <div className="wz-panel wz-inset wz-testbox">
            <div className="wz-row-c wz-g12 wz-wrap">
              <TestBtn loading={test.isPending} disabled={!model.trim() || !urlOk || (!local && !ready && !key.trim())} onClick={() => test.mutate()} testId="wz-embed-test" />
              {result ? (
                <ResultLine result={result} />
              ) : dims ? (
                <ResultLine result={{ ok: true, text: 'Ready', sub: `${dims.toLocaleString('en-US')} dimensions` }} />
              ) : (
                <span className="wz-hint">Test embeds one sentence and detects the vector size.</span>
              )}
            </div>
          </div>
          {!local && typeof cost === 'number' && (
            <div className="wz-cost" data-testid="wz-cost">
              <IconInfoCircle size={15} />
              <span>Indexing your specs costs {fmtUsd(cost)} once; each search costs well under a cent.</span>
            </div>
          )}
        </div>
        {save.isError && (
          <div className="wz-err wz-mt16" data-testid="wz-search-error">
            {errText(save.error)}
          </div>
        )}
      </div>
      <WizardFooter onBack={onBack} onSkip={() => onNext(!on)}>
        <ContinueButton loading={save.isPending} onClick={() => save.mutate()} />
      </WizardFooter>
    </section>
  );
}
