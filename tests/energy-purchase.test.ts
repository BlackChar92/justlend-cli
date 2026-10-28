import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ENERGY_PURCHASE_API_URL,
  EnergyPurchaseClient,
  EnergyPurchaseError,
  FileEnergyPaymentRiskStore,
  type EnergyPaymentRisk,
  type StorageLike,
} from '../src/lib/energy-purchase.js';
import { createProgram } from '../src/index.js';

const PAYER = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
const SECOND_PAYER = 'TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT';
const RECEIVER = 'TVjsyZ7fYF3qLF6BQgPmTEZy1xrNNyVAAA';
const PAY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TX_ID = 'ab'.repeat(32);
const RAW_HEX = 'cd'.repeat(16);

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: '0', msg: 'ok', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function config() {
  return {
    min_energy: 65000,
    max_energy: 5000000,
    max_batch_receivers: 50,
    supported_durations: ['1h'],
    energy_presets: [65000],
    payment_address: PAY_ADDRESS,
  };
}

class MemoryRiskStore implements StorageLike {
  risks: EnergyPaymentRisk[] = [];
  intents = new Map<string, string>();
  list(payerAddress: string) { return this.risks.filter(risk => risk.payerAddress === payerAddress); }
  save(risk: EnergyPaymentRisk) {
    this.risks = this.risks.filter(item => !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId));
    this.risks.push({ ...risk });
  }
  remove(payerAddress: string, signedTxId?: string) {
    this.risks = this.risks.filter(risk => risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId));
  }
  acquirePurchaseIntent(payerAddress: string) {
    if (this.intents.has(payerAddress)) {
      throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'purchase in progress');
    }
    const token = `intent-${this.intents.size + 1}`;
    this.intents.set(payerAddress, token);
    return token;
  }
  releasePurchaseIntent(payerAddress: string, token: string) {
    if (this.intents.get(payerAddress) !== token) throw new Error('intent owner mismatch');
    this.intents.delete(payerAddress);
  }
}

function harness() {
  const unsigned = { txID: 'unsigned', raw_data: { expiration: 1000, contract: [] }, raw_data_hex: '00', visible: false };
  const extended = { ...unsigned, raw_data: { ...unsigned.raw_data, expiration: 300001 } };
  const tronWeb = {
    fullNode: { host: 'https://api.trongrid.io' },
    utils: { transaction: {
      txJsonToPb: mock.fn((transaction: unknown) => transaction),
      txPbToRawDataHex: mock.fn(() => RAW_HEX),
      txPbToTxID: mock.fn(() => TX_ID),
    } },
    transactionBuilder: {
      sendTrx: mock.fn(async () => unsigned),
      extendExpiration: mock.fn(async () => extended),
    },
    trx: {
      getUnconfirmedTransactionInfo: mock.fn(async () => ({})),
      getTransactionInfo: mock.fn(async () => ({})),
      getTransaction: mock.fn(async () => null),
    },
  };
  const signTransaction = mock.fn(async (transaction: Record<string, unknown>) => ({ ...transaction, signature: ['aa'] }));
  return { tronWeb, signTransaction };
}

describe('energy direct-purchase client', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS = '1';
    delete process.env.JUSTLEND_ENERGY_API_URL;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it('uses the official production API without an untrusted-host opt-in', () => {
    delete process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS;
    const client = new EnergyPurchaseClient({ fetch: mock.fn() });
    assert.equal(client.baseUrl, DEFAULT_ENERGY_PURCHASE_API_URL);
  });

  it('normalizes the app production config and quote contract', async () => {
    delete process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS;
    const fetchImpl = mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope({
        min_energy: 65000,
        max_energy: 5000000,
        max_receivers: 50,
        presets: [65000, 131000],
        durations: ['1h'],
        activation_fee_sun: 1100000,
      });
      if (url.endsWith('/v1/price')) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          receivers: [RECEIVER],
          energy_per_receiver: 65000,
        });
        return envelope({ amount_sun: 2340000, amount_trx: '2.34', pay_address: PAY_ADDRESS, can_fulfill: true });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({ fetch: fetchImpl });
    const liveConfig = await client.getConfig();
    assert.equal(liveConfig.max_batch_receivers, 50);
    assert.deepEqual(liveConfig.energy_presets, [65000, 131000]);
    assert.deepEqual(liveConfig.supported_durations, ['1h']);
    assert.deepEqual(
      await client.quote({ receivers: [RECEIVER], energyPerReceiver: 65000, duration: '1h', config: liveConfig }),
      {
        amount_sun: 2340000,
        amount_trx: '2.34',
        pay_address: PAY_ADDRESS,
        can_fulfill: true,
        total_sun: 2340000,
        total_trx: '2.34',
        payment_address: PAY_ADDRESS,
      },
    );
  });

  it('exposes the nested energy purchase command tree', () => {
    const program = createProgram();
    const energy = program.commands.find(command => command.name() === 'energy');
    const purchase = energy?.commands.find(command => command.name() === 'purchase');
    assert.deepEqual(purchase?.commands.map(command => command.name()), ['config', 'quote', 'order', 'history', 'risk', 'buy']);
  });

  it('blocks the production purchase host on Nile, including the buy path', async () => {
    delete process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS;
    const args = [
      '--network', 'nile', '--dry-run',
      'energy', 'purchase', 'buy', '65000', '--receiver', RECEIVER,
    ];
    await assert.rejects(
      createProgram(args).parseAsync(['node', 'justlend', ...args]),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'CONFIG_MISSING',
    );

    const explicitArgs = [
      '--network', 'nile', '--energy-api-url', DEFAULT_ENERGY_PURCHASE_API_URL, '--dry-run',
      'energy', 'purchase', 'buy', '65000', '--receiver', RECEIVER,
    ];
    await assert.rejects(
      createProgram(explicitArgs).parseAsync(['node', 'justlend', ...explicitArgs]),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'CONFIG_MISSING',
    );
  });

  it('reads public payer history with optional server pagination', async () => {
    const calls: string[] = [];
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example',
      fetch: mock.fn(async (input: string | URL | Request) => {
        calls.push(String(input));
        return envelope({ total: 1, page: 2, size: 10, rows: [{ order_id: '7', payment_tx_id: TX_ID }] });
      }),
    });

    const history = await client.getHistory(PAYER, { page: 2, size: 10 });
    assert.equal(history.total, 1);
    assert.match(calls[0] || '', /orders\/history\?address=/);
    assert.match(calls[0] || '', /page=2/);
    assert.match(calls[0] || '', /size=10/);
  });

  it('validates read-only quotes against live API limits', async () => {
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({ baseUrl: 'https://energy.example', fetch: fetchImpl });

    await assert.rejects(
      client.quote({ receivers: [RECEIVER], energyPerReceiver: 1, duration: '1h' }),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'INVALID_AMOUNT',
    );
    assert.equal(fetchImpl.mock.callCount(), 1);
  });

  it('retries only the same signed payment and never calls a local broadcast method', async () => {
    const { tronWeb, signTransaction } = harness();
    const store = new MemoryRiskStore();
    const submitted: string[] = [];
    let buyCalls = 0;
    const fetchImpl = mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      if (url.endsWith('/v1/price')) {
        return envelope({ total_sun: 2405000, total_trx: '2.405' });
      }
      if (url.endsWith('/v1/consumer/energy/buy')) {
        const submittedRequest = JSON.parse(String(init?.body));
        submitted.push(submittedRequest.signed_transaction.txID);
        assert.equal(submittedRequest.energy_per_receiver, 65000);
        assert.equal(submittedRequest.energy, undefined);
        assert.ok(submittedRequest.signed_transaction.raw_data);
        buyCalls += 1;
        if (buyCalls === 1) throw new Error('connection reset');
        return envelope({ id: '7', access_token: 'token', state: 'paid', tx_id: TX_ID });
      }
      if (url.endsWith('/v1/consumer/energy/orders/7')) return envelope({ id: 7, state: 'delivered' });
      if (url.includes('/v1/consumer/energy/orders/history?')) {
        return envelope({ rows: [{ order_id: '7', payment_tx_id: TX_ID }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example',
      fetch: fetchImpl,
      tronWeb: tronWeb as any,
      storage: store,
      sleep: async () => {},
      now: () => 1,
    });

    const result = await client.purchase({
      payerAddress: PAYER,
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: '1h',
      expectedAmountSun: 2405000,
      expectedPayAddress: PAY_ADDRESS,
      signTransaction,
    });

    assert.deepEqual(submitted, [TX_ID, TX_ID]);
    assert.equal(signTransaction.mock.callCount(), 1);
    assert.equal((result as any).state, 'delivered');
    assert.deepEqual(store.risks, []);
    assert.equal('sendRawTransaction' in tronWeb.trx, false);
  });

  it('returns tokenless idempotent orders without polling and retains risk until history confirms them', async () => {
    const { tronWeb, signTransaction } = harness();
    const store = new MemoryRiskStore();
    let historyVisible = false;
    let orderPollCalls = 0;
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      if (url.endsWith('/v1/price')) return envelope({ total_sun: 2405000, total_trx: '2.405' });
      if (url.endsWith('/v1/consumer/energy/buy')) {
        return envelope({ batch: { id: '9', access_token: null, state: 'paid' }, payment: { tx_hash: TX_ID } });
      }
      if (url.includes('/v1/consumer/energy/orders/history?')) {
        return envelope({ rows: historyVisible ? [{ order_id: '9', payment_tx_id: TX_ID }] : [] });
      }
      if (url.includes('/v1/consumer/energy/orders/9')) {
        orderPollCalls += 1;
        return envelope({ id: 9, state: 'delivered' });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example',
      fetch: fetchImpl,
      tronWeb: tronWeb as any,
      storage: store,
      sleep: async () => {},
      now: () => 1,
      networkFingerprint: 'mainnet-provider',
    });

    const result = await client.purchase({
      payerAddress: PAYER,
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: '1h',
      expectedAmountSun: 2405000,
      expectedPayAddress: PAY_ADDRESS,
      signTransaction,
    });

    assert.equal((result as any).state, 'paid');
    assert.equal((result as any).detail, null);
    assert.equal((result as any).reconciliationRequired, true);
    assert.equal(orderPollCalls, 0);
    assert.equal(store.risks.length, 1);
    assert.equal(store.risks[0]?.paymentConfirmed, true);

    historyVisible = true;
    assert.deepEqual(await client.reconcilePaymentRisks(PAYER), []);
  });

  it('rejects a concurrent purchase for the same payer before a second signature', async () => {
    const { tronWeb, signTransaction } = harness();
    const store = new MemoryRiskStore();
    let releaseConfig!: () => void;
    let markConfigStarted!: () => void;
    const configStarted = new Promise<void>(resolve => { markConfigStarted = resolve; });
    const configGate = new Promise<void>(resolve => { releaseConfig = resolve; });
    let buyCalls = 0;
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) {
        markConfigStarted();
        await configGate;
        return envelope(config());
      }
      if (url.endsWith('/v1/price')) {
        return envelope({ total_sun: 2405000, total_trx: '2.405' });
      }
      if (url.endsWith('/v1/consumer/energy/buy')) {
        buyCalls += 1;
        return envelope({ batch: { id: '8', access_token: 'token', state: 'paid' }, payment: { tx_hash: TX_ID } });
      }
      if (url.endsWith('/v1/consumer/energy/orders/8')) return envelope({ id: 8, state: 'delivered' });
      throw new Error(`unexpected ${url}`);
    });
    const options = {
      baseUrl: 'https://energy.example',
      fetch: fetchImpl,
      tronWeb: tronWeb as any,
      storage: store,
      sleep: async () => {},
      now: () => 1,
    };
    const firstClient = new EnergyPurchaseClient(options);
    const secondClient = new EnergyPurchaseClient(options);
    const input = {
      payerAddress: PAYER,
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: '1h',
      expectedAmountSun: 2405000,
      expectedPayAddress: PAY_ADDRESS,
      signTransaction,
    };

    const firstPurchase = firstClient.purchase(input);
    await configStarted;
    await assert.rejects(
      secondClient.purchase(input),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'PAYMENT_IN_PROGRESS',
    );
    releaseConfig();
    await firstPurchase;

    assert.equal(signTransaction.mock.callCount(), 1);
    assert.equal(buyCalls, 1);
  });

  it('uses an atomic file intent to block a second process before signing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justlend-cli-energy-lock-'));
    try {
      const riskFile = path.join(directory, 'risks.json');
      const firstStore = new FileEnergyPaymentRiskStore(riskFile);
      const secondStore = new FileEnergyPaymentRiskStore(riskFile);
      const firstToken = firstStore.acquirePurchaseIntent(PAYER, 100, 1000);

      assert.throws(
        () => secondStore.acquirePurchaseIntent(PAYER, 101, 1001),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'PAYMENT_IN_PROGRESS',
      );

      firstStore.releasePurchaseIntent(PAYER, firstToken);
      const secondToken = secondStore.acquirePurchaseIntent(PAYER, 102, 1002);
      secondStore.releasePurchaseIntent(PAYER, secondToken);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a recovered intent owned when an expired owner releases concurrently', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justlend-cli-stale-intent-'));
    try {
      const riskFile = path.join(directory, 'risks.json');
      const oldStore = new FileEnergyPaymentRiskStore(riskFile) as unknown as {
        acquirePurchaseIntent(payerAddress: string, createdAt: number, expiresAt: number): string;
        releasePurchaseIntent(payerAddress: string, token: string): void;
        readIntent(lockPath: string): unknown;
      };
      const recoveredStore = new FileEnergyPaymentRiskStore(riskFile);
      const thirdStore = new FileEnergyPaymentRiskStore(riskFile);
      const oldToken = oldStore.acquirePurchaseIntent(PAYER, 100, 200);
      const originalReadIntent = oldStore.readIntent.bind(oldStore);
      let attemptedRecovery = false;

      oldStore.readIntent = (lockPath: string) => {
        const snapshot = originalReadIntent(lockPath);
        if (attemptedRecovery) return snapshot;
        attemptedRecovery = true;
        const originalNow = Date.now;
        let nowCalls = 0;
        Date.now = (() => (nowCalls++ === 0 ? 0 : 2_001)) as typeof Date.now;
        try {
          assert.throws(
            () => recoveredStore.acquirePurchaseIntent(PAYER, 300, 1000),
            (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_BUSY',
          );
        } finally {
          Date.now = originalNow;
        }
        return snapshot;
      };

      oldStore.releasePurchaseIntent(PAYER, oldToken);
      const recoveredToken = recoveredStore.acquirePurchaseIntent(PAYER, 300, 1000);
      assert.throws(
        () => thirdStore.acquirePurchaseIntent(PAYER, 301, 1001),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'PAYMENT_IN_PROGRESS',
      );
      recoveredStore.releasePurchaseIntent(PAYER, recoveredToken);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serializes stale recovery with signed-risk finalization', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justlend-cli-finalize-intent-'));
    try {
      const riskFile = path.join(directory, 'risks.json');
      const oldStore = new FileEnergyPaymentRiskStore(riskFile) as unknown as {
        acquirePurchaseIntent(payerAddress: string, createdAt: number, expiresAt: number): string;
        finalizePurchaseIntent(payerAddress: string, token: string, risk: EnergyPaymentRisk): void;
        readIntent(lockPath: string): unknown;
      };
      const recoveredStore = new FileEnergyPaymentRiskStore(riskFile);
      const oldToken = oldStore.acquirePurchaseIntent(PAYER, 100, 200);
      const originalReadIntent = oldStore.readIntent.bind(oldStore);
      let attemptedRecovery = false;

      oldStore.readIntent = (lockPath: string) => {
        const snapshot = originalReadIntent(lockPath);
        if (attemptedRecovery) return snapshot;
        attemptedRecovery = true;
        const originalNow = Date.now;
        let nowCalls = 0;
        Date.now = (() => (nowCalls++ === 0 ? 0 : 2_001)) as typeof Date.now;
        try {
          assert.throws(
            () => recoveredStore.acquirePurchaseIntent(PAYER, 300, 1000),
            (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_BUSY',
          );
        } finally {
          Date.now = originalNow;
        }
        return snapshot;
      };

      const risk: EnergyPaymentRisk = {
        payerAddress: PAYER,
        signedTxId: 'finalized',
        createdAt: 200,
        expiresAt: 1000,
        paymentConfirmed: false,
      };
      oldStore.finalizePurchaseIntent(PAYER, oldToken, risk);
      assert.deepEqual(recoveredStore.list(PAYER), [risk]);
      const recoveredToken = recoveredStore.acquirePurchaseIntent(PAYER, 300, 1000);
      recoveredStore.releasePurchaseIntent(PAYER, recoveredToken);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serializes shared risk-file mutations across payer stores', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justlend-cli-risk-lock-'));
    try {
      const riskFile = path.join(directory, 'risks.json');
      const firstStore = new FileEnergyPaymentRiskStore(riskFile);
      const secondStore = new FileEnergyPaymentRiskStore(riskFile);
      const firstRisk: EnergyPaymentRisk = {
        payerAddress: PAYER,
        signedTxId: 'first',
        createdAt: 1,
        expiresAt: 2,
        paymentConfirmed: false,
      };
      const secondRisk: EnergyPaymentRisk = {
        payerAddress: SECOND_PAYER,
        signedTxId: 'second',
        createdAt: 1,
        expiresAt: 2,
        paymentConfirmed: false,
      };
      const firstInternals = firstStore as unknown as {
        writeAll(risks: EnergyPaymentRisk[]): void;
      };
      const writeAll = firstInternals.writeAll.bind(firstStore);
      firstInternals.writeAll = (risks) => {
        assert.throws(
          () => secondStore.save(secondRisk),
          (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_BUSY',
        );
        writeAll(risks);
      };

      firstStore.save(firstRisk);
      secondStore.save(secondRisk);
      assert.deepEqual(firstStore.list(PAYER), [firstRisk]);
      assert.deepEqual(firstStore.list(SECOND_PAYER), [secondRisk]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed without overwriting a corrupt payment-risk file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justlend-cli-energy-risk-'));
    try {
      const riskFile = path.join(directory, 'risks.json');
      fs.writeFileSync(riskFile, '{not-json', { mode: 0o600 });
      const store = new FileEnergyPaymentRiskStore(riskFile);

      assert.throws(
        () => store.list(PAYER),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_ERROR',
      );
      assert.throws(
        () => store.save({ payerAddress: PAYER, signedTxId: 'tx', createdAt: 1, expiresAt: 2, paymentConfirmed: false }),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_ERROR',
      );
      assert.equal(fs.readFileSync(riskFile, 'utf8'), '{not-json');

      const invalidSchema = JSON.stringify([{ payerAddress: PAYER, signedTxId: 'tx' }]);
      fs.writeFileSync(riskFile, invalidSchema, { mode: 0o600 });
      assert.throws(
        () => store.list(PAYER),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_ERROR',
      );
      assert.equal(fs.readFileSync(riskFile, 'utf8'), invalidSchema);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects any authoritative quote change before signing', async () => {
    const { tronWeb, signTransaction } = harness();
    let buyCalls = 0;
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      if (url.endsWith('/v1/price')) {
        return envelope({ total_sun: 2404999, total_trx: '2.404999' });
      }
      if (url.endsWith('/v1/consumer/energy/buy')) {
        buyCalls += 1;
        return envelope({});
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example',
      fetch: fetchImpl,
      tronWeb: tronWeb as any,
      storage: new MemoryRiskStore(),
      now: () => 1,
    });

    await assert.rejects(
      client.purchase({
        payerAddress: PAYER,
        receivers: [RECEIVER],
        energyPerReceiver: 65000,
        duration: '1h',
        expectedAmountSun: 2405000,
        expectedPayAddress: PAY_ADDRESS,
        signTransaction,
      }),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'AMOUNT_CHANGED',
    );

    assert.equal(signTransaction.mock.callCount(), 0);
    assert.equal(buyCalls, 0);
  });

  it('treats HTTP 5xx as ambiguous and keeps a replayable risk', async () => {
    const { tronWeb, signTransaction } = harness();
    const store = new MemoryRiskStore();
    let now = 1;
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      if (url.endsWith('/v1/price')) return envelope({ total_sun: 2405000, total_trx: '2.405' });
      if (url.endsWith('/v1/consumer/energy/buy')) {
        now = 999999;
        return new Response(JSON.stringify({ code: 'wallet_rpc_error', msg: 'retry same transaction', data: null }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example', fetch: fetchImpl, tronWeb: tronWeb as any,
      storage: store, sleep: async () => {}, now: () => now, paymentRetryTimeoutMs: 1,
    });

    await assert.rejects(
      client.purchase({
        payerAddress: PAYER, receivers: [RECEIVER], energyPerReceiver: 65000,
        duration: '1h', expectedAmountSun: 2405000, expectedPayAddress: PAY_ADDRESS, signTransaction,
      }),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'PAYMENT_RESULT_UNKNOWN',
    );
    assert.equal(store.risks.length, 1);
    assert.equal(store.risks[0]?.signedRequest?.signed_transaction.txID, TX_ID);
    assert.match(store.risks[0]?.networkFingerprint || '', /api\.trongrid\.io/);
  });

  it('does not reconcile a signed risk through another provider fingerprint', async () => {
    const { tronWeb } = harness();
    const store = new MemoryRiskStore();
    store.risks.push({
      payerAddress: PAYER,
      signedTxId: TX_ID,
      createdAt: 1,
      expiresAt: 2,
      paymentConfirmed: false,
      networkFingerprint: 'api=https://energy.example/;provider=https://wrong.network',
      signedRequest: {
        receivers: [RECEIVER], energy: 65000, duration: '1h', payer_address: PAYER,
        signed_transaction: { txID: TX_ID, raw_data: {}, raw_data_hex: RAW_HEX, signature: ['aa'], visible: false },
      },
    });
    const fetchImpl = mock.fn(async () => { throw new Error('must not use wrong network'); });
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example', fetch: fetchImpl, tronWeb: tronWeb as any, storage: store,
    });
    const risks = await client.reconcilePaymentRisks(PAYER);
    assert.equal(risks.length, 1);
    assert.equal(fetchImpl.mock.callCount(), 0);
  });

  it('records FullNode inclusion before SolidityNode finality', async () => {
    const { tronWeb } = harness();
    let solidified = false;
    tronWeb.trx.getUnconfirmedTransactionInfo = mock.fn(async () => ({
      id: TX_ID,
      blockNumber: 100,
      receipt: { result: 'SUCCESS' },
    }));
    tronWeb.trx.getTransactionInfo = mock.fn(async () => solidified ? {
      id: TX_ID,
      blockNumber: 100,
      receipt: { result: 'SUCCESS' },
    } : {});
    const store = new MemoryRiskStore();
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example',
      networkFingerprint: 'mainnet-provider',
      fetch: mock.fn(async () => new Response(JSON.stringify({
        code: 'wallet_rpc_error',
        msg: 'retry the same transaction',
        data: null,
      }), { status: 502, headers: { 'content-type': 'application/json' } })),
      tronWeb: tronWeb as any,
      storage: store,
    });
    store.risks.push({
      payerAddress: PAYER,
      signedTxId: TX_ID,
      createdAt: 1,
      expiresAt: 300001,
      paymentConfirmed: false,
      chainStatus: 'unknown',
      chainExecution: 'unknown',
      networkFingerprint: `api=${client.baseUrl};provider=mainnet-provider`,
      signedRequest: {
        receivers: [RECEIVER], energy: 65000, duration: '1h', payer_address: PAYER,
        signed_transaction: { txID: TX_ID, raw_data: {}, raw_data_hex: RAW_HEX, signature: ['aa'], visible: false },
      },
    });

    assert.deepEqual(
      (await client.reconcilePaymentRisks(PAYER)).map(risk => ({
        paymentConfirmed: risk.paymentConfirmed,
        chainStatus: risk.chainStatus,
        chainExecution: risk.chainExecution,
      })),
      [{ paymentConfirmed: false, chainStatus: 'included', chainExecution: 'success' }],
    );

    solidified = true;
    assert.deepEqual(
      (await client.reconcilePaymentRisks(PAYER)).map(risk => ({
        paymentConfirmed: risk.paymentConfirmed,
        chainStatus: risk.chainStatus,
        chainExecution: risk.chainExecution,
      })),
      [{ paymentConfirmed: true, chainStatus: 'solidified', chainExecution: 'success' }],
    );
    assert.equal(tronWeb.trx.getUnconfirmedTransactionInfo.mock.callCount(), 2);
    assert.equal(tronWeb.trx.getTransactionInfo.mock.callCount(), 2);
  });

  it('pins the configured payment address before asking the signer', async () => {
    const { tronWeb, signTransaction } = harness();
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      if (url.endsWith('/v1/price')) return envelope({ total_sun: 2405000, total_trx: '2.405' });
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example', fetch: fetchImpl, tronWeb: tronWeb as any,
      storage: new MemoryRiskStore(),
    });
    await assert.rejects(
      client.purchase({
        payerAddress: PAYER, receivers: [RECEIVER], energyPerReceiver: 65000,
        duration: '1h', expectedAmountSun: 2405000, expectedPayAddress: RECEIVER, signTransaction,
      }),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'PAYMENT_ADDRESS_CHANGED',
    );
    assert.equal(signTransaction.mock.callCount(), 0);
  });
});
