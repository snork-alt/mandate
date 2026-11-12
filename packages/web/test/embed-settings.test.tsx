// @vitest-environment jsdom
/** Settings → Semantic search, remote endpoint: Ask key reuse, model list, Test (dimension autodetect), privacy note, switch estimate, saved patch. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SetupState } from '../src/setup/api';
import { SearchSection } from '../src/setup/SearchSection';
import type { Saver } from '../src/setup/sections';
import { installDom, Wrap } from './dom';

beforeAll(installDom);
afterEach(() => vi.unstubAllGlobals());

const CI = 'https://api.cheaperinference.com/v1';
const state: SetupState = {
  complete: true,
  configVersion: 'v1',
  config: {
    local: { baseDir: '/home/me/mandate' },
    server: { mode: 'local', publicUrl: null, bind: '127.0.0.1', port: 4000, trustProxy: false },
    ask: { default: 'luna', models: [{ id: 'luna', provider: 'openai-compatible', model: 'gpt-6-luna', baseUrl: CI, apiKeyEnv: 'CHEAPERINFERENCE_API_KEY', apiKeySet: true }] },
    embedding: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', dimensions: 768, apiKeyEnv: null, apiKeySet: false, preset: 'ollama', requestDimensions: null, maxInputTokens: 2048, batchSize: 32, documentPrefix: 'search_document: ', queryPrefix: 'search_query: ', remote: false },
    git: {} as never,
  },
};

function server() {
  const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    switch (url) {
      case '/ui/setup/state':
        return json(state);
      case '/ui/setup/embedding/detect':
        return json({ ollama: true, baseUrl: 'http://localhost:11434/v1', models: ['nomic-embed-text:latest'], hasNomic: true, install: [] });
      case '/ui/setup/embedding/keys':
        return json({ candidates: body?.baseUrl === CI ? [{ askModelId: 'luna', label: 'gpt-6-luna', apiKeyEnv: 'CHEAPERINFERENCE_API_KEY', apiKeySet: true }] : [], apiKeyEnvSet: false });
      case '/ui/setup/embedding/models':
        return json({ ok: true, models: [{ id: 'qwen3-embedding-8b', pricePerMTok: 0.01, known: true }, { id: 'text-embedding-3-small', pricePerMTok: 0.017, known: true }], suggested: 'text-embedding-3-small', total: 3, message: '2 embedding models available.' });
      case '/ui/setup/embedding/preset':
        return json({ family: 'OpenAI', documentPrefix: '', queryPrefix: '', maxInputTokens: 8000, batchSize: 128, dimensions: 1536, shortenTo: [256, 512, 1024, 1536], pricePerMTok: 0.02, known: true });
      case '/ui/setup/embedding/test':
        return json({ ok: true, dimensions: 1536, ms: 210, message: 'text-embedding-3-small works: 1536 dimensions, 210 ms.', preset: {} });
      case '/ui/setup/embedding/estimate':
        return json({ chunks: 1200, tokens: 360_000, avgTokens: 300, costUsd: 0.0061, pricePerMTok: 0.017, projects: [] });
      case '/ui/setup/config':
        return json({ configVersion: 'v2', restartRequired: false });
      default:
        return new Response('{}', { status: 404 });
    }
  });
  return calls;
}

describe('SearchSection (remote)', () => {
  it('reuses the Ask key, picks the recommended model, detects dimensions and saves a strict patch', async () => {
    const calls = server();
    let saver: Saver | null = null;
    render(
      <Wrap>
        <SearchSection state={state} variant="settings" register={(fn) => (saver = fn)} />
      </Wrap>,
    );
    fireEvent.click(screen.getByTestId('search-remote').querySelector('button')!);
    fireEvent.click(screen.getByTestId('embed-preset-cheaperinference'));
    await screen.findByText(/Use the same key as Ask model/);
    expect(screen.getByTestId('embed-reuse-key')).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId('embed-model') as HTMLInputElement).value).toBe('text-embedding-3-small'));
    expect(screen.getByTestId('embed-privacy').textContent).toContain('api.cheaperinference.com');
    await screen.findByTestId('embed-facts');
    fireEvent.click(screen.getByTestId('embed-remote-test'));
    await screen.findByText(/1536 dimensions, 210 ms/);
    expect(calls.find((c) => c.url === '/ui/setup/embedding/test')!.body).toMatchObject({ baseUrl: CI, apiKeyEnv: 'CHEAPERINFERENCE_API_KEY', model: 'text-embedding-3-small', requestDimensions: null });
    const sw = await screen.findByTestId('embed-switch');
    await waitFor(() => expect(sw.textContent).toMatch(/1,200 chunks × ~300 tokens ≈ 360,000 tokens \(under \$0\.01 at/));
    expect(sw.textContent).toContain('keeps answering from nomic-embed-text');

    await saver!();
    const put = calls.find((c) => c.url === '/ui/setup/config')!;
    expect(put.body).toEqual({
      configVersion: 'v1',
      patch: {
        embedding: {
          provider: 'openai-compatible',
          preset: 'cheaperinference',
          baseUrl: CI,
          model: 'text-embedding-3-small',
          apiKeyEnv: 'CHEAPERINFERENCE_API_KEY',
          dimensions: 1536,
          requestDimensions: null,
          documentPrefix: '',
          queryPrefix: '',
          maxInputTokens: 8000,
          batchSize: 128,
        },
      },
    });
  });

  it('leaves an unchanged local config alone', async () => {
    const calls = server();
    let saver: Saver | null = null;
    render(
      <Wrap>
        <SearchSection state={state} variant="settings" register={(fn) => (saver = fn)} />
      </Wrap>,
    );
    await screen.findByText(/Ollama is running/);
    await saver!();
    expect(calls.some((c) => c.url === '/ui/setup/config')).toBe(false);
  });
});
