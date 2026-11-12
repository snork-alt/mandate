import { checkDims, EmbeddingError, type EmbeddingProvider } from './types.js';

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * In-process embeddings with `@huggingface/transformers` (ONNX), e.g. `Xenova/bge-small-en-v1.5` (384 dims).
 * The package is an optional dependency, loaded on first use; models download to the HF cache.
 */
export class LocalProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  private extractor?: Promise<Extractor>;
  constructor(
    private readonly model: string,
    dimensions: number,
    modelId: string,
  ) {
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      const name = '@huggingface/transformers';
      let mod: { pipeline: (task: string, model: string) => Promise<unknown> };
      try {
        mod = (await import(name)) as typeof mod;
      } catch {
        this.extractor = undefined;
        throw new EmbeddingError(`embedding.provider "local" needs the optional package ${name} (npm install ${name} -w @mandate/server)`, false, true);
      }
      return (await mod.pipeline('feature-extraction', this.model)) as Extractor;
    })();
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const extract = await this.load();
    const out = await extract(texts, { pooling: 'mean', normalize: true });
    return checkDims(out.tolist(), this.dimensions, this.model);
  }
}
