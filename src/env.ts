import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { Coverage } from './model/types.js';

/** Settings bkj2c reads from the environment (or `.env`). Flags on the command line win over these. */
export interface EnvSettings {
  tenant?: string;
  realm?: string;
  export?: string;
  out?: string;
  withSession?: string;
  minCoverage?: Coverage;
  port?: number;
}

/**
 * Load `.env` (or the file in BKJ2C_ENV_FILE) into `env`. Variables that are already set are kept, so the
 * real environment wins over the file. Returns the file that was read, if any.
 */
export function loadDotEnv(
  env: NodeJS.ProcessEnv = process.env,
  file = env.BKJ2C_ENV_FILE ?? '.env',
): string | undefined {
  if (!existsSync(file)) {
    if (env.BKJ2C_ENV_FILE) throw new Error(`BKJ2C_ENV_FILE: ${file} does not exist`);
    return undefined;
  }
  const values = parseEnv(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(values)) {
    if (env[k] === undefined) env[k] = v;
  }
  return file;
}

const COVERAGES: Coverage[] = ['full', 'partial', 'manual'];

/** Read the BKJ2C_* settings; empty values count as unset. */
export function envSettings(env: NodeJS.ProcessEnv = process.env): EnvSettings {
  const get = (k: string) => {
    const v = env[`BKJ2C_${k}`]?.trim();
    return v ? v : undefined;
  };
  const s: EnvSettings = {};
  const tenant = get('TENANT');
  if (tenant) s.tenant = tenant.replace(/\/+$/, '');
  const realm = get('REALM');
  if (realm) s.realm = realm;
  const exp = get('EXPORT');
  if (exp) s.export = exp;
  const out = get('OUT');
  if (out) s.out = out;
  const session = get('WITH_SESSION');
  if (session) s.withSession = session;
  const min = get('MIN_COVERAGE');
  if (min) {
    if (!COVERAGES.includes(min as Coverage))
      throw new Error(`BKJ2C_MIN_COVERAGE must be one of ${COVERAGES.join(', ')}`);
    s.minCoverage = min as Coverage;
  }
  const port = get('PORT');
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('BKJ2C_PORT must be a port number');
    s.port = n;
  }
  return s;
}
