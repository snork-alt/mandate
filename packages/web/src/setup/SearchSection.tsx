/**
 * Settings → Semantic search (also the wizard step): local Ollama, a remote OpenAI-compatible endpoint (OpenAI, Cheaper
 * Inference, custom), or off. The key is write-only (secrets.env); "Test" embeds one string and detects the vector size
 * and latency; per-model presets fill prefixes / limits (overridable under Advanced). The config hot-reloads; a model
 * switch re-embeds in the background while search keeps answering from the previous model.
 */
import { Anchor, Autocomplete, Button, Group, NumberInput, Select, Switch, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconChevronRight, IconCloud, IconExternalLink, IconInfoCircle, IconLock, IconRefresh, IconSearch } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, Notice } from '../connect/parts';
import { UiApiError } from '../lib/ui';
import { setupApi, type EmbeddingModelPreset, type EmbeddingPreset, type EmbeddingSettings } from './api';
import { usePatchConfig, useSaver, type SectionProps } from './sections';
import { ChoiceCard, CommandLine, NextNote, SecretField, StepIntro } from './widgets';

type Mode = 'local' | 'remote' | 'off';
type RemotePreset = Exclude<EmbeddingPreset, 'ollama'>;

/** Remote endpoints (mirrors the server's ENDPOINTS table). */
export const REMOTE_PRESETS: { id: RemotePreset; label: string; baseUrl: string; apiKeyEnv: string; hint: string; keyUrl?: string }[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', hint: 'text-embedding-3-small / -large.', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'cheaperinference', label: 'Cheaper Inference', baseUrl: 'https://api.cheaperinference.com/v1', apiKeyEnv: 'CHEAPERINFERENCE_API_KEY', hint: 'OpenAI, Qwen3, Gemini, Mistral embeddings.' },
  { id: 'custom', label: 'Custom', baseUrl: '', apiKeyEnv: 'EMBEDDING_API_KEY', hint: 'Together, Fireworks, vLLM, LM Studio, any /v1 server.' },
];
const OLLAMA_URL = 'http://localhost:11434/v1';

const isLocalUrl = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local');
  } catch {
    return false;
  }
};
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const presetOfUrl = (u: string): RemotePreset => REMOTE_PRESETS.find((p) => p.baseUrl && p.baseUrl === u.replace(/\/+$/, ''))?.id ?? 'custom';

function initialMode(e: EmbeddingSettings): Mode {
  if (e.provider === 'none') return 'off';
  if (e.provider === 'openai-compatible' && (e.preset ? e.preset !== 'ollama' : !/:11434(\/|$)/.test(e.baseUrl))) return 'remote';
  return 'local';
}

interface Advanced {
  documentPrefix: string;
  queryPrefix: string;
  maxInputTokens: number;
  batchSize: number;
  requestDimensions: number | null;
}
const advancedOf = (p: Pick<EmbeddingModelPreset, 'documentPrefix' | 'queryPrefix' | 'maxInputTokens' | 'batchSize'>, requestDimensions: number | null = null): Advanced => ({
  documentPrefix: p.documentPrefix,
  queryPrefix: p.queryPrefix,
  maxInputTokens: p.maxInputTokens,
  batchSize: p.batchSize,
  requestDimensions,
});

const fmtInt = (n: number) => n.toLocaleString('en-US');
const fmtUsd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? 'under $0.01' : `about $${n.toFixed(2)}`);

export function SearchSection({ state, register, variant }: SectionProps) {
  const e = state.config.embedding;
  const [mode, setMode] = useState<Mode>(initialMode(e));
  const patch = usePatchConfig();

  /* ---- local (Ollama) */
  const wasLocal = initialMode(e) === 'local';
  const [localUrl, setLocalUrl] = useState(wasLocal ? e.baseUrl : OLLAMA_URL);
  const [localModel, setLocalModel] = useState(wasLocal ? e.model || 'nomic-embed-text' : 'nomic-embed-text');
  const [localDims, setLocalDims] = useState<number | null>(null);
  const detect = useQuery({ queryKey: ['setup', 'embedding'], queryFn: setupApi.embeddingDetect, retry: false, enabled: mode === 'local' });

  /* ---- remote */
  const wasRemote = initialMode(e) === 'remote';
  const [preset, setPreset] = useState<RemotePreset>(wasRemote ? ((e.preset && e.preset !== 'ollama' ? e.preset : presetOfUrl(e.baseUrl)) as RemotePreset) : 'openai');
  const presetInfo = REMOTE_PRESETS.find((p) => p.id === preset)!;
  const [baseUrl, setBaseUrl] = useState(wasRemote ? e.baseUrl : presetInfo.baseUrl);
  const [ownKeyEnv, setOwnKeyEnv] = useState(wasRemote && e.apiKeyEnv ? e.apiKeyEnv : presetInfo.apiKeyEnv);
  const [ownKeySet, setOwnKeySet] = useState(wasRemote ? !!e.apiKeySet : false);
  const [reuse, setReuse] = useState<string | null>(null); // env var of the Ask key reused
  const [model, setModel] = useState(wasRemote ? e.model : '');
  const [dims, setDims] = useState<number | null>(wasRemote ? e.dimensions : null);
  const [modelPreset, setModelPreset] = useState<EmbeddingModelPreset | null>(null);
  const [adv, setAdv] = useState<Advanced | null>(
    wasRemote ? { documentPrefix: e.documentPrefix ?? '', queryPrefix: e.queryPrefix ?? '', maxInputTokens: e.maxInputTokens ?? 2048, batchSize: e.batchSize ?? 32, requestDimensions: e.requestDimensions ?? null } : null,
  );
  const [advOpen, setAdvOpen] = useState(false);
  const [lastTest, setLastTest] = useState<{ ok: boolean; message: string } | null>(null);
  const firstPreset = useRef(true);

  const urlOk = /^https?:\/\/[^\s/]+/.test(baseUrl);
  const keys = useQuery({
    queryKey: ['setup', 'embedding', 'keys', baseUrl, ownKeyEnv],
    queryFn: () => setupApi.embeddingKeys({ baseUrl, ...(/^[A-Z][A-Z0-9_]{1,63}$/.test(ownKeyEnv) ? { apiKeyEnv: ownKeyEnv } : {}) }),
    enabled: mode === 'remote' && urlOk,
  });
  const askKey = keys.data?.candidates.find((c) => c.apiKeySet) ?? null;
  // Offer the Ask key by default when the same endpoint already has one (and no other key is configured).
  useEffect(() => {
    if (askKey && reuse === null && !(wasRemote && e.apiKeyEnv && e.apiKeyEnv !== askKey.apiKeyEnv)) setReuse(askKey.apiKeyEnv);
  }, [askKey?.apiKeyEnv]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (keys.data?.apiKeyEnvSet !== undefined && !ownKeySet) setOwnKeySet(keys.data.apiKeyEnvSet);
  }, [keys.data?.apiKeyEnvSet]); // eslint-disable-line react-hooks/exhaustive-deps
  const keyEnv = reuse && askKey ? askKey.apiKeyEnv : ownKeyEnv;
  const keySet = reuse && askKey ? true : ownKeySet;
  const keyOptional = preset === 'custom';
  const ready = urlOk && (keySet || keyOptional);
  const conn = { baseUrl, preset, ...(keySet ? { apiKeyEnv: keyEnv } : {}) };

  // A new endpoint preset: its URL and key name; forget the model.
  useEffect(() => {
    if (firstPreset.current) {
      firstPreset.current = false;
      return;
    }
    setBaseUrl(presetInfo.baseUrl);
    setOwnKeyEnv(presetInfo.apiKeyEnv);
    setOwnKeySet(false);
    setReuse(null);
    setModel('');
    setDims(null);
    setLastTest(null);
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps

  const models = useMutation({
    mutationFn: () => setupApi.embeddingModels(conn),
    onSuccess: (r) => {
      if (!model && r.suggested) setModel(r.suggested);
    },
  });
  useEffect(() => {
    if (mode === 'remote' && ready) models.mutate();
  }, [mode, ready, preset, keyEnv]); // eslint-disable-line react-hooks/exhaustive-deps

  // Model presets: prefixes, limits, shortened sizes; picking another model resets Advanced to its preset.
  const lastModel = useRef(wasRemote ? e.model : '');
  useEffect(() => {
    if (!model.trim()) return;
    let live = true;
    const t = setTimeout(() => {
      void setupApi.embeddingPreset(model.trim()).then((p) => {
        if (!live) return;
        setModelPreset(p);
        if (lastModel.current !== model.trim() || !adv) {
          setAdv(advancedOf(p));
          setDims(null);
          setLastTest(null);
        }
        lastModel.current = model.trim();
      }, () => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  const runTest = useMutation({
    mutationFn: () => setupApi.embeddingTest({ ...conn, model: model.trim(), requestDimensions: adv?.requestDimensions ?? null, ...(adv ? { documentPrefix: adv.documentPrefix } : {}) }),
    onSuccess: (r) => {
      setLastTest(r);
      if (r.ok && r.dimensions) setDims(r.dimensions);
    },
    onError: (err) => setLastTest({ ok: false, message: (err as Error).message }),
  });

  const priceOf = (id: string) => models.data?.models.find((m) => m.id === id)?.pricePerMTok ?? modelPreset?.pricePerMTok ?? null;

  /* ---- what would be saved */
  const next: Partial<EmbeddingSettings> | null = useMemo(() => {
    if (mode === 'off') return { provider: 'none' };
    if (mode === 'local') {
      const nomic = /^nomic-embed-text/.test(localModel);
      return {
        provider: 'openai-compatible',
        preset: 'ollama',
        baseUrl: localUrl,
        model: localModel,
        apiKeyEnv: null,
        requestDimensions: null,
        ...(localDims ? { dimensions: localDims } : nomic ? { dimensions: 768 } : {}),
        ...(nomic ? { documentPrefix: 'search_document: ', queryPrefix: 'search_query: ', maxInputTokens: 2048, batchSize: 32 } : {}),
      };
    }
    if (!model.trim() || !adv) return null;
    return {
      provider: 'openai-compatible',
      preset,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model: model.trim(),
      apiKeyEnv: keySet ? keyEnv : null,
      ...(adv.requestDimensions ? { dimensions: adv.requestDimensions } : dims ? { dimensions: dims } : {}),
      requestDimensions: adv.requestDimensions,
      documentPrefix: adv.documentPrefix,
      queryPrefix: adv.queryPrefix,
      maxInputTokens: adv.maxInputTokens,
      batchSize: adv.batchSize,
    };
  }, [mode, localUrl, localModel, localDims, preset, baseUrl, model, keySet, keyEnv, adv, dims]);

  const current = { provider: e.provider, baseUrl: e.baseUrl, model: e.model, dimensions: e.dimensions, documentPrefix: e.documentPrefix };
  const changed = !!next && Object.entries(next).some(([k, v]) => (e as unknown as Record<string, unknown>)[k] !== v && !(v === null && (e as unknown as Record<string, unknown>)[k] === undefined));
  // The vectors change (re-embed) when provider, model, size, endpoint or document prefix change.
  const vecKey = (x: Partial<EmbeddingSettings>) => (x.provider === 'none' ? 'none' : [x.provider, x.model, x.dimensions ?? '?', x.documentPrefix ?? current.documentPrefix].join('|'));
  const switching = !!next && next.provider !== 'none' && (e.provider === 'none' || vecKey(next) !== vecKey(current) || next.baseUrl !== current.baseUrl);

  const estimate = useQuery({
    queryKey: ['setup', 'embedding', 'estimate', next?.model ?? e.model, next?.model ? priceOf(next.model) : null],
    queryFn: () => setupApi.embeddingEstimate({ model: next?.model ?? e.model, pricePerMTok: next?.model && mode === 'remote' ? priceOf(next.model) : null }),
    enabled: mode !== 'off',
    refetchInterval: (q) => (q.state.data?.projects.some((p) => p.serving.mode !== 'current' && p.serving.mode !== 'none') ? 5000 : false),
  });

  useSaver(register, async () => {
    if (!next) {
      if (mode === 'remote') throw new UiApiError('invalid_input', 'Pick an embedding model first (or choose “Keyword search only”).', 'embedding');
      return;
    }
    if (!changed) return;
    if (mode === 'remote' && !next.dimensions) throw new UiApiError('invalid_input', 'Run “Test” first so Mandate can detect the model’s vector size.', 'embedding');
    if (mode === 'remote' && !ready) throw new UiApiError('invalid_input', 'Save the API key first.', 'embedding');
    await patch({ embedding: next as never });
  });

  const d = detect.data;
  const remoteHost = hostOf(baseUrl);
  const sendsRemote = mode === 'remote' && urlOk && !isLocalUrl(baseUrl);
  const serving = estimate.data?.projects.filter((p) => p.serving.mode === 'previous' || p.serving.mode === 'text-only') ?? [];

  return (
    <div className="su-section">
      <StepIntro title="Semantic search" optional>
        Keyword search always works. Semantic search also finds specs by meaning (“how do refunds work?”) using an embedding model: locally with Ollama (free, private) or a remote OpenAI-compatible endpoint.
      </StepIntro>
      {serving.length > 0 && (
        <Notice icon={<IconRefresh size={16} />} tone="neutral" title="Re-embedding in the background" testId="embed-serving">
          {serving.map((p) => (
            <div key={p.id}>
              <b>{p.id}</b>: {p.serving.note ?? p.serving.mode} ({fmtInt(p.embedded)} of {fmtInt(p.chunks)} done)
            </div>
          ))}
        </Notice>
      )}
      <div className="su-choices" role="radiogroup">
        <ChoiceCard selected={mode === 'local'} onSelect={() => setMode('local')} title="Local (Ollama)" description="nomic-embed-text on this machine. Free; nothing leaves your computer." icon={<IconSearch size={18} />} recommended testId="search-ollama">
          {detect.isLoading && <div className="np-faint">Looking for Ollama…</div>}
          {d && (
            <div className="np-stack">
              {d.ollama ? (
                <Notice icon={<IconCheck size={16} />} tone="ok" title={`Ollama is running at ${d.baseUrl}`}>
                  {d.hasNomic ? 'nomic-embed-text is installed.' : 'Install the embedding model with the command below, then Test.'}
                </Notice>
              ) : (
                <Notice
                  icon={<IconAlertTriangle size={16} />}
                  tone="warn"
                  title="Ollama is not running"
                  actions={
                    <Button type="button" size="xs" variant="default" leftSection={<IconRefresh size={13} />} loading={detect.isFetching} onClick={() => void detect.refetch()}>
                      Check again
                    </Button>
                  }
                >
                  Install it from{' '}
                  <Anchor href="https://ollama.com/download" target="_blank" rel="noreferrer" size="sm">
                    ollama.com/download
                  </Anchor>
                  , start it, then run:
                </Notice>
              )}
              {(!d.ollama || !d.hasNomic) && d.install.map((c) => <CommandLine key={c} cmd={c} />)}
              <Group grow gap={8}>
                <Field label="Endpoint">
                  <TextInput size="sm" value={localUrl} onChange={(ev) => setLocalUrl(ev.currentTarget.value)} className="np-mono-input" />
                </Field>
                <Field label="Model">
                  <Select size="sm" searchable data={[...new Set([localModel, 'nomic-embed-text', ...d.models])]} value={localModel} onChange={(v) => v && setLocalModel(v)} comboboxProps={{ withinPortal: true }} />
                </Field>
              </Group>
              <EmbedTest
                run={async () => {
                  const r = await setupApi.embeddingTest({ baseUrl: localUrl, model: localModel });
                  if (r.ok && r.dimensions) setLocalDims(r.dimensions);
                  return r;
                }}
                testId="embed-test"
              />
            </div>
          )}
        </ChoiceCard>

        <ChoiceCard
          selected={mode === 'remote'}
          onSelect={() => setMode('remote')}
          title="Remote endpoint"
          description="OpenAI, Cheaper Inference or any OpenAI-compatible server. Fast setup, pay per token."
          icon={<IconCloud size={18} />}
          testId="search-remote"
        >
          <div className="np-stack">
            <div className="su-presets" role="radiogroup">
              {REMOTE_PRESETS.map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={p.id === preset} className="su-preset" onClick={() => setPreset(p.id)} data-testid={`embed-preset-${p.id}`}>
                  <span className="su-preset-title">{p.label}</span>
                  <span className="su-preset-hint">{p.hint}</span>
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <Field label="Base URL" hint="The server’s OpenAI-compatible /v1 endpoint (POST /embeddings).">
                <TextInput size="sm" value={baseUrl} onChange={(ev) => setBaseUrl(ev.currentTarget.value.trim())} placeholder="https://api.together.xyz/v1" className="np-mono-input" data-testid="embed-base-url" />
              </Field>
            )}
            {askKey && (
              <Switch
                checked={!!reuse}
                onChange={(ev) => setReuse(ev.currentTarget.checked ? askKey.apiKeyEnv : '')}
                label={
                  <span>
                    Use the same key as Ask model <b>{askKey.label}</b> <code className="su-env">{askKey.apiKeyEnv}</code>
                  </span>
                }
                data-testid="embed-reuse-key"
              />
            )}
            {!(reuse && askKey) && (
              <>
                {preset === 'custom' && (
                  <Field label="Key variable" hint="Name of the env var that holds the key (secrets.env). Leave the key empty if the server needs none.">
                    <TextInput size="sm" value={ownKeyEnv} onChange={(ev) => (setOwnKeyEnv(ev.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_')), setOwnKeySet(false))} className="np-mono-input" />
                  </Field>
                )}
                {/^[A-Z][A-Z0-9_]{1,63}$/.test(ownKeyEnv) && (
                  <SecretField key={ownKeyEnv} name={ownKeyEnv} isSet={ownKeySet} label={keyOptional ? 'API key (optional)' : 'API key'} onSaved={setOwnKeySet} placeholder={`Paste the ${presetInfo.label === 'Custom' ? '' : `${presetInfo.label} `}API key`} testId="embed-key" />
                )}
                {presetInfo.keyUrl && (
                  <Anchor size="xs" href={presetInfo.keyUrl} target="_blank" rel="noreferrer" mt={-10}>
                    Get a key <IconExternalLink size={11} style={{ verticalAlign: -1 }} />
                  </Anchor>
                )}
              </>
            )}
            <Field
              label="Model"
              hint={models.data?.ok ? models.data.message : ready ? (models.isPending ? 'Loading the embedding models…' : 'Load the endpoint’s embedding models, or type a name.') : 'Save the key to list the models.'}
              error={models.data && !models.data.ok ? models.data.message : models.isError ? (models.error as Error).message : null}
              right={
                <Button type="button" size="compact-xs" variant="subtle" color="gray" leftSection={<IconRefresh size={12} />} disabled={!ready} loading={models.isPending} onClick={() => models.mutate()} data-testid="embed-load-models">
                  Load models
                </Button>
              }
            >
              <Autocomplete
                size="sm"
                data={models.data?.models.map((m) => m.id) ?? []}
                value={model}
                onChange={setModel}
                placeholder={ready ? 'text-embedding-3-small' : '—'}
                disabled={!urlOk}
                className="np-mono-input"
                comboboxProps={{ withinPortal: true }}
                renderOption={({ option }) => {
                  const m = models.data?.models.find((x) => x.id === option.value);
                  return (
                    <span className="su-embed-opt">
                      <span>{option.value}</span>
                      {m?.pricePerMTok != null && <span className="np-faint">${m.pricePerMTok}/M tok</span>}
                    </span>
                  );
                }}
                data-testid="embed-model"
              />
            </Field>
            {modelPreset && model.trim() && (
              <div className="np-faint su-embed-facts" data-testid="embed-facts">
                {modelPreset.known ? modelPreset.family : 'Unknown model (generic settings)'} · {dims ? `${fmtInt(dims)} dimensions (detected)` : 'dimensions: detected by Test'}
                {priceOf(model.trim()) != null && ` · $${priceOf(model.trim())} per million tokens`}
              </div>
            )}
            <EmbedTest run={() => runTest.mutateAsync()} disabled={!ready || !model.trim()} result={lastTest} loading={runTest.isPending} testId="embed-remote-test" />
            {sendsRemote && (
              <Notice icon={<IconLock size={16} />} tone="warn" title="Privacy" testId="embed-privacy">
                Spec text is sent to <b>{remoteHost}</b> to be embedded: every chunk when it is indexed, and each semantic search query. Use Local (Ollama) to keep everything on this machine.
              </Notice>
            )}
            {adv && <EmbedAdvanced open={advOpen} setOpen={setAdvOpen} adv={adv} setAdv={(a) => (a.requestDimensions !== adv.requestDimensions && (setDims(null), setLastTest(null)), setAdv(a))} preset={modelPreset} />}
          </div>
        </ChoiceCard>

        <ChoiceCard selected={mode === 'off'} onSelect={() => setMode('off')} title="Off: keyword search only" description="No model needed. Turn semantic search on later in Settings." testId="search-off" />
      </div>

      {switching && changed && (
        <Notice icon={<IconInfoCircle size={16} />} tone="neutral" title={e.provider === 'none' ? 'Everything gets embedded in the background' : 'Switching models re-embeds everything in the background'} testId="embed-switch">
          {estimate.data ? (
            <>
              About {fmtInt(estimate.data.chunks)} chunk{estimate.data.chunks === 1 ? '' : 's'} × ~{fmtInt(estimate.data.avgTokens)} tokens ≈ {fmtInt(estimate.data.tokens)} tokens
              {mode === 'remote' && (estimate.data.costUsd !== null ? <> ({fmtUsd(estimate.data.costUsd)} at ${estimate.data.pricePerMTok}/M tokens)</> : ' (price unknown for this model)')}
              .{' '}
            </>
          ) : null}
          {e.provider === 'none' ? 'Search works text-only until the vectors are ready.' : `Search keeps answering from ${e.model} until the new model finishes; index_status shows the progress.`}
        </Notice>
      )}
      {variant === 'wizard' && <NextNote>The index builds in the background; search works right away and gets smarter as embeddings finish.</NextNote>}
    </div>
  );
}

/** Test button with the detected size / latency, or a clear error (auth, model not found, rate limit). */
function EmbedTest({ run, disabled, testId, result, loading }: { run: () => Promise<{ ok: boolean; message: string }>; disabled?: boolean; testId: string; result?: { ok: boolean; message: string } | null; loading?: boolean }) {
  const own = useMutation({ mutationFn: run });
  const r = result !== undefined ? result : (own.data ?? (own.isError ? { ok: false, message: (own.error as Error).message } : null));
  return (
    <div className="su-test">
      <Button type="button" size="xs" variant="default" loading={loading ?? own.isPending} disabled={disabled} onClick={() => (result !== undefined ? void run().catch(() => undefined) : own.mutate())} data-testid={testId}>
        Test
      </Button>
      {r && (
        <span className="su-test-result" data-ok={r.ok || undefined}>
          {r.ok ? <IconCheck size={14} stroke={2.4} /> : <IconAlertTriangle size={14} stroke={2.4} />}
          {r.message}
        </span>
      )}
    </div>
  );
}

function EmbedAdvanced({ open, setOpen, adv, setAdv, preset }: { open: boolean; setOpen: (o: boolean) => void; adv: Advanced; setAdv: (a: Advanced) => void; preset: EmbeddingModelPreset | null }) {
  const sizes = preset?.shortenTo ?? [];
  const num = (v: string | number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return (
    <div className="su-advanced" data-open={open || undefined}>
      <button type="button" className="su-advanced-toggle" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="embed-advanced">
        <IconChevronRight size={14} className="su-advanced-chevron" />
        Advanced
        <span className="np-faint">prefixes, limits{sizes.length ? ', vector size' : ''}</span>
      </button>
      {open && (
        <div className="su-advanced-body np-stack">
          {sizes.length > 0 && (
            <Field label="Vector size" hint="Smaller vectors (sent as the `dimensions` parameter) use less disk and are faster, with a small quality loss. Changing it re-embeds everything.">
              <Select
                size="sm"
                data={[{ value: '', label: `Full size (${preset?.dimensions ?? 'model default'})` }, ...sizes.filter((n) => n !== preset?.dimensions).map((n) => ({ value: String(n), label: `${n}` }))]}
                value={adv.requestDimensions ? String(adv.requestDimensions) : ''}
                onChange={(v) => setAdv({ ...adv, requestDimensions: v ? Number(v) : null })}
                comboboxProps={{ withinPortal: true }}
                data-testid="embed-request-dims"
              />
            </Field>
          )}
          <Group grow gap={8} align="flex-start">
            <Field label="Document prefix" hint="Prepended to every chunk.">
              <TextInput size="sm" value={adv.documentPrefix} onChange={(ev) => setAdv({ ...adv, documentPrefix: ev.currentTarget.value })} className="np-mono-input" placeholder="(none)" />
            </Field>
            <Field label="Query prefix" hint="Prepended to search queries.">
              <TextInput size="sm" value={adv.queryPrefix.replace(/\n/g, '\\n')} onChange={(ev) => setAdv({ ...adv, queryPrefix: ev.currentTarget.value.replace(/\\n/g, '\n') })} className="np-mono-input" placeholder="(none)" />
            </Field>
          </Group>
          <Group grow gap={8} align="flex-start">
            <Field label="Max input tokens" hint="Longer chunks are cut.">
              <NumberInput size="sm" min={64} max={32_000} value={adv.maxInputTokens} onChange={(v) => setAdv({ ...adv, maxInputTokens: num(v, adv.maxInputTokens) })} />
            </Field>
            <Field label="Batch size" hint="Texts per request.">
              <NumberInput size="sm" min={1} max={2048} value={adv.batchSize} onChange={(v) => setAdv({ ...adv, batchSize: num(v, adv.batchSize) })} />
            </Field>
          </Group>
          {preset && (
            <Button
              type="button"
              size="compact-xs"
              variant="subtle"
              color="gray"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setAdv(advancedOf(preset, adv.requestDimensions))}
            >
              Reset to the {preset.known ? preset.family : 'generic'} defaults
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
