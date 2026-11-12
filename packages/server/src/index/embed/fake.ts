import type { EmbeddingProvider } from './types.js';

/**
 * Deterministic bag-of-words vectors for tests: each word (and its 4-letter stem) hashes to a
 * dimension, so texts sharing words are close. No network, no model.
 */
export class FakeProvider implements EmbeddingProvider {
  readonly modelId: string;
  calls = 0;
  embedded = 0;
  constructor(
    readonly dimensions = 64,
    modelId = `fake:${dimensions}`,
    /** Words treated as synonyms: each maps to a canonical word. */
    private readonly synonyms: Record<string, string> = {},
  ) {
    this.modelId = modelId;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    this.embedded += texts.length;
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (const raw of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const w = this.synonyms[raw] ?? raw;
        if (w.length < 3) continue;
        for (const tok of [w, w.slice(0, 4)]) {
          let h = 2166136261;
          for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
          v[(h >>> 0) % this.dimensions]! += 1;
        }
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}
