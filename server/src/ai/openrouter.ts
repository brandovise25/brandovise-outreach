// Minimal OpenRouter chat-completions client. Parameter names verified against
// openrouter.ai/docs on 2026-10-08: response_format.json_schema{name,strict,schema},
// provider{require_parameters,data_collection,zdr}, models[] fallbacks, usage.cost always returned.

export interface CompletionRequest {
  model: string;
  fallbackModels: string[];
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  // Only sent when set: some zero-retention endpoints reject it, and require_parameters then
  // filters them all out.
  temperature: number | null;
  maxTokens: number;
}

export interface CompletionResult {
  output: unknown;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  // What the model actually sent (for explaining an answer that fails the checks).
  raw?: { chars: number; whitespace: number; finish: string | null };
}

export class OpenRouterError extends Error {
  // retryable: an empty or cut-off answer, a timeout or a 5xx; worth one more try.
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export type FetchLike = typeof fetch;

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: req.model,
      models: req.fallbackModels.length ? [req.model, ...req.fallbackModels] : undefined,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: req.schemaName, strict: true, schema: req.schema },
      },
      provider: { require_parameters: true, data_collection: 'deny', zdr: true },
      ...(req.temperature === null ? {} : { temperature: req.temperature }),
      max_tokens: req.maxTokens,
    };

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Brandovise Outreach',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      // Keep the message and OpenRouter's routing funnel (which filter removed every endpoint).
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as {
          error?: {
            message?: string;
            metadata?: { routing_funnel?: { step: string; endpoint_count: number }[] };
          };
        };
        const funnel = j.error?.metadata?.routing_funnel
          ?.map((f) => `${f.step}:${f.endpoint_count}`)
          .join(' > ');
        detail = [j.error?.message, funnel && `funnel: ${funnel}`]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 1000);
      } catch {
        /* not JSON */
      }
      throw new OpenRouterError(
        `OpenRouter HTTP ${res.status}: ${detail}`,
        res.status >= 500 || res.status === 429,
      );
    }
    const json = (await res.json()) as {
      model?: string;
      provider?: string;
      choices?: {
        message?: {
          content?: string | { type?: string; text?: string }[] | null;
          refusal?: string | null;
        };
        finish_reason?: string;
        error?: { message?: string; code?: number | string };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const choice = json.choices?.[0];
    const raw = choice?.message?.content;
    // Some providers return content as an array of parts.
    const content = Array.isArray(raw) ? raw.map((p) => p.text ?? '').join('') : raw;
    if (choice?.finish_reason === 'length') {
      throw new OpenRouterError(`output truncated at max_tokens=${req.maxTokens}`, true);
    }
    if (typeof content !== 'string' || !content.trim()) {
      const why = [
        choice?.error?.message && `provider error: ${choice.error.message}`,
        choice?.message?.refusal && `refusal: ${choice.message.refusal}`,
        choice?.finish_reason && `finish_reason: ${choice.finish_reason}`,
        json.provider && `provider: ${json.provider}`,
      ]
        .filter(Boolean)
        .join('; ');
      throw new OpenRouterError(`OpenRouter returned no content${why ? ` (${why})` : ''}`, true);
    }
    let output: unknown;
    try {
      output = JSON.parse(content);
    } catch {
      throw new OpenRouterError('OpenRouter returned non-JSON content');
    }
    return {
      output,
      model: json.model ?? req.model,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      costUsd: json.usage?.cost ?? 0,
      raw: {
        chars: content.length,
        whitespace: (content.match(/\s/g) ?? []).length,
        finish: choice?.finish_reason ?? null,
      },
    };
  }
}
