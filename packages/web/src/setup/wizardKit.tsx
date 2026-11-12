/**
 * Building blocks of the setup wizard (the split-card design): step header, footer (Back | Skip for now | Continue),
 * underline tabs, chips, provider marks, write-only key input, test result line and a searchable model picker that
 * also accepts any typed name.
 */
import { Button, Combobox, TextInput, useCombobox } from '@mantine/core';
import { IconAlertTriangle, IconArrowLeft, IconArrowRight, IconCheck, IconChevronDown, IconLink, IconLock, IconPlayerPlay, IconPlus, IconRefresh, IconSearch, IconX } from '@tabler/icons-react';
import { useMemo, useState, type ReactNode } from 'react';

export const TOTAL_STEPS = 6;

export function StepHead({ n, title, optional, children }: { n: number; title: string; optional?: boolean; children: ReactNode }) {
  return (
    <div className="wz-head">
      <div className="wz-eyebrow">
        Step {n} of {TOTAL_STEPS}
      </div>
      <div className="wz-h1row">
        <h2 className="wz-h1">{title}</h2>
        {optional && <Chip tone="neutral">Optional</Chip>}
      </div>
      <p className="wz-desc">{children}</p>
    </div>
  );
}

export function Chip({ tone = 'neutral', icon, children, testId, className }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn'; icon?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <span className={`wz-chip ${className ?? ''}`} data-tone={tone} data-testid={testId}>
      {icon}
      {children}
    </span>
  );
}

export const KeyChip = ({ ok, none }: { ok: boolean; none?: boolean }) =>
  none ? (
    <Chip tone="neutral">No key</Chip>
  ) : ok ? (
    <Chip tone="ok" icon={<IconCheck size={12} stroke={2.4} />}>
      Key saved
    </Chip>
  ) : (
    <Chip tone="warn" icon={<IconAlertTriangle size={12} stroke={2.2} />}>
      Key missing
    </Chip>
  );

/** Footer of a step: Back on the left; Skip for now + the primary action on the right. On phones Back is an icon. */
export function WizardFooter({ onBack, onSkip, children }: { onBack?: () => void; onSkip?: () => void; children?: ReactNode }) {
  return (
    <footer className="wz-foot">
      <div>
        {onBack && (
          <button type="button" className="wz-btn wz-ghost wz-back" onClick={onBack} aria-label="Back" data-testid="wz-back">
            <IconArrowLeft size={16} />
            <span className="wz-back-label">Back</span>
          </button>
        )}
      </div>
      <div className="wz-foot-r">
        {onSkip && (
          <button type="button" className="wz-btn wz-ghost" onClick={onSkip} data-testid="wz-skip">
            Skip for now
          </button>
        )}
        {children}
      </div>
    </footer>
  );
}

export function ContinueButton({ onClick, loading, disabled, label = 'Continue' }: { onClick: () => void; loading?: boolean; disabled?: boolean; label?: string }) {
  return (
    <Button className="wz-primary" rightSection={<IconArrowRight size={16} />} loading={loading} disabled={disabled} onClick={onClick} data-testid="wz-next">
      {label}
    </Button>
  );
}

/** Underline tabs (role=tab), with an icon and an optional chip. */
export function WzTabs<T extends string>({ value, onChange, tabs, testId }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string; icon?: ReactNode; chip?: ReactNode; testId?: string }[]; testId?: string }) {
  return (
    <div className="wz-tabs" role="tablist" data-testid={testId}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className="wz-tab" data-on={t.value === value || undefined} onClick={() => onChange(t.value)} data-testid={t.testId}>
          {t.icon}
          {t.label}
          {t.chip}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, aside, hint, error, children }: { label: ReactNode; aside?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <div className="wz-field">
      <div className="wz-lab">
        <span>{label}</span>
        {aside}
      </div>
      {children}
      {error ? <div className="wz-err">{error}</div> : hint ? <div className="wz-hint">{hint}</div> : null}
    </div>
  );
}

export const SECRET_HINT = (
  <>
    Stored in <span className="wz-mono-s">~/.mandate/secrets.env</span>, never shown again.
  </>
);

/** A write-only secret value (sent to the server's secrets.env by the caller; never read back). */
export function SecretInput({ value, onChange, saved, savedLabel, placeholder = 'Paste the key', testId }: { value: string; onChange: (v: string) => void; saved?: boolean; savedLabel?: string; placeholder?: string; testId?: string }) {
  return (
    <TextInput
      type="password"
      className="wz-input"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder={saved ? (savedLabel ?? 'Saved · paste a new key to replace it') : placeholder}
      leftSection={<IconLock size={14} />}
      autoComplete="off"
      data-testid={testId}
    />
  );
}

/** "It works · replied in 0.9 s" / the error. */
export function ResultLine({ result }: { result: { ok: boolean; text: string; sub?: string } | null }) {
  if (!result) return null;
  return (
    <span className="wz-result" data-ok={result.ok || undefined} data-testid="wz-result">
      <span className="wz-okdot">{result.ok ? <IconCheck size={11} stroke={2.6} /> : <IconX size={11} stroke={2.6} />}</span>
      {result.text}
      {result.sub && <span className="wz-result-sub">· {result.sub}</span>}
    </span>
  );
}

export function TestBtn({ onClick, loading, disabled, label = 'Test', testId }: { onClick: () => void; loading?: boolean; disabled?: boolean; label?: string; testId?: string }) {
  return (
    <Button variant="default" className="wz-sec" leftSection={<IconPlayerPlay size={14} />} loading={loading} disabled={disabled} onClick={onClick} data-testid={testId}>
      {label}
    </Button>
  );
}

/** Searchable model list that also takes any typed name ("Use “x” as typed"). */
export function ModelCombo({ value, onChange, models, onLoad, loading, loadDisabled, placeholder = 'Type or pick a model', testId }: { value: string; onChange: (v: string) => void; models: string[] | null; onLoad?: () => void; loading?: boolean; loadDisabled?: boolean; placeholder?: string; testId?: string }) {
  const combo = useCombobox({ onDropdownClose: () => combo.resetSelectedOption() });
  const [search, setSearch] = useState<string | null>(null);
  const q = (search ?? '').trim().toLowerCase();
  const matches = useMemo(() => (models ?? []).filter((m) => !q || m.toLowerCase().includes(q)).slice(0, 60), [models, q]);
  const typed = (search ?? '').trim();
  const showTyped = !!typed && !(models ?? []).includes(typed);
  const pick = (v: string) => {
    onChange(v);
    setSearch(null);
    combo.closeDropdown();
  };
  const mark = (m: string) => {
    if (!q) return m;
    const i = m.toLowerCase().indexOf(q);
    return i < 0 ? (
      m
    ) : (
      <>
        {m.slice(0, i)}
        <mark>{m.slice(i, i + q.length)}</mark>
        {m.slice(i + q.length)}
      </>
    );
  };
  return (
    <div className="wz-row-c wz-g8">
      <Combobox store={combo} onOptionSubmit={pick} withinPortal={false} offset={6}>
        <Combobox.Target>
          <TextInput
            className="wz-input wz-mono-input"
            style={{ flex: 1, minWidth: 0 }}
            value={search ?? value}
            placeholder={placeholder}
            leftSection={<IconSearch size={14} />}
            rightSection={<IconChevronDown size={14} />}
            rightSectionPointerEvents="none"
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              onChange(e.currentTarget.value);
              combo.openDropdown();
              combo.updateSelectedOptionIndex();
            }}
            onFocus={() => models?.length && combo.openDropdown()}
            onClick={() => models?.length && combo.openDropdown()}
            onBlur={() => {
              setSearch(null);
              combo.closeDropdown();
            }}
            data-testid={testId}
          />
        </Combobox.Target>
        <Combobox.Dropdown className="wz-dd" hidden={!matches.length && !showTyped}>
          <Combobox.Options mah={280} style={{ overflowY: 'auto' }}>
            {matches.length > 0 && (
              <Combobox.Group label={<span className="wz-dd-grp"><span>{q ? 'Matches' : 'Models'}</span><span>{matches.length}</span></span>}>
                {matches.map((m) => (
                  <Combobox.Option key={m} value={m} className="wz-dd-it" active={m === value}>
                    <span>{mark(m)}</span>
                    {m === value && <IconCheck size={14} className="wz-dd-r" />}
                  </Combobox.Option>
                ))}
              </Combobox.Group>
            )}
            {showTyped && (
              <>
                {matches.length > 0 && <div className="wz-dd-sep" />}
                <Combobox.Option value={typed} className="wz-dd-it wz-dd-typed">
                  <IconPlus size={14} /> Use “<span className="wz-mono-s">{typed}</span>” as typed
                </Combobox.Option>
              </>
            )}
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>
      {onLoad && (
        <Button variant="default" className="wz-sec wz-load" leftSection={<IconRefresh size={14} />} loading={loading} disabled={loadDisabled} onClick={onLoad} aria-label="Load models" data-testid={testId ? `${testId}-load` : undefined}>
          <span className="wz-load-label">Load models</span>
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ provider marks */

export type MarkKind = 'anth' | 'oai' | 'goog' | 'ci' | 'oll' | 'url';

export function ProviderMark({ kind, small }: { kind: MarkKind; small?: boolean }) {
  const cls = `wz-mk wz-mk-${kind}${small ? ' wz-mk-sm' : ''}`;
  switch (kind) {
    case 'anth':
      return (
        <span className={cls} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M13.8 5h-3L5.5 19h3l1.1-3h5.6l1.1 3h3zM10.6 13.3 12.3 8.7l1.7 4.6z" fill="#fff" />
          </svg>
        </span>
      );
    case 'oai':
      return (
        <span className={cls} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6">
            <g transform="translate(12 12)">
              <ellipse rx="3.2" ry="7" />
              <ellipse rx="3.2" ry="7" transform="rotate(60)" />
              <ellipse rx="3.2" ry="7" transform="rotate(120)" />
            </g>
          </svg>
        </span>
      );
    case 'goog':
      return (
        <span className={cls} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M20.6 12.2c0-.6-.1-1.2-.2-1.8H12v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z" fill="#4285F4" />
            <path d="M12 21c2.4 0 4.5-.8 5.9-2.2L15 16.6c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H4v2.3A9 9 0 0 0 12 21z" fill="#34A853" />
            <path d="M7 13.8a5.4 5.4 0 0 1 0-3.6V7.9H4a9 9 0 0 0 0 8.2z" fill="#FBBC05" />
            <path d="M12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 4 7.9l3 2.3c.7-2.1 2.7-3.6 5-3.6z" fill="#EA4335" />
          </svg>
        </span>
      );
    case 'ci':
      return (
        <span className={cls} aria-hidden="true">
          ci
        </span>
      );
    case 'oll':
      return (
        <span className={cls} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 20v-6.5a5 5 0 0 1 10 0V20" />
            <path d="M8.2 10V5.2C8.2 4 8.8 3.4 9.5 3.4s1.2.6 1.2 1.8V9M15.8 10V5.2c0-1.2-.6-1.8-1.3-1.8s-1.2.6-1.2 1.8V9" />
            <circle cx="10" cy="14" r=".6" fill="#111" stroke="none" />
            <circle cx="14" cy="14" r=".6" fill="#111" stroke="none" />
          </svg>
        </span>
      );
    default:
      return (
        <span className={cls} aria-hidden="true">
          <IconLink size={small ? 13 : 16} />
        </span>
      );
  }
}

export const hostOf = (u: string | null | undefined) => {
  if (!u) return '';
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** The mark for a base URL (Cheaper Inference, Ollama, OpenAI, else a link). */
export const markOfUrl = (u: string | null | undefined): MarkKind => {
  const h = hostOf(u);
  if (/cheaperinference/.test(h)) return 'ci';
  if (/:11434$/.test(h)) return 'oll';
  if (/openai\.com$/.test(h)) return 'oai';
  if (/anthropic\.com$/.test(h)) return 'anth';
  if (/googleapis\.com$/.test(h)) return 'goog';
  return 'url';
};

/** A key variable name suggested for a base URL: api.cheaperinference.com → CHEAPERINFERENCE_API_KEY; local → none. */
export const keyEnvForUrl = (u: string) => {
  let h = '';
  try {
    h = new URL(u).hostname;
  } catch {
    return '';
  }
  if (h === 'localhost' || /^127\./.test(h) || h.endsWith('.local')) return '';
  const parts = h.split('.').filter((p) => !['api', 'www', 'com', 'ai', 'io', 'net', 'org', 'dev', 'co', 'app', 'cloud'].includes(p));
  const name = (parts[0] ?? h.split('.')[0] ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return /^[A-Z]/.test(name) ? `${name}_API_KEY` : '';
};

export const ENV_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
