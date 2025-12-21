import Anthropic from "@anthropic-ai/sdk";

export class ClaudeClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chatJSON<T>(systemPrompt: string, userMessage: string): Promise<T> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      temperature: 0.7,
      system: systemPrompt + "\n\nYou must respond with valid JSON only.",
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("No response");

    let jsonStr = text.text
      .replace(/```json?\s*([\s\S]*?)\s*```/g, "$1")
      .trim();

    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      // 不正なエスケープ文字を修正してリトライ
      const fixed = jsonStr.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
        match.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
      );
      return JSON.parse(fixed) as T;
    }
  }
}
