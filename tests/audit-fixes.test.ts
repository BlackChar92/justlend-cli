import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';

import { requireExplicitUnlimitedApproval, resolveApprovalAmount } from '../src/lib/approval.js';
import { getApiHost, getMoolahApiHost } from '../src/lib/chains.js';
import { validateTrustedUrl, resetTrustedUrlWarningsForTests } from '../src/lib/trusted-url.js';
import { outputSignedTx } from '../src/lib/output.js';
import { setJsonMode, setQuietMode } from '../src/lib/error.js';
import { estimateApyForTest } from '../src/lib/v1-onchain.js';
import { utils } from '../src/lib/utils.js';

function capture(): { restore: () => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(' ')); };
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

describe('audit fixes: unlimited approval guard', () => {
  it('rejects implicit unlimited approval without an explicit flag', () => {
    assert.throws(
      () => requireExplicitUnlimitedApproval({ amountLabel: 'max', allowUnlimited: false, spender: 'TSpender' }),
      /requires --unlimited|--max/i,
    );
  });

  it('allows explicit unlimited approval', () => {
    assert.doesNotThrow(() => requireExplicitUnlimitedApproval({ amountLabel: 'max', allowUnlimited: true, spender: 'TSpender' }));
  });

  it('resolves finite approval amounts with token decimals', () => {
    assert.equal(resolveApprovalAmount('1.5', 6, false).toString(), '1500000');
  });

  it('rejects negative approval amounts (no two\'s-complement wrap to near-unlimited)', () => {
    assert.throws(() => resolveApprovalAmount('-1', 6, false), /Invalid numeric value/);
    assert.throws(() => resolveApprovalAmount('-0.5', 18, true), /Invalid numeric value/);
  });
});

describe('audit fixes: integer SUN conversion', () => {
  it('converts TRX decimals to integer SUN strings', () => {
    assert.equal(utils.toSun('0.1'), '100000');
    assert.equal(utils.toSun('1.234567'), '1234567');
  });

  it('rejects non-integer SUN fractions instead of returning decimal strings', () => {
    assert.throws(() => utils.toSun('1.2345678'), /at most 6 decimals/);
  });
});

describe('audit fixes: trusted URL validation', () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...oldEnv };
    resetTrustedUrlWarningsForTests();
  });

  afterEach(() => {
    process.env = { ...oldEnv };
    resetTrustedUrlWarningsForTests();
  });

  it('rejects insecure custom hosts by default', () => {
    assert.throws(() => validateTrustedUrl('http://evil.example', 'fullHost'), /must use https/i);
  });

  it('rejects untrusted custom hosts unless explicitly allowed', () => {
    assert.throws(() => validateTrustedUrl('https://evil.example', 'apiHost'), /not in the trusted allowlist/i);
  });

  it('accepts explicit untrusted hosts with allowUntrusted=true', () => {
    assert.equal(validateTrustedUrl('https://evil.example', 'apiHost', { allowUntrusted: true }), 'https://evil.example');
  });

  it('applies validation to backend host env overrides', () => {
    process.env.JUSTLEND_API_HOST = 'https://evil.example/api';
    assert.throws(() => getApiHost('nile'), /not in the trusted allowlist/i);
    process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS = '1';
    assert.equal(getApiHost('nile'), 'https://evil.example/api');
  });

  it('applies validation to moolah host env overrides', () => {
    process.env.JUSTLEND_MOOLAH_API_HOST = 'https://evil.example';
    assert.throws(() => getMoolahApiHost('mainnet'), /not in the trusted allowlist/i);
  });
});

describe('audit fixes: signed transaction output', () => {
  let cap: ReturnType<typeof capture>;

  beforeEach(() => {
    cap = capture();
    setJsonMode(false);
    setQuietMode(false);
  });

  afterEach(() => {
    cap.restore();
    setJsonMode(false);
    setQuietMode(false);
  });

  it('redacts raw signedTransaction by default', () => {
    outputSignedTx({ txID: 'abc', raw_data_hex: 'deadbeef', signature: ['sig'] });
    const text = cap.out.join('\n');
    assert.match(text, /Signed Transaction Redacted/);
    assert.doesNotMatch(text, /deadbeef|\"sig\"/);
  });

  it('dumps raw signedTransaction only when explicitly requested', () => {
    outputSignedTx({ txID: 'abc', raw_data_hex: 'deadbeef', signature: ['sig'] }, { dump: true });
    const text = cap.out.join('\n');
    assert.match(text, /deadbeef/);
    assert.match(text, /anyone can broadcast/i);
  });
});

describe('audit fixes: optional on-chain read warnings', () => {
  it('does not silently swallow optional on-chain read failures in audited files', () => {
    const auditedFiles = [
      'src/lib/v1-onchain.ts',
      'src/commands/sun.ts',
      'src/commands/strx.ts',
      'src/commands/advanced.ts',
      'src/commands/energy.ts',
      'src/commands/v1/index.ts',
      'src/lib/moolah.ts',
    ];
    for (const file of auditedFiles) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /\.catch\(\(\) => undefined\)/, `${file} still has silent .catch(() => undefined)`);
      assert.doesNotMatch(source, /async function callOptional[\s\S]*?catch\s*\{\s*return undefined;?\s*\}/, `${file} still has silent optional on-chain reads`);
    }
  });
});


describe('v1.0.1 audit remediation: write confirmation guard', () => {
  it('requires explicit --yes for non-interactive JSON/quiet write paths', async () => {
    const { requireExplicitWriteConsent } = await import('../src/lib/output.js');
    setJsonMode(true);
    setQuietMode(false);
    assert.throws(
      () => requireExplicitWriteConsent(false, { interactive: false, mode: 'json' }),
      /--yes/i,
    );
    setJsonMode(false);
    setQuietMode(true);
    assert.throws(
      () => requireExplicitWriteConsent(false, { interactive: false, mode: 'quiet' }),
      /--yes/i,
    );
    assert.doesNotThrow(() => requireExplicitWriteConsent(true, { interactive: false, mode: 'json' }));
  });
});

describe('v1.0.1 audit remediation: IPC authentication contract', () => {
  it('requires an authenticated IPC envelope before dispatching signer calls', async () => {
    const { createIPCAuthToken, validateIPCRequest } = await import('../src/lib/ipc.js');
    const token = createIPCAuthToken();
    assert.equal(typeof token, 'string');
    assert.ok(token.length >= 32);
    assert.throws(
      () => validateIPCRequest({ id: 1, method: 'signTransaction', params: {} }, token),
      /IPC authentication required/i,
    );
    assert.throws(
      () => validateIPCRequest({ id: 1, method: 'signTransaction', token: 'wrong', params: {} }, token),
      /IPC authentication failed/i,
    );
    assert.throws(
      () => validateIPCRequest(
        { id: 1, method: 'signTransaction', token, params: {} },
        undefined as unknown as string,
      ),
      /IPC authentication unavailable/i,
    );
    assert.doesNotThrow(() => validateIPCRequest({ id: 1, method: 'signTransaction', token, params: {} }, token));
  });
});

describe('v1.0.1 audit remediation: transaction summaries', () => {
  it('builds signer-facing metadata with contract, signature, args, callValue, feeLimit, and broadcast mode', async () => {
    const { buildTxSummary } = await import('../src/lib/tx.js');
    const summary = buildTxSummary({
      network: 'nile',
      ownerAddress: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      contractAddress: 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd',
      signature: 'approve(address,uint256)',
      typedParams: [{ type: 'address', value: 'TSpender' }, { type: 'uint256', value: '1000' }],
      callValue: 0n,
      feeLimitSun: 100000000,
      broadcast: true,
      localBroadcast: false,
      mode: 'sign+broadcast',
      preview: { action: 'TRC20 approve', amount: '1000' },
      simulationStatus: 'not-run',
    });
    assert.deepEqual(summary.typedArgs, [{ type: 'address', value: 'TSpender' }, { type: 'uint256', value: '1000' }]);
    assert.equal(summary.network, 'nile');
    assert.equal(summary.contract, 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd');
    assert.equal(summary.function, 'approve(address,uint256)');
    assert.equal(summary.callValue, '0');
    assert.equal(summary.feeLimitSun, 100000000);
    assert.equal(summary.broadcast, true);
    assert.equal(summary.localBroadcast, false);
    assert.equal(summary.simulationStatus, 'not-run');
  });
});

describe('v1.0.1 audit remediation: reward precision helpers', () => {
  it('aggregates decimal reward USD totals without floating point precision loss', async () => {
    const { calculateV1MiningRewardsForTest } = await import('../src/commands/rewards.js');
    const result = calculateV1MiningRewardsForTest([
      { collateralSymbol: 'USDD', jtokenAddress: 'TJ', miningInfo: { USDDNEW: { price: '0.1', gainNew: '0.2', gainLast: '0.3', miningStatus: 1 } } },
      { collateralSymbol: 'JST', jtokenAddress: 'TJ2', miningInfo: { JSTNEW: { price: '0.333333333333333333', gainNew: '3', gainLast: '0', miningStatus: 1 } } },
    ]);
    assert.equal(result.totalUnclaimedUSD, '1.049999999999999999');
    assert.equal(result.markets[0]?.totalUSD, '0.05');
    assert.equal(result.markets[1]?.totalUSD, '0.999999999999999999');
  });
});

describe('v1.0.1 audit remediation: shutdown diagnostics', () => {
  it('does not contain silent signer stop catch blocks', () => {
    for (const file of ['src/lib/signer.ts', 'src/commands/daemon.ts']) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /\.stop\(\)\.catch\(\(\) => \{\}\)/, `${file} still silently swallows signer stop errors`);
    }
  });
});

describe('audit 20260527: signer timeout guard', () => {
  it('falls back to default when JUSTLEND_TIMEOUT is non-numeric (NaN guard)', async () => {
    const { resolveSignerTimeout, resetSignerTimeoutWarningForTests } = await import('../src/lib/signer.js');
    const prev = process.env.JUSTLEND_TIMEOUT;
    try {
      resetSignerTimeoutWarningForTests();
      process.env.JUSTLEND_TIMEOUT = '5s';
      assert.equal(resolveSignerTimeout(), 300_000);
      process.env.JUSTLEND_TIMEOUT = '-1';
      assert.equal(resolveSignerTimeout(), 300_000);
      process.env.JUSTLEND_TIMEOUT = '0';
      assert.equal(resolveSignerTimeout(), 300_000);
    } finally {
      if (prev === undefined) delete process.env.JUSTLEND_TIMEOUT;
      else process.env.JUSTLEND_TIMEOUT = prev;
    }
  });

  it('honors a valid positive integer JUSTLEND_TIMEOUT', async () => {
    const { resolveSignerTimeout } = await import('../src/lib/signer.js');
    const prev = process.env.JUSTLEND_TIMEOUT;
    try {
      process.env.JUSTLEND_TIMEOUT = '60000';
      assert.equal(resolveSignerTimeout(), 60_000);
    } finally {
      if (prev === undefined) delete process.env.JUSTLEND_TIMEOUT;
      else process.env.JUSTLEND_TIMEOUT = prev;
    }
  });

  it('no longer reads Number(process.env.JUSTLEND_TIMEOUT) directly in signer call sites', () => {
    for (const file of ['src/lib/tx.ts', 'src/commands/daemon.ts']) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        source,
        /Number\(process\.env\.JUSTLEND_TIMEOUT/,
        `${file} still uses raw Number(process.env.JUSTLEND_TIMEOUT); should call resolveSignerTimeout()`,
      );
    }
  });
});

describe('audit 20260527: TRC20 decimals range validation', () => {
  it('rejects an override outside [0, 38]', async () => {
    const { resolveTrc20Decimals } = await import('../src/lib/tokens.js');
    await assert.rejects(() => resolveTrc20Decimals('nile', 'TX', '100'), /between 0 and 38/);
    await assert.rejects(() => resolveTrc20Decimals('nile', 'TX', '-1'), /between 0 and 38/);
    await assert.rejects(() => resolveTrc20Decimals('nile', 'TX', 'foo'), /between 0 and 38/);
  });

  it('accepts an in-range override without hitting the network', async () => {
    const { resolveTrc20Decimals } = await import('../src/lib/tokens.js');
    assert.equal(await resolveTrc20Decimals('nile', 'TX', '6'), 6);
    assert.equal(await resolveTrc20Decimals('nile', 'TX', '18'), 18);
    assert.equal(await resolveTrc20Decimals('nile', 'TX', 0), 0);
  });

  it('removes the bare Number(decimals().call()) pattern in approve.ts', () => {
    const source = readFileSync('src/commands/approve.ts', 'utf8');
    assert.doesNotMatch(
      source,
      /Number\(await[^)]*\.decimals\(\)\.call\(\)\)/,
      'approve.ts should call resolveTrc20Decimals instead of unwrapping decimals() with Number()',
    );
  });
});

describe('audit 20260527: HTTP retry for idempotent reads', () => {
  it('exposes an idempotent flag in HttpRequestContext', async () => {
    const httpSource = readFileSync('src/lib/http.ts', 'utf8');
    assert.match(httpSource, /idempotent\?: boolean/);
    assert.match(httpSource, /isRetriableError/);
  });

  it('marks V1 markets + rewards lookups as idempotent', () => {
    assert.match(readFileSync('src/lib/api/v1.ts', 'utf8'), /idempotent:\s*true/);
    assert.match(readFileSync('src/commands/rewards.ts', 'utf8'), /idempotent:\s*true/);
  });
});

describe('audit 20260527: local broadcast trust message', () => {
  it('error message states no env opt-out is honored', () => {
    const source = readFileSync('src/lib/tx.ts', 'utf8');
    assert.match(source, /does NOT honor JUSTLEND_ALLOW_UNTRUSTED_HOSTS/);
  });
});

describe('audit 20260527: rewards loose equality', () => {
  it('uses Number(miningStatus) === 3, not loose ==', () => {
    const source = readFileSync('src/commands/rewards.ts', 'utf8');
    assert.doesNotMatch(source, /item\.miningStatus == 3/);
    assert.match(source, /Number\(item\.miningStatus\) === 3/);
  });
});

describe('audit 20260527: tx polling jitter', () => {
  it('waitForTxResult adds jitter to its setTimeout poll', () => {
    const source = readFileSync('src/lib/tronweb.ts', 'utf8');
    assert.match(source, /3_000\s*\+\s*Math\.floor\(Math\.random\(\)\s*\*\s*500\)/);
  });
});

describe('backport from tronlink-cli: socket chmod hardening', () => {
  it('startIPCServer is async and returns a Promise<net.Server>', () => {
    const source = readFileSync('src/lib/ipc.ts', 'utf8');
    assert.match(source, /export function startIPCServer\(expectedToken: string, handler: RequestHandler\): Promise<net\.Server>/);
    assert.match(source, /return new Promise\(\(resolve, reject\) => \{/);
  });

  it('no longer swallows the socket chmod failure', () => {
    const source = readFileSync('src/lib/ipc.ts', 'utf8');
    // The old best-effort swallow on the signing socket must be gone...
    assert.doesNotMatch(
      source,
      /fs\.chmodSync\(SOCKET_PATH, 0o600\); \} catch \{ \/\* best effort \*\/ \}/,
      'ipc.ts still silently swallows the socket chmod failure',
    );
    // ...replaced by an abort path that unlinks the socket and rejects.
    assert.match(source, /fs\.chmodSync\(SOCKET_PATH, 0o600\);\s*\n\s*\} catch \(err\) \{/);
    assert.match(source, /reject\(err instanceof Error \? err : new Error\(String\(err\)\)\);/);
  });

  it('daemon awaits the now-async startIPCServer', () => {
    const source = readFileSync('src/commands/daemon.ts', 'utf8');
    assert.match(source, /const ipcToken = writeServeState\(port\)/);
    assert.match(source, /await startIPCServer\(ipcToken,/);
  });

  it('authenticates against the daemon-memory token instead of re-reading serve.json', () => {
    const source = readFileSync('src/lib/ipc.ts', 'utf8');
    assert.match(source, /validateIPCRequest\(msg, expectedToken\)/);
    assert.doesNotMatch(source, /validateIPCRequest\(msg, readServeState\(\)\?\.token\)/);
  });
});

describe('backport from tronlink-cli: serve idle auto-shutdown', () => {
  it('exposes an --idle-timeout option defaulting to 10 minutes', () => {
    const source = readFileSync('src/commands/daemon.ts', 'utf8');
    assert.match(source, /\.option\('--idle-timeout <minutes>'/);
    assert.match(source, /'Auto-shut down after this many idle minutes \(0 disables\)', '10'/);
  });

  it('falls back to the 10-minute default on NaN/negative input', () => {
    const source = readFileSync('src/commands/daemon.ts', 'utf8');
    assert.match(source, /Number\.isFinite\(idleParsed\) && idleParsed >= 0 \? idleParsed : 10/);
  });

  it('never shuts down while a request is in flight', () => {
    const source = readFileSync('src/commands/daemon.ts', 'utf8');
    assert.match(source, /if \(inFlightRequests > 0\) return;/);
    assert.match(source, /Date\.now\(\) - lastActivityAt < IDLE_TIMEOUT_MS/);
  });
});

describe('backport from tronlink-cli: signer version bump', () => {
  it('pins tronlink-signer to 0.1.4 (exact, no caret)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    assert.equal(pkg.dependencies['tronlink-signer'], '0.1.4');
  });
});

describe('audit 20260819: local signer state and sensitive API transport', () => {
  it('hardens the signer state directory before asynchronous startup and atomically replaces state', () => {
    const source = readFileSync('src/lib/ipc.ts', 'utf8');
    assert.match(source, /function ensureServeDir\(\): void/);
    assert.match(source, /fs\.mkdirSync\(SERVE_DIR, \{ recursive: true, mode: 0o700 \}\)/);
    assert.match(source, /fs\.openSync\(tempPath, 'wx', 0o600\)/);
    assert.match(source, /fs\.renameSync\(tempPath, SERVE_STATE_FILE\)/);
    assert.doesNotMatch(source, /fs\.writeFileSync\(SERVE_STATE_FILE,/);
  });

  it('rejects automatic redirects for energy purchase requests', () => {
    const source = readFileSync('src/lib/energy-purchase.ts', 'utf8');
    assert.match(source, /redirect: 'error'/);
  });

  it('rejects automatic redirects in the shared HTTP helper by default', () => {
    const source = readFileSync('src/lib/http.ts', 'utf8');
    assert.match(source, /redirect: init\?\.redirect \?\? 'error'/);
    assert.ok((source.match(/redirect: init(?:\?\.|\.)redirect \?\? 'error'/g) ?? []).length >= 3);
  });

  it('passes redirect=error to fetch while preserving an explicit safer policy', async () => {
    const { fetchWithTimeout } = await import('../src/lib/http.js');
    const originalFetch = globalThis.fetch;
    const redirects: Array<RequestRedirect | undefined> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await fetchWithTimeout('https://api.justlend.org/health');
      await fetchWithTimeout(
        'https://api.justlend.org/health',
        { redirect: 'manual', signal: new AbortController().signal },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(redirects, ['error', 'manual']);
  });

  it('fails closed on Moolah token-decimals errors instead of signing with 6', () => {
    const source = readFileSync('src/lib/moolah.ts', 'utf8');
    assert.match(source, /return resolveTrc20Decimals\(network, token\)/);
    assert.doesNotMatch(source, /using fallback decimals|return fallback/);
    assert.match(source, /refusing to guess decimals/);
  });
});
