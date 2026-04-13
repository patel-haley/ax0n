const SUMMARIZE_PROMPT =
  "Summarize this in one concise sentence for a developer memory system. " +
  "Return only the summary, no preamble: ";

export class OllamaSummarizer {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(model = "llama3", baseUrl = "http://localhost:11434") {
    this.model = model.trim();
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async summarize(text: string): Promise<string> {
    if (!this.model) {
      throw new Error("Ollama summarization is disabled");
    }

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: SUMMARIZE_PROMPT + text, stream: false }),
    });

    if (!response.ok) {
      throw new Error(`Ollama /api/generate returned ${response.status}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response.trim();
  }

  async isAvailable(): Promise<boolean> {
    if (!this.model) {
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as { models?: { name?: string }[] };
      return (
        data.models?.some(
          (model) =>
            model.name === this.model ||
            model.name?.startsWith(`${this.model}:`)
        ) ?? false
      );
    } catch {
      return false;
    }
  }
}
