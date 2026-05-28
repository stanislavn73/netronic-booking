import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://booking:booking@localhost:5433/booking'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Allowed CORS origin(s) for the web client. In production this MUST be
   * set to the deployed site origin (e.g. `https://my-app.netlify.app`).
   * Comma-separated list also accepted. Falls back to "*" in dev so any
   * local tooling can hit the API.
   */
  WEB_ORIGIN: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;
