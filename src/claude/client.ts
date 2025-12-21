import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

export class ClaudeClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chatJSON<T>(
    systemPrompt: string,
    userMessage: string,
    schema: Tool["input_schema"]
  ): Promise<T> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: [
        {
          name: "respond",
          description: "Respond with result",
          input_schema: schema,
        },
      ],
      tool_choice: { type: "tool", name: "respond" },
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("No response");

    return toolUse.input as T;
  }
}
