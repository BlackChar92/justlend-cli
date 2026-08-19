/**
 * Output contract regression tests. Locks the JSON envelope shape and quiet-mode
 * suppression, both inspired by tronprotocol/wallet-cli's standard CLI contract.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  outputResult,
  outputList,
  outputInfo,
  outputSuccess,
  outputAction,
} from '../src/lib/output.js';
import { setJsonMode, setQuietMode } from '../src/lib/error.js';

function capture(): { restore: () => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(' ')); };
  // capture stdout.write too (emitJson uses it)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any) => { out.push(String(chunk)); return true; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any) => { err.push(String(chunk)); return true; };
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

describe('JSON envelope', () => {
  let cap: ReturnType<typeof capture>;
  beforeEach(() => {
    cap = capture();
    setJsonMode(true);
    setQuietMode(false);
  });
  afterEach(() => {
    cap.restore();
    setJsonMode(false);
    setQuietMode(false);
  });

  it('outputResult wraps data in {success:true,data:...}', () => {
    outputResult({ foo: 'bar', n: 1 }, 'Title', true);
    const payload = JSON.parse(cap.out.join(''));
    assert.deepEqual(payload, { schemaVersion: '1.0.0', success: true, data: { foo: 'bar', n: 1 } });
  });

  it('outputList wraps array in {success:true,data:[...]}', () => {
    outputList([{ a: 1 }, { a: 2 }], 'Rows', true);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, [{ a: 1 }, { a: 2 }]);
  });

  it('outputList wraps empty array correctly', () => {
    outputList([], 'Empty', true);
    const payload = JSON.parse(cap.out.join(''));
    assert.deepEqual(payload, { schemaVersion: '1.0.0', success: true, data: [] });
  });

  it('outputInfo / outputSuccess / outputAction are silent in JSON mode', () => {
    outputInfo('chatty');
    outputSuccess('done');
    outputAction({ k: 'v' });
    assert.equal(cap.out.join(''), '', 'side-channel messages must not leak in JSON mode');
  });
});

describe('Quiet mode', () => {
  let cap: ReturnType<typeof capture>;
  beforeEach(() => {
    cap = capture();
    setJsonMode(false);
    setQuietMode(true);
  });
  afterEach(() => {
    cap.restore();
    setQuietMode(false);
  });

  it('suppresses outputResult/outputList/outputInfo in text mode', () => {
    outputResult({ foo: 'bar' }, 'T', false);
    outputList([{ a: 1 }], 'L', false);
    outputInfo('hi');
    outputSuccess('ok');
    outputAction({ k: 'v' });
    assert.equal(cap.out.join(''), '');
  });

  it('quiet does NOT swallow JSON output (--json wins)', () => {
    setJsonMode(true);
    outputResult({ foo: 'bar' }, 'T', true);
    const payload = JSON.parse(cap.out.join(''));
    assert.deepEqual(payload, { schemaVersion: '1.0.0', success: true, data: { foo: 'bar' } });
  });
});
