import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { formatIssues } from './model/schema.js';

const solverSchema = z.object({
  /** Journey name; omit to match any journey. */
  journey: z.string().optional(),
  /** Node name or id (a Page Node child, a scripted node, ...). */
  node: z.string(),
  /** Callback position inside the step (0-based); default: the first callback with an input. */
  callback: z.number().int().min(0).optional(),
  /** Input position inside the callback (0-based); default 0. */
  input: z.number().int().min(0).optional(),
  /** jq expression evaluated against the last response; its result becomes the input value. */
  jq: z.string(),
  label: z.string().optional(),
});

export const configSchema = z.object({
  tenant: z.string().optional(),
  realm: z.string().optional(),
  /** Default values written into generated scripts, keyed by variable (IN_USERNAME ...). */
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Attribute types for Attribute Collector nodes (attribute -> type). */
  attributeTypes: z.record(z.string(), z.enum(['string', 'boolean', 'number'])).optional(),
  /** Number of KBA questions the tenant requires at registration (default 1). */
  kbaCount: z.number().int().min(1).optional(),
  /** Branch pins, same syntax as --choose ("<node name or id>=<outcome>"). */
  choose: z.array(z.string()).optional(),
  solvers: z.array(solverSchema).optional(),
});

export type BkConfig = z.infer<typeof configSchema>;
export type CustomSolver = z.infer<typeof solverSchema>;

export function loadConfig(path?: string): BkConfig {
  const file = path ?? (existsSync('bk.config.json') ? 'bk.config.json' : undefined);
  if (!file) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read config ${file}: ${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid config ${file}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}
