import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Connection for the restricted api_rpc role (EXECUTE on public.ext_* only).
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Comma-separated chrome-extension://<id> origins allowed by CORS.
  ALLOWED_ORIGINS: z.string().default(''),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  ROUTINES_TOKEN: z.string().min(32).optional(),
  // Remote API (x-api-token). Unset = remote API disabled.
  API_TOKEN: z.string().min(32).optional(),
});
export type Config = z.infer<typeof Env> & { allowedOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable (e.g. API_TOKEN= in a compose file) means "not set".
  const parsed = Env.parse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')),
  );
  return {
    ...parsed,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
