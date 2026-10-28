import { Command } from 'commander';
import { COMPTROLLER_ABI } from '../lib/abis.js';
import { fetchMoolahJson } from '../lib/api/v2.js';
import { JUSTLEND_ADDRESSES, getApiHost } from '../lib/chains.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { fetchWithContext } from '../lib/http.js';
import { outputResult } from '../lib/output.js';
import { sendContractTx } from '../lib/tx.js';
import { validateAddress } from '../lib/tronweb.js';
import type { TronNetwork } from '../lib/types.js';
import { utils } from '../lib/utils.js';

interface MiningRewardItem {
  symbol: string;
  amountNew: string;
  amountLast: string;
  totalAmount: string;
  price: string;
  valueUSD: string;
}

interface MarketMiningRow {
  jTokenAddress: string;
  marketSymbol: string;
  gainNewUSD: string;
  gainLastUSD: string;
  totalUSD: string;
  miningStatus: number;
  currEndTime: string;
  lastEndTime: string;
  breakdown: Record<string, MiningRewardItem>;
}

interface V1MiningRewardsSummary {
  totalGainNewUSD: string;
  totalGainLastUSD: string;
  totalUnclaimedUSD: string;
  markets: MarketMiningRow[];
}

async function fetchV1MiningRewards(address: string, network: TronNetwork): Promise<V1MiningRewardsSummary | { status: 'unavailable'; error: string }> {
  const host = getApiHost(network);
  const url = `${host}/justlend/account?addr=${encodeURIComponent(address)}`;
  try {
    const res = await fetchWithContext(url, {
      code: 'V1_REWARDS_FETCH_FAILED',
      module: 'rewards.summary',
      network,
      idempotent: true,
      hint: `${network} JustLend account backend may be unavailable; retry shortly.`,
    });
    const body = await res.json() as { code?: number; data?: { assetList?: any[] }; message?: string };
    if (![0, 200, '0', '200'].includes(body.code as any) || !Array.isArray(body.data?.assetList)) {
      return { status: 'unavailable', error: 'Invalid V1 rewards API response; reward/activity state is unknown.' };
    }
    const assetList = body.data.assetList;
    return calculateV1MiningRewards(assetList);
  } catch (err) {
    return { status: 'unavailable', error: err instanceof Error ? err.message : String(err) };
  }
}

const REWARD_USD_SCALE = 18;

function decimalToScaled(value: unknown, scale: number): bigint {
  const text = String(value ?? '0').trim();
  if (text === '') return 0n;
  return utils.parseUnits(text, scale);
}

function formatScaledDecimal(raw: bigint, scale: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(scale);
  const integer = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  const body = fraction ? `${integer}.${fraction}` : integer.toString();
  return negative ? `-${body}` : body;
}

function multiplyDecimals(a: unknown, b: unknown, scale = REWARD_USD_SCALE): bigint {
  return (decimalToScaled(a, scale) * decimalToScaled(b, scale)) / (10n ** BigInt(scale));
}

function addDecimalStrings(a: string, b: string, scale = REWARD_USD_SCALE): string {
  return formatScaledDecimal(decimalToScaled(a, scale) + decimalToScaled(b, scale), scale);
}

function calculateV1MiningRewards(assetList: any[]): V1MiningRewardsSummary {
  let totalGainNewUSD = 0n;
  let totalGainLastUSD = 0n;
  const markets: MarketMiningRow[] = [];
  for (const asset of assetList) {
    if (!asset?.miningInfo) continue;
    const row: MarketMiningRow = {
      jTokenAddress: asset.jtokenAddress ?? '',
      marketSymbol: asset.collateralSymbol ?? '',
      gainNewUSD: '0',
      gainLastUSD: '0',
      totalUSD: '0',
      breakdown: {},
      miningStatus: 1,
      currEndTime: '',
      lastEndTime: '',
    };
    let marketGainNew = 0n;
    let marketGainLast = 0n;
    for (const key of Object.keys(asset.miningInfo)) {
      const item = asset.miningInfo[key];
      if (!item || typeof item !== 'object') continue;
      const symbol = key.replace('NEW', '');
      if (symbol === 'NFT') continue;
      const price = String(item.price ?? '0');
      const gainNew = String(item.gainNew ?? '0');
      const gainLast = Number(item.miningStatus) === 3 ? '0' : String(item.gainLast ?? '0');
      const gainNewUSD = multiplyDecimals(gainNew, price);
      const gainLastUSD = multiplyDecimals(gainLast, price);
      if (gainNewUSD === 0n && gainLastUSD === 0n) continue;
      marketGainNew += gainNewUSD;
      marketGainLast += gainLastUSD;
      row.breakdown[symbol] = {
        symbol,
        amountNew: gainNew,
        amountLast: gainLast,
        totalAmount: addDecimalStrings(gainNew, gainLast),
        price,
        valueUSD: formatScaledDecimal(gainNewUSD + gainLastUSD, REWARD_USD_SCALE),
      };
      if (key === 'USDDNEW' || !row.currEndTime) {
        row.miningStatus = Number(item.miningStatus ?? 1);
        row.currEndTime = item.currEndTime ?? '';
        row.lastEndTime = item.lastEndTime ?? '';
      }
    }
    row.gainNewUSD = formatScaledDecimal(marketGainNew, REWARD_USD_SCALE);
    row.gainLastUSD = formatScaledDecimal(marketGainLast, REWARD_USD_SCALE);
    row.totalUSD = formatScaledDecimal(marketGainNew + marketGainLast, REWARD_USD_SCALE);
    totalGainNewUSD += marketGainNew;
    totalGainLastUSD += marketGainLast;
    if (marketGainNew > 0n || marketGainLast > 0n) markets.push(row);
  }
  return {
    totalGainNewUSD: formatScaledDecimal(totalGainNewUSD, REWARD_USD_SCALE),
    totalGainLastUSD: formatScaledDecimal(totalGainLastUSD, REWARD_USD_SCALE),
    totalUnclaimedUSD: formatScaledDecimal(totalGainNewUSD + totalGainLastUSD, REWARD_USD_SCALE),
    markets,
  };
}

export const calculateV1MiningRewardsForTest = calculateV1MiningRewards;

export function registerRewardsCommand(program: Command): void {
  const rewards = program
    .command('rewards')
    .description('V1 mining rewards (per-market live API data) + V2 airdrop summary');

  rewards
    .command('summary <address>')
    .description('Show V1 mining + V2 airdrop claimable summary (read-only, aggregates per-market gainNew/gainLast)')
    .action(async function (this: Command, address: string) {
      validateAddress(address);
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const v1 = await fetchV1MiningRewards(address, network);
      let v2: unknown;
      if (network === 'mainnet') {
        v2 = await fetchMoolahJson<unknown>(network, '/rewards/claimable', { address }).catch(async firstError =>
          fetchMoolahJson<unknown>(network, '/airdrop/claimable', { address }).catch(secondError => ({
            status: 'unavailable',
            rewardsError: firstError instanceof Error ? firstError.message : String(firstError),
            airdropError: secondError instanceof Error ? secondError.message : String(secondError),
          })),
        );
      } else {
        v2 = { status: 'skipped', reason: 'V2 rewards backend is mainnet-only' };
      }
      outputResult({ address, network, v1, v2 }, 'Claimable Rewards', Boolean(opts.json));
    });

  rewards
    .command('claim')
    .description('Claim V1 mining rewards for the connected wallet (Comptroller.claimReward; one tx covers all V1 markets)')
    .action(async function (this: Command) {
      const network = getNetworkFromCommand(this);
      await sendContractTx({
        command: this,
        contractAddress: JUSTLEND_ADDRESSES[network].comptroller,
        abi: COMPTROLLER_ABI,
        functionName: 'claimReward',
        args: ['__WALLET__'],
        preview: { action: 'claim V1 mining rewards (all markets)' },
      });
    });
}
