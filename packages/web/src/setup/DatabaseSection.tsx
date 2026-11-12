/**
 * Settings → Database (server mode, advanced): SQLite (default: a file under ~/.mandate) or Postgres for state shared by
 * several server instances. The connection URL is a write-only secret (secrets.env); config.json only names its
 * variable. "Test connection" checks the version, pgvector / pg_trgm (and the schema they live in, e.g. Supabase's
 * `extensions`), privileges, pooler mode and TLS. A change applies after a restart.
 */
import { Group, NumberInput, Select, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconDatabase, IconServer2 } from '@tabler/icons-react';
import { useState } from 'react';
import { Field, Notice } from '../connect/parts';
import { setupApi, type DatabaseProbe, type DatabaseSettings } from './api';
import { usePatchConfig, useSaver, type SectionProps } from './sections';
import { ChoiceCard, SecretField, StepIntro, TestButton } from './widgets';

type Ssl = NonNullable<DatabaseSettings['ssl']>;

export function DatabaseSection({ state, register, variant }: SectionProps) {
  const cur = state.config.database;
  const patch = usePatchConfig();
  const [driver, setDriver] = useState<DatabaseSettings['driver']>(cur?.driver ?? 'sqlite');
  const [ssl, setSsl] = useState<Ssl | ''>(cur?.ssl ?? '');
  const [poolMax, setPoolMax] = useState<number>(cur?.pool.max ?? 10);
  const [extSchema, setExtSchema] = useState(cur?.extensionsSchema ?? '');
  const [urlSet, setUrlSet] = useState(!!cur?.urlSet);
  const [probe, setProbe] = useState<DatabaseProbe | null>(null);
  const urlEnv = cur?.urlEnv ?? 'MANDATE_DATABASE_URL';

  useSaver(register, async () => {
    if (!cur) return;
    const next = { driver, ssl: ssl || null, extensionsSchema: extSchema.trim() || null, pool: { ...cur.pool, max: poolMax } };
    const same = driver === cur.driver && (ssl || null) === cur.ssl && (extSchema.trim() || null) === cur.extensionsSchema && poolMax === cur.pool.max;
    if (!same) await patch({ database: next });
  });

  if (!cur) return <Text size="sm">This server does not report database settings.</Text>;
  const test = async (createExtensions = false) => {
    const r = await setupApi.databaseTest({ urlEnv, ssl: ssl || null, extensionsSchema: extSchema.trim() || null, ...(createExtensions ? { createExtensions } : {}) });
    setProbe(r.details);
    return r;
  };
  const missing = probe ? Object.entries(probe.extensions).filter(([, e]) => !e.installed) : [];
  const pending = cur.active !== cur.driver;

  return (
    <div className="su-section" data-testid="database-section">
      <StepIntro title="Database" optional={variant === 'wizard'}>
        Where Mandate keeps server state (sign-in sessions, agent tokens, OAuth grants, idempotency results). SQLite needs nothing; Postgres lets several server instances share it. Your
        specifications stay in git either way.
      </StepIntro>
      <div className="su-choices" role="radiogroup">
        <ChoiceCard selected={driver === 'sqlite'} onSelect={() => setDriver('sqlite')} icon={<IconDatabase size={16} />} title="SQLite" description="A file under ~/.mandate. Right for one server." recommended testId="db-sqlite" />
        <ChoiceCard selected={driver === 'postgres'} onSelect={() => setDriver('postgres')} icon={<IconServer2 size={16} />} title="Postgres" description="Shared state for several instances (Supabase, RDS, Neon, your own)." testId="db-postgres">
          {driver === 'postgres' && (
            <div className="np-stack">
              <SecretField name={urlEnv} isSet={urlSet} label="Connection URL" placeholder="postgresql://user:password@host:5432/postgres?sslmode=require" onSaved={setUrlSet} testId="db-url" />
              <Text size="xs" c="dimmed">
                Saved as the secret {urlEnv} in ~/.mandate/secrets.env, never in config.json. On Supabase use the direct connection (port 5432) or the session pooler, not the transaction pooler (6543).
              </Text>
              <Group gap={12} grow>
                <Field label="TLS">
                  <Select size="sm" value={ssl} onChange={(v) => setSsl((v ?? '') as Ssl | '')} data={[{ value: '', label: 'From the URL (sslmode)' }, { value: 'require', label: 'Require (Supabase)' }, { value: 'verify-full', label: 'Verify certificate' }, { value: 'disable', label: 'Off (local only)' }]} data-testid="db-ssl" />
                </Field>
                <Field label="Pool size">
                  <NumberInput size="sm" min={1} max={200} value={poolMax} onChange={(v) => setPoolMax(typeof v === 'number' ? v : 10)} />
                </Field>
                <Field label="Extensions schema" hint="Default: extensions (Supabase) when it exists, else public.">
                  <TextInput size="sm" value={extSchema} placeholder="extensions" onChange={(e) => setExtSchema(e.currentTarget.value)} />
                </Field>
              </Group>
              <Group gap={8}>
                <TestButton label="Test connection" run={() => test()} disabled={!urlSet} testId="db-test" />
                {missing.some(([, e]) => e.available) && <TestButton label="Enable missing extensions" run={() => test(true)} testId="db-create-ext" />}
              </Group>
              {probe && <ProbeDetails probe={probe} />}
            </div>
          )}
        </ChoiceCard>
      </div>
      {pending && (
        <Notice icon={<IconAlertTriangle size={16} />} tone="warn" title="Restart to apply">
          This server runs on {cur.active === 'postgres' ? 'Postgres' : 'SQLite'}; the saved choice takes effect after a restart. Existing sessions and tokens are not copied between backends: people sign in again
          and personal tokens are recreated.
        </Notice>
      )}
    </div>
  );
}

function ProbeDetails({ probe }: { probe: DatabaseProbe }) {
  return (
    <div className="np-stack" data-testid="db-probe">
      {probe.version && (
        <Text size="xs">
          <IconCheck size={12} /> {probe.version.split(' ').slice(0, 2).join(' ')} · {probe.ssl ? 'TLS' : 'no TLS'} · {probe.pooler === 'none' ? 'direct connection' : `${probe.pooler} pooler`}
        </Text>
      )}
      {Object.entries(probe.extensions).map(([name, e]) => (
        <Text size="xs" key={name}>
          {e.installed ? <IconCheck size={12} /> : <IconAlertTriangle size={12} />} {name}: {e.installed ? `enabled in schema ${e.schema}` : e.available ? 'available, not enabled' : 'not available on this server'}
        </Text>
      ))}
      {[...probe.errors, ...probe.warnings].map((m) => (
        <Text size="xs" key={m} c={probe.errors.includes(m) ? 'red' : 'yellow'}>
          {m}
        </Text>
      ))}
    </div>
  );
}
