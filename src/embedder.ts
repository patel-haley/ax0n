import { pipeline, env, Tensor } from "@xenova/transformers";

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline>>;

const MODEL = "Xenova/all-MiniLM-L6-v2";

export class Embedder {
  private _pipe: FeatureExtractionPipeline | null = null;
  private _loading: Promise<FeatureExtractionPipeline> | null = null;
  private _log: (msg: string) => void;

  constructor(cacheDir?: string, log?: (msg: string) => void) {
    this._log = log ?? ((msg) => process.stderr.write(`[cortex] ${msg}\n`));

    env.allowLocalModels = false;
    env.backends.onnx.wasm.numThreads = 1;

    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
  }

  private _load(): Promise<FeatureExtractionPipeline> {
    if (this._pipe) {
      return Promise.resolve(this._pipe);
    }

    if (!this._loading) {
      this._loading = pipeline("feature-extraction", MODEL).then((p) => {
        this._pipe = p;
        this._loading = null;
        this._log("T1 model loaded ✓");
        return p;
      });
    }

    return this._loading;
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await this._load();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await (pipe as any)(text, { pooling: "mean", normalize: true }) as Tensor;

    return output.data as Float32Array;
  }
}
