import { ZodError } from 'zod';
import type { AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { PreparedTask } from './tasks.ts';
import { OpenRouterError } from './openrouter.ts';

// Invalid (schema-breaking) output is retried at most twice, then reported (PLAN 7, common rules).
const MAX_ATTEMPTS = 3;

export interface TaskRun<T> {
  output: T;
  model: string;
  promptVersion: number;
  costUsd: number;
  usage: { promptTokens: number; completionTokens: number };
}

// Runs a prepared task: budget check, OpenRouter call, deterministic verification, ai_calls logging.
export async function runTask<T>(
  deps: AppDeps,
  userId: string,
  taskName: string,
  task: PreparedTask,
  ids: { runId?: number; prospectId?: number } = {},
): Promise<TaskRun<T>> {
  if (!deps.openrouter)
    throw new HttpError(503, 'upstream_error', 'AI is not configured on this server');
  let totalCost = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const budget = await callJson<{ left: number }>(deps.db, 'ext_ai_budget_left', [userId]);
    if (Number(budget.left) <= 0)
      throw new HttpError(402, 'budget_exhausted', 'daily AI budget used up');

    const started = Date.now();
    const log = (f: {
      model: string | null;
      promptTokens: number | null;
      completionTokens: number | null;
      cost: number;
      ok: boolean;
      error: string | null;
      output: unknown;
    }) =>
      callJson(deps.db, 'ext_log_ai_call', [
        userId,
        taskName,
        task.version,
        f.model,
        ids.runId ?? null,
        ids.prospectId ?? null,
        f.promptTokens,
        f.completionTokens,
        f.cost,
        Date.now() - started,
        f.ok,
        f.error,
        f.output === null ? null : JSON.stringify(f.output),
      ]);

    let result;
    try {
      result = await deps.openrouter.complete(task.request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await log({
        model: task.request.model,
        promptTokens: null,
        completionTokens: null,
        cost: 0,
        ok: false,
        error: message,
        output: null,
      });
      // An empty, cut-off or 5xx answer gets one more try (within the same attempt budget).
      const retryable =
        (err instanceof OpenRouterError && err.retryable) ||
        (err instanceof Error && err.name === 'TimeoutError');
      if (retryable && attempt < MAX_ATTEMPTS) continue;
      throw new HttpError(502, 'upstream_error', `AI call failed: ${message.slice(0, 160)}`);
    }
    totalCost += result.costUsd;

    let verified: unknown;
    try {
      verified = task.verify(result.output);
    } catch (err) {
      // Say what failed and what came back, so a failing answer explains itself in ai_calls.
      const issue =
        err instanceof ZodError
          ? err.issues
              .slice(0, 2)
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ')
          : String(err).slice(0, 120);
      const raw = result.raw
        ? `; reply ${result.raw.chars} chars (${result.raw.whitespace} whitespace), finish ${result.raw.finish ?? '?'}`
        : '';
      await log({
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cost: result.costUsd,
        ok: false,
        error: `output failed schema validation (attempt ${attempt}): ${issue}${raw}`.slice(0, 500),
        output: result.output,
      });
      continue;
    }
    await log({
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cost: result.costUsd,
      ok: true,
      error: null,
      output: verified,
    });
    return {
      output: verified as T,
      model: result.model,
      promptVersion: task.version,
      costUsd: totalCost,
      usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
    };
  }
  throw new HttpError(502, 'upstream_error', 'AI output failed validation; needs human');
}
