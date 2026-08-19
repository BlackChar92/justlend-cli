import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): RunResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'bin/cli.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    },
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseSingleJson(stream: string): Record<string, unknown> {
  const trimmed = stream.trim();
  assert.ok(trimmed.length > 0, 'expected JSON output');
  assert.equal(trimmed.split('\n').length, 1, `expected exactly one JSON line, got: ${trimmed}`);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

describe('CLI process JSON contract', () => {
  it('emits one structured parser error for an unknown command', () => {
    const result = run('--json', 'definitely-not-a-command');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(parseSingleJson(result.stderr), {
      schemaVersion: '1.0.0',
      success: false,
      error: "unknown command 'definitely-not-a-command'",
      code: 'CLI_USAGE_ERROR',
      retryable: false,
      hint: 'Run `justlend --help` or `justlend <command> --help` and correct the arguments.',
    });
  });

  it('emits one structured parser error for invalid option input', () => {
    const result = run('--json', '--port', 'not-a-port', 'network');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const payload = parseSingleJson(result.stderr);
    assert.equal(payload.schemaVersion, '1.0.0');
    assert.equal(payload.success, false);
    assert.equal(payload.code, 'CLI_USAGE_ERROR');
    assert.equal(payload.retryable, false);
    assert.match(String(payload.error), /Invalid port/);
  });

  it('versions a successful command envelope', () => {
    const result = run('--json', 'network');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(payload.schemaVersion, '1.0.0');
    assert.equal(payload.success, true);
    assert.equal(typeof payload.data, 'object');
  });

  it('ships a schema matching the declared v1 contract', () => {
    const schema = JSON.parse(readFileSync('schemas/output-v1.schema.json', 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.oneOf[0].properties.schemaVersion.const, '1.0.0');
    assert.equal(schema.oneOf[1].properties.schemaVersion.const, '1.0.0');
    assert.deepEqual(schema.oneOf[1].required, [
      'schemaVersion', 'success', 'error', 'code', 'retryable',
    ]);
  });
});
