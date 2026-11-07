import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { envSettings, loadDotEnv } from '../src/env.js';

const dir = mkdtempSync(join(tmpdir(), 'bkj2c-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('.env', () => {
  it('loads the file but keeps values already in the environment', () => {
    const file = join(dir, '.env');
    writeFileSync(
      file,
      '# comment\nBKJ2C_TENANT=https://from-file.example.com/\nBKJ2C_REALM=alpha\nBKJ2C_OUT="my out"\n',
    );
    const env: NodeJS.ProcessEnv = { BKJ2C_REALM: 'bravo' };
    expect(loadDotEnv(env, file)).toBe(file);
    expect(envSettings(env)).toEqual({ tenant: 'https://from-file.example.com', realm: 'bravo', out: 'my out' });
  });

  it('a missing .env is fine, a missing BKJ2C_ENV_FILE is an error', () => {
    expect(loadDotEnv({}, join(dir, 'nope'))).toBeUndefined();
    expect(() => loadDotEnv({ BKJ2C_ENV_FILE: join(dir, 'nope') })).toThrow(/does not exist/);
  });

  it('empty values count as unset; bad values are rejected', () => {
    expect(envSettings({ BKJ2C_MIN_COVERAGE: '', BKJ2C_TENANT: '  ' })).toEqual({});
    expect(envSettings({ BKJ2C_MIN_COVERAGE: 'partial', BKJ2C_PORT: '8080', BKJ2C_WITH_SESSION: 'Login' })).toEqual({
      minCoverage: 'partial',
      port: 8080,
      withSession: 'Login',
    });
    expect(() => envSettings({ BKJ2C_MIN_COVERAGE: 'most' })).toThrow(/BKJ2C_MIN_COVERAGE/);
    expect(() => envSettings({ BKJ2C_PORT: '99999' })).toThrow(/BKJ2C_PORT/);
  });

  it('.env.example only uses known BKJ2C_ settings', async () => {
    const { readFileSync } = await import('node:fs');
    const { parseEnv } = await import('node:util');
    const keys = Object.keys(parseEnv(readFileSync('.env.example', 'utf8')));
    expect(keys.sort()).toEqual([
      'BKJ2C_EXPORT',
      'BKJ2C_MIN_COVERAGE',
      'BKJ2C_OUT',
      'BKJ2C_PORT',
      'BKJ2C_REALM',
      'BKJ2C_TENANT',
      'BKJ2C_WITH_SESSION',
    ]);
  });
});
