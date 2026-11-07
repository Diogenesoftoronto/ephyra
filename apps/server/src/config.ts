import { z } from "zod";

const Config = z.object({
  DATABASE_URL: z.string().url().optional(),
  EPHYRA_API_TOKEN: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type Config = z.infer<typeof Config>;
export function readConfig(env: Record<string, string | undefined>): Config {
  return Config.parse(env);
}
