import { IconCopy } from '@tabler/icons-react';
import { copyText } from '../../lib/copy';
import type { AskMissing, AskStatus } from '../../mcp/queries';

const MISSING_LABEL: Record<AskMissing, string> = {
  provider: 'Provider (anthropic, openai, google or openai-compatible)',
  model: 'Model name',
  apiKey: 'API key (the environment variable named in apiKeyEnv is not set)',
  baseUrl: 'Base URL of the endpoint',
};

export const ANTHROPIC_SNIPPET = `"ask": { "default": "opus", "models": [{ "id": "opus", "label": "Opus 5.5", "provider": "anthropic", "model": "claude-opus-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" }] }`;
export const ANTHROPIC_EXPORT = 'ANTHROPIC_API_KEY=...   (environment or ~/.mandate/secrets.env)';
export const OLLAMA_SNIPPET = `{ "id": "llama", "label": "Llama 3.1 (local)", "provider": "openai-compatible", "model": "llama3.1", "baseUrl": "http://localhost:11434/v1" }`;

function Snippet({ title, text }: { title: string; text: string }) {
  return (
    <div className="ask-snippet">
      <div className="rail-faint">{title}</div>
      <code>{text}</code>
      <button type="button" onClick={() => void copyText(text, 'Copied snippet')} aria-label={`Copy ${title}`}>
        <IconCopy size={12} /> Copy
      </button>
    </div>
  );
}

/** Shown in the Ask tab while NO model is configured: what is missing, per model when some are listed. */
export function AskStatusNotice({ status, error }: { status?: AskStatus; error?: string }) {
  if (error) return <div className="ask-error" role="alert">Could not read the model configuration: {error}</div>;
  if (!status) return <div className="rail-faint">Checking model configuration…</div>;
  if (status.configured) return null;
  return (
    <div className="ask-notice" data-state="missing">
      <p>
        To ask questions here, configure a model in <code>~/.mandate/config.json</code>.
      </p>
      {status.models.length > 0 ? (
        <>
          <div className="rail-faint">Not ready:</div>
          <ul>
            {status.models.map((m) => (
              <li key={m.id}>
                <strong>{m.label}</strong> ({m.provider}
                {m.model ? `/${m.model}` : ''}): {m.reason ?? m.missing.map((x) => MISSING_LABEL[x]).join(', ')}
              </li>
            ))}
          </ul>
        </>
      ) : (
        status.missing.length > 0 && (
          <>
            <div className="rail-faint">Missing:</div>
            <ul>{status.missing.map((m) => <li key={m}>{MISSING_LABEL[m]}</li>)}</ul>
          </>
        )
      )}
      <Snippet title="Anthropic" text={ANTHROPIC_SNIPPET} />
      <Snippet title="Anthropic key" text={ANTHROPIC_EXPORT} />
      <Snippet title="Another model (local Ollama)" text={OLLAMA_SNIPPET} />
      <div className="rail-faint">Changes to the config file and ~/.mandate/secrets.env apply without a restart.</div>
    </div>
  );
}
