/**
 * The setup wizard step: Semantic search (embedding provider cards, model, key, Test detects the vector size), optional.
 * Not an LLM setup: the default local embeddings need no key. It uses
 * the same APIs as Settings; keys are write-only (sent once to ~/.mandate/secrets.env, never read back or logged).
 */
import { TextInput } from '@mantine/core';
import { IconCheck, IconInfoCircle } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { UiApiError } from '../lib/ui';
import { setupApi, type EmbeddingPreset, type SetupState } from './api';
import { usePatchConfig } from './sections';
import { REMOTE_PRESETS } from './SearchSection';
import { Chip, ContinueButton, ENV_RE, Field, ModelCombo, ProviderMark, ResultLine, SECRET_HINT, SecretInput, StepHead, TestBtn, WizardFooter, type MarkKind } from './wizardKit';
import { errText } from './WizardSteps';

type Result = { ok: boolean; text: string; sub?: string } | null;

/** Is a key already stored under this env var (for semantic search)? Returns who uses it. */
function keyOwner(state: SetupState, env: string): string | null {
  if (!env) return null;
  const e = state.config.embedding;
  return e.apiKeyEnv === env && e.apiKeySet ? 'semantic search' : null;
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
  const usedBy = keyOwner(state, keyEnv);
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
        <StepHead n={3} title="Semantic search" optional>
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
