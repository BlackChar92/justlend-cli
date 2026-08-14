import { Command } from 'commander';
import { ENERGY_MARKET_ABI } from '../lib/abis.js';
import { JUSTLEND_ADDRESSES } from '../lib/chains.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { outputResult } from '../lib/output.js';
import { sendContractTx } from '../lib/tx.js';
import { getTronWeb, validateAddress } from '../lib/tronweb.js';
import { utils } from '../lib/utils.js';
import { optionalRead, warningFields } from '../lib/optional-read.js';
import { EnergyPurchaseClient } from '../lib/energy-purchase.js';
import { initSigner, resolveSignerTimeout, shutdownSigner } from '../lib/signer.js';
import { confirmProceed, outputAction, outputInfo, outputList } from '../lib/output.js';
import { parsePositiveInteger } from '../lib/command-utils.js';

const ENERGY_RESOURCE_TYPE = '1';

function formatSun(value: unknown): string {
  return utils.formatUnits(BigInt(value?.toString?.() ?? String(value ?? 0)), 6);
}

export function registerEnergyCommands(program: Command): void {
  const energy = program.command('energy').description('Energy rental commands');

  energy.command('info').description('Show energy rental market overview').action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const contract = getTronWeb(network).contract(ENERGY_MARKET_ABI as any, cfg.strx.market) as any;
    const warningSink = { warnings: [] as string[] };
    const [totalDelegated, totalFrozen, maxRentable, threshold, feeRatio, minFee, paused, usageChargeRatio, stableRate] = await Promise.all([
      contract.methods.totalDelegatedOfType(ENERGY_RESOURCE_TYPE).call(),
      contract.methods.totalFrozenOfType(ENERGY_RESOURCE_TYPE).call(),
      contract.methods.maxRentableOfType(ENERGY_RESOURCE_TYPE).call(),
      optionalRead('energy.liquidateThreshold', warningSink, () => contract.methods.liquidateThreshold().call()),
      optionalRead('energy.feeRatio', warningSink, () => contract.methods.feeRatio().call()),
      optionalRead('energy.minFee', warningSink, () => contract.methods.minFee().call()),
      optionalRead(`energy.rentPaused(${ENERGY_RESOURCE_TYPE})`, warningSink, () => contract.methods.rentPaused(ENERGY_RESOURCE_TYPE).call()),
      optionalRead('energy.usageChargeRatio', warningSink, () => contract.methods.usageChargeRatio().call()),
      optionalRead(`energy._stableRate(${ENERGY_RESOURCE_TYPE})`, warningSink, () => contract.methods._stableRate(ENERGY_RESOURCE_TYPE).call()),
    ]);
    outputResult({
      network,
      market: cfg.strx.market,
      totalDelegatedEnergy: totalDelegated.toString(),
      totalFrozenTRX: formatSun(totalFrozen),
      maxRentableEnergy: maxRentable.toString(),
      stableRate: stableRate?.toString?.(),
      liquidateThreshold: threshold?.toString?.(),
      feeRatio: feeRatio?.toString?.(),
      minFeeTRX: minFee === undefined ? undefined : formatSun(minFee),
      usageChargeRatio: usageChargeRatio?.toString?.(),
      rentPaused: paused?.toString?.(),
      ...warningFields(warningSink),
    }, 'Energy Rental Overview', Boolean(opts.json));
  });

  energy.command('orders <address>').description('Show user energy rental order summary').action(async function (this: Command, address: string) {
    validateAddress(address);
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const contract = getTronWeb(network).contract(ENERGY_MARKET_ABI as any, cfg.strx.market) as any;
    const warningSink = { warnings: [] as string[] };
    const [rentInfo, rentBalance] = await Promise.all([
      contract.methods.getRentInfo(address, address, ENERGY_RESOURCE_TYPE).call(),
      optionalRead(`energy.rentals(${address}, ${ENERGY_RESOURCE_TYPE})`, warningSink, () => contract.methods.rentals(address, address, ENERGY_RESOURCE_TYPE).call()),
    ]);
    outputResult({
      address,
      network,
      market: cfg.strx.market,
      securityDepositTRX: formatSun(rentInfo?.securityDeposit ?? rentInfo?.[0] ?? 0),
      orderIndex: (rentInfo?.index ?? rentInfo?.[1])?.toString?.(),
      rentBalance: rentBalance?.toString?.(),
      ...warningFields(warningSink),
      note: 'On-chain read uses renter=receiver=address; delegated-to-other orders require receiver-specific lookup or backend API.',
    }, 'Energy Rental Orders', Boolean(opts.json));
  });

  energy.command('estimate <amount>').description('Estimate rental rate for amount of energy').action(async function (this: Command, amount: string) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const contract = getTronWeb(network).contract(ENERGY_MARKET_ABI as any, cfg.strx.market) as any;
    const rate = await contract.methods._rentalRate(amount, ENERGY_RESOURCE_TYPE).call();
    outputResult({ network, energy: amount, rentalRateRaw: rate.toString(), market: cfg.strx.market }, 'Energy Rental Estimate', Boolean(opts.json));
  });

  energy.command('rent <amount>')
    .description('Create energy rental order. <amount> is the stake TRX (in TRX units, not sun)')
    .requiredOption('--receiver <address>', 'Energy receiver address')
    .option('--prepayment <trx>', 'Initial prepayment TRX, defaults to <amount> for self-mirroring rentals')
    .action(async function (this: Command, amount: string) {
      const localOpts = this.opts();
      const receiver = localOpts.receiver;
      const network = getNetworkFromCommand(this);
      const cfg = JUSTLEND_ADDRESSES[network];
      validateAddress(receiver);
      const stakeAmount = utils.toSun(amount);
      const prepayment = localOpts.prepayment ? utils.toSun(localOpts.prepayment) : stakeAmount;
      await sendContractTx({
        command: this,
        contractAddress: cfg.strx.market,
        abi: ENERGY_MARKET_ABI,
        functionName: 'rentResource',
        args: [receiver, stakeAmount.toString(), ENERGY_RESOURCE_TYPE],
        callValue: prepayment,
        preview: {
          action: 'rent energy',
          stakeTRX: amount,
          prepaymentTRX: localOpts.prepayment ?? amount,
          receiver,
        },
      });
    });

  energy.command('renew <receiver>')
    .description('Add prepayment to an existing rental for <receiver> (extends duration; stakeAmount=0 keeps existing stake)')
    .requiredOption('--prepayment <trx>', 'Additional TRX prepayment to add')
    .action(async function (this: Command, receiver: string) {
      validateAddress(receiver, 'receiver');
      const network = getNetworkFromCommand(this);
      const cfg = JUSTLEND_ADDRESSES[network];
      const prepayment = utils.toSun(this.opts().prepayment);
      // Contract treats rentResource(receiver, 0, 1) with non-zero callValue as adding deposit to the
      // existing rental for the (renter, receiver) pair, which is how the JustLend frontend's "renew" works.
      await sendContractTx({
        command: this,
        contractAddress: cfg.strx.market,
        abi: ENERGY_MARKET_ABI,
        functionName: 'rentResource',
        args: [receiver, '0', ENERGY_RESOURCE_TYPE],
        callValue: prepayment,
        preview: {
          action: 'renew energy rental (add prepayment)',
          receiver,
          prepaymentTRX: this.opts().prepayment,
        },
      });
    });

  energy.command('cancel <receiver>')
    .description('Return / cancel an active energy rental (caller is the renter)')
    .option('--stake-amount <trx>', 'Stake TRX to return; defaults to 0 (full exit). Use a positive value for partial unwind')
    .action(async function (this: Command, receiver: string) {
      validateAddress(receiver, 'receiver');
      const network = getNetworkFromCommand(this);
      const cfg = JUSTLEND_ADDRESSES[network];
      const stakeAmountSun = this.opts().stakeAmount ? utils.toSun(this.opts().stakeAmount) : 0n;
      await sendContractTx({
        command: this,
        contractAddress: cfg.strx.market,
        abi: ENERGY_MARKET_ABI,
        functionName: 'returnResource',
        args: [receiver, stakeAmountSun.toString(), ENERGY_RESOURCE_TYPE],
        preview: {
          action: 'return energy rental',
          receiver,
          stakeAmountTRX: this.opts().stakeAmount ?? '0 (full exit)',
        },
      });
    });

  const purchase = energy
    .command('purchase')
    .description('Energy direct-purchase commands (requires an explicitly configured API URL)');

  const makePurchaseClient = (command: Command, withTronWeb = false) => {
    const opts = command.optsWithGlobals();
    const network = getNetworkFromCommand(command);
    return new EnergyPurchaseClient({
      baseUrl: opts.energyApiUrl,
      tronWeb: withTronWeb ? getTronWeb(network) : undefined,
      networkFingerprint: withTronWeb ? network : undefined,
    });
  };

  purchase.command('config')
    .description('Show live energy purchase limits and durations')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const client = makePurchaseClient(this);
      const [config, price, pool] = await Promise.all([
        client.getConfig(),
        client.getCurrentPrice(),
        client.getPoolHealth(),
      ]);
      outputResult({ apiUrl: client.baseUrl, config, price, pool }, 'Energy Purchase Config', Boolean(opts.json));
    });

  purchase.command('quote <energy>')
    .description('Get an authoritative read-only energy purchase quote')
    .requiredOption('-r, --receiver <address...>', 'One or more energy receiver addresses')
    .option('--duration <duration>', 'Duration from live config; defaults to its first advertised value')
    .action(async function (this: Command, energyAmount: string) {
      const opts = this.optsWithGlobals();
      const client = makePurchaseClient(this);
      const config = await client.getConfig();
      const duration = this.opts().duration || config.supported_durations?.[0];
      if (!duration) throw new Error('Energy purchase API returned no supported duration.');
      const quote = await client.quote({
        receivers: this.opts().receiver,
        energyPerReceiver: parsePositiveInteger(energyAmount),
        duration,
        config,
      });
      outputResult(quote, 'Energy Purchase Quote', Boolean(opts.json));
    });

  purchase.command('order <order-id>')
    .description('Get an energy purchase order by id')
    .option('--order-token <token>', 'Optional order access token')
    .action(async function (this: Command, orderId: string) {
      const opts = this.optsWithGlobals();
      const detail = await makePurchaseClient(this).getOrder(orderId, this.opts().orderToken);
      outputResult(detail, 'Energy Purchase Order', Boolean(opts.json));
    });

  purchase.command('risk <address>')
    .description('Reconcile and show unresolved energy payment risks for a payer address')
    .action(async function (this: Command, address: string) {
      const opts = this.optsWithGlobals();
      const risks = await makePurchaseClient(this, true).reconcilePaymentRisks(address);
      const publicRisks = risks.map(risk => ({
        ...(risk.recoveredOrder?.batch && typeof risk.recoveredOrder.batch === 'object'
          ? {
              recoveredOrderId: (risk.recoveredOrder.batch as Record<string, unknown>).id,
              recoveredState: (risk.recoveredOrder.batch as Record<string, unknown>).state,
            }
          : {}),
        payerAddress: risk.payerAddress,
        signedTxId: risk.signedTxId,
        createdAt: risk.createdAt,
        expiresAt: risk.expiresAt,
        paymentConfirmed: risk.paymentConfirmed,
        chainStatus: risk.chainStatus || 'unknown',
        chainExecution: risk.chainExecution || 'unknown',
        networkFingerprint: risk.networkFingerprint,
        replayAvailable: Boolean(risk.signedRequest),
      }));
      outputList(publicRisks, 'Energy Payment Risks', Boolean(opts.json), {
        address,
        blocked: risks.length > 0,
        note: risks.length ? 'Do not create another payment until these transactions are reconciled.' : 'No unresolved payment risk.',
      });
    });

  purchase.command('buy <energy>')
    .description('Buy energy; signs a TRX payment locally and lets the backend broadcast it')
    .requiredOption('-r, --receiver <address...>', 'One or more energy receiver addresses')
    .option('--duration <duration>', 'Duration from live config; defaults to its first advertised value')
    .action(async function (this: Command, energyAmount: string) {
      const opts = this.optsWithGlobals();
      if (opts.broadcast === false) {
        throw new Error('energy purchase does not support --no-broadcast. Use --dry-run or the quote command; real purchases are broadcast only by the backend.');
      }
      const network = getNetworkFromCommand(this);
      const energyPerReceiver = parsePositiveInteger(energyAmount);
      const receivers = this.opts().receiver as string[];
      const tronWeb = getTronWeb(network);
      const client = new EnergyPurchaseClient({ baseUrl: opts.energyApiUrl, tronWeb, networkFingerprint: network });
      const config = await client.getConfig();
      const duration = this.opts().duration || config.supported_durations?.[0];
      if (!duration) throw new Error('Energy purchase API returned no supported duration.');
      const quote = await client.quote({ receivers, energyPerReceiver, duration, config });

      if (opts.dryRun) {
        outputResult({ mode: 'dry-run', ...quote }, 'Energy Purchase Dry Run', Boolean(opts.json));
        return;
      }

      const handle = await initSigner(opts.port);
      try {
        const connected = await handle.call('connect', { network }, resolveSignerTimeout()) as { address: string };
        const balanceSun = BigInt(await tronWeb.trx.getBalance(connected.address));
        if (balanceSun < BigInt(quote.total_sun)) {
          throw new Error(`Insufficient TRX balance: payment requires ${Number(quote.total_sun) / 1e6} TRX before bandwidth cost.`);
        }
        outputAction({
          action: 'buy energy',
          network,
          payer: connected.address,
          receiverAddresses: receivers.join(', '),
          energyPerReceiver,
          duration,
          paymentTRX: Number(quote.total_sun) / 1e6,
          paymentReceiver: quote.payment_address,
          broadcastBy: 'energy purchase backend (the CLI never broadcasts this payment)',
        });
        await confirmProceed(
          `About to sign a ${Number(quote.total_sun) / 1e6} TRX payment from ${connected.address} to ${quote.payment_address} for ${receivers.length} receiver(s). The backend may broadcast it after submission.`,
          Boolean(opts.yes),
        );
        const result = await client.purchase({
          payerAddress: connected.address,
          receivers,
          energyPerReceiver,
          duration,
          expectedAmountSun: quote.total_sun,
          expectedPayAddress: quote.payment_address,
          onState: state => outputInfo(`Energy purchase: ${state}`),
          signTransaction: transaction => handle.call('signTransaction', {
            transaction,
            network,
            broadcast: false,
            confirm: false,
          }, resolveSignerTimeout()),
        });
        outputResult(result, 'Energy Purchase Result', Boolean(opts.json));
      } finally {
        if (!handle.isIPC()) await shutdownSigner();
      }
    });
}
