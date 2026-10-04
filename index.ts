import {
  get_erc20_abi,
  get_router_abi,
} from './fetchAbi';
import {
  BASE_WALLET_ADDRESS,
  BASE_WALLET_PRIVATE_KEY,
  TARGET_TOKEN_ADDRESS
} from './constants'
import { ChainId, Wallet } from './types';
import { PONS_MEME_HOOK, PONS_V2_FACTORY, PERMIT2_ROBINHOOD, ROBINHOOD_POOL_FEE, ROBINHOOD_SLIPPAGE_BPS, UNISWAP_V3_FACTORY_ROBINHOOD, UNISWAP_V3_QUOTER_ROBINHOOD, UNIVERSAL_ROUTER_ROBINHOOD, WrappedNative } from './constants';
import { delay, gather, generateWallets, getRandomDelay, getRouterAddress, getRpc, readingWallets, saveWallet, sendEther } from './utils';
import { ethers } from 'ethers'
import fs from "fs";
import { CHAINID, fee, subWalletNum } from './config';

// Uniswap SwapRouter02 (V3) interface fragments needed on Robinhood Chain.
const ROBINHOOD_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
];
const ROBINHOOD_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
const ROBINHOOD_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];
// Standard V3 fee tiers (hundredths of a bip). Pons V1 launches use 10000 (1%).
const V3_FEE_TIERS = [100, 500, 3000, 10000];
// Cache of detected pool fee tiers per token address.
const detectedFees = new Map<string, number>();

// Robinhood Chain V3 fee tier for a token: env override if set, else detect the
// pool that actually exists against the chain's WETH.
async function poolFee(provider: ethers.JsonRpcProvider, tokenAddress: string): Promise<number> {
  if (ROBINHOOD_POOL_FEE > 0) return ROBINHOOD_POOL_FEE;
  const key = tokenAddress.toLowerCase();
  const cached = detectedFees.get(key);
  if (cached !== undefined) return cached;
  const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ROBINHOOD, ROBINHOOD_FACTORY_ABI, provider);
  const weth = WrappedNative[ChainId.Robinhood];
  for (const tier of V3_FEE_TIERS) {
    const pool: string = await factory.getPool(tokenAddress, weth, tier);
    if (pool && pool !== ethers.ZeroAddress && (await provider.getCode(pool)) !== '0x') {
      detectedFees.set(key, tier);
      return tier;
    }
  }
  throw new Error(`No Uniswap V3 pool found for ${tokenAddress} against WETH (tried fee tiers ${V3_FEE_TIERS.join(', ')})`);
}

// Expected output of a V3 swap, read via QuoterV2's eth_call. Used to set
// amountOutMinimum so the swap reverts instead of trading through a drained price.
async function quoteV3(provider: ethers.JsonRpcProvider, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint): Promise<bigint> {
  const quoter = new ethers.Contract(UNISWAP_V3_QUOTER_ROBINHOOD, ROBINHOOD_QUOTER_ABI, provider);
  const [amountOut]: [bigint] = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n });
  if (amountOut <= 0n) throw new Error(`QuoterV2 returned 0 for ${amountIn} ${tokenIn} -> ${tokenOut} (fee ${fee}); the pool may be empty or the token may have fees on transfer.`);
  return amountOut;
}

// Minimum acceptable output for a quoted swap, given the configured slippage bps.
const minOut = (quoted: bigint): bigint => (quoted * BigInt(10000 - ROBINHOOD_SLIPPAGE_BPS)) / 10000n;

// ---------------------------------------------------------------------------
// Pons v2 bonding-curve adapter (pre-graduation launches)
// ---------------------------------------------------------------------------
const PONS_FACTORY_ABI = [
  'function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
];
const PONS_CURVE_ABI = [
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function sellableTokens() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
];

// Pons v2 launch record for a token: which venue it trades on right now.
// - onCurve: pre-graduation bonding curve (buy via curve.buy, sell via curve.sell)
// - graduated: finished curve; trades route through the locked Uniswap v4 pool
// - otherwise null: not a Pons launch (falls through to Uniswap V3)
export type PonsLaunch = {
  token: string; curve: string; pairToken: string; poolFee: number; tickSpacing: number;
  onCurve: boolean; graduated: boolean;
};
export async function ponsLaunchFor(provider: ethers.JsonRpcProvider, tokenAddress: string): Promise<PonsLaunch | null> {
  const factory = new ethers.Contract(PONS_V2_FACTORY, PONS_FACTORY_ABI, provider);
  const launch: { token: string; curve: string; pairToken: string; poolFee: bigint; tickSpacing: bigint; phase: bigint; exists: boolean } = await factory.getLaunchedToken(tokenAddress);
  if (!launch.exists) return null;
  if (launch.pairToken !== ethers.ZeroAddress) throw new Error(`Pons v2 launch ${tokenAddress} is paired against ${launch.pairToken}, not ETH; the bot only supports ETH-paired launches.`);
  const onCurve = launch.phase === 0n;
  if (onCurve) {
    const curve = new ethers.Contract(launch.curve, PONS_CURVE_ABI, provider);
    // Sells close before graduation actually runs; treat ready-to-graduate as
    // closed. Buys close when sellableTokens reaches zero.
    if (await curve.graduated() || await curve.readyToGraduate()) {
      return { token: launch.token, curve: launch.curve, pairToken: launch.pairToken, poolFee: Number(launch.poolFee), tickSpacing: Number(launch.tickSpacing), onCurve: false, graduated: true };
    }
  }
  return { token: launch.token, curve: launch.curve, pairToken: launch.pairToken, poolFee: Number(launch.poolFee), tickSpacing: Number(launch.tickSpacing), onCurve, graduated: !onCurve };
}

// Curve buy: quote the expected tokens from reserves after fees (base fee +
// creator tax + decaying snipe tax, all taken off the input), then enforce a
// minimum at the configured slippage. The curve clamps the final fill, so
// minTokensOut bounds the RATE, not the quantity, per the pons docs.
async function buyPonsCurve(provider: ethers.JsonRpcProvider, signer: ethers.Wallet, curveAddress: string, walletAddress: string, quoteIn: bigint): Promise<ethers.TransactionResponse> {
  const curve = new ethers.Contract(curveAddress, PONS_CURVE_ABI, signer);
  const [reserves, sellableRaw, feeBps, creatorTaxBps, snipeBps] = await Promise.all([
    curve.getReserves(), curve.sellableTokens(), curve.feeBps(), curve.creatorTaxBps(), curve.currentSnipeTaxBps(walletAddress),
  ]);
  const [quoteReserve, tokenReserve] = reserves;
  const sellable = BigInt(sellableRaw);
  if (await curve.readyToGraduate()) throw new Error('Pons curve is sold out (ready to graduate); buys are closed. Trade the post-graduation pool instead.');
  const maxSpend: bigint = sellable * quoteReserve / tokenReserve * 2n;
  if (quoteIn > maxSpend) console.log('Warning: buy is large relative to the curve; it will be clamped to the remaining supply.');
  const bps = 10000n;
  let snipe = snipeBps;
  const maxSnipe = bps - feeBps - creatorTaxBps - 100n; // buyer always nets >= 1% of spend
  if (snipe > maxSnipe) snipe = maxSnipe;
  const net = quoteIn - (quoteIn * feeBps) / bps - (quoteIn * creatorTaxBps) / bps - (quoteIn * snipe) / bps;
  // Constant-product pricing with the phantom quote included in quoteReserve.
  const expected = net * tokenReserve / (quoteReserve + net);
  const minimum = minOut(expected);
  console.log(`Pons curve: spend ${ethers.formatEther(quoteIn)} ETH, expect ~${ethers.formatEther(expected)} tokens, min ${ethers.formatEther(minimum)} (slippage ${ROBINHOOD_SLIPPAGE_BPS / 100}%, fee ${feeBps / 100n}%, creatorTax ${creatorTaxBps / 100n}%, snipeTax ${snipe / 100n}%)`);
  return curve.buy(quoteIn, minimum, walletAddress, { value: quoteIn });
}

// Curve sell: approve the curve for the full balance, then sell with a minimum
// quote out at the configured slippage. Fees on a sell come off the output.
async function sellPonsCurve(provider: ethers.JsonRpcProvider, signer: ethers.Wallet, curveAddress: string, tokenAddress: string, walletAddress: string, tokenBalance: bigint): Promise<ethers.TransactionResponse> {
  const curve = new ethers.Contract(curveAddress, PONS_CURVE_ABI, signer);
  if (await curve.readyToGraduate()) throw new Error('Pons curve is sold out (ready to graduate); sells to the curve are closed. Trade the post-graduation pool instead.');
  const [reserves, feeBps, creatorTaxBps] = await Promise.all([curve.getReserves(), curve.feeBps(), curve.creatorTaxBps()]);
  const [quoteReserve, tokenReserve] = reserves;
  const gross = tokenBalance * quoteReserve / (tokenReserve + tokenBalance);
  const expected = gross - (gross * feeBps) / 10000n - (gross * creatorTaxBps) / 10000n;
  const minimum = minOut(expected);
  console.log(`Pons curve: sell ${ethers.formatEther(tokenBalance)} tokens, expect ~${ethers.formatEther(expected)} ETH, min ${ethers.formatEther(minimum)} (slippage ${ROBINHOOD_SLIPPAGE_BPS / 100}%)`);
  const erc20Abi = get_erc20_abi();
  const token = new ethers.Contract(tokenAddress, erc20Abi, signer);
  // The sell's estimateGas reads the token's allowance, so the approval must
  // be mined first — awaiting the hash alone races the simulation.
  const approvalTx = await token.approve(curveAddress, tokenBalance);
  await approvalTx.wait();
  return curve.sell(tokenBalance, minimum, walletAddress);
}

// ---------------------------------------------------------------------------
// Pons v2 graduated-pool adapter (Uniswap v4 via Universal Router)
// ---------------------------------------------------------------------------
// v4 action IDs per the v4-periphery pinned by Universal Router 2.2.0
// (Actions.sol): SWAP_EXACT_IN_SINGLE 0x06, SETTLE_ALL 0x0c, TAKE_ALL 0x0f.
const V4_ACTIONS = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f };
const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];
const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];
// The graduated pool key: currencies sorted with native ETH (zero address)
// always first, pool fee from the launch record (the hook charges fees, not
// the pool), tick spacing from the record, shared pons meme hook.
function ponsPoolKey(launch: PonsLaunch): { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string } {
  const token = launch.token.toLowerCase();
  const pair = launch.pairToken.toLowerCase();
  const [currency0, currency1] = pair < token ? [launch.pairToken, launch.token] : [launch.token, launch.pairToken];
  return { currency0, currency1, fee: launch.poolFee, tickSpacing: launch.tickSpacing, hooks: PONS_MEME_HOOK };
}

// Quote a v4 swap by simulating the exact Universal Router calldata we will
// send, via eth_call, with binary search on amountOutMinimum: the router
// reverts when the pool's actual output is below the minimum, so the highest
// passing minimum converges to the true achievable output. This needs no
// quoter contract (the chain's V4Quoter is from an older periphery revision),
// and doubles as a dress rehearsal — if the simulation passes, the real swap
// uses byte-identical calldata. Requires the wallet to be funded (buys) or to
// hold the tokens with a Permit2 allowance set (sells), which is true at
// trade time.
function v4RouterCalldata(launch: PonsLaunch, zeroForOne: boolean, amountIn: bigint, minimum: bigint, deadline: bigint): string {
  const poolKey = ponsPoolKey(launch);
  // SWAP_EXACT_IN_SINGLE, then SETTLE_ALL on the input currency, then
  // TAKE_ALL of the output credit to the wallet.
  const actions = ethers.solidityPacked(['uint8', 'uint8', 'uint8'], [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]);
  const params = [
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'uint256', 'bytes'],
      [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn, minimum, 0, '0x'],
    ),
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [zeroForOne ? poolKey.currency0 : poolKey.currency1, amountIn]),
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [zeroForOne ? poolKey.currency1 : poolKey.currency0, minimum]),
  ];
  const commands = ethers.solidityPacked(['uint8'], [0x10]); // Commands.V4_SWAP
  return new ethers.Interface(UNIVERSAL_ROUTER_ABI).encodeFunctionData('execute', [commands, params, deadline]);
}

async function v4Simulates(provider: ethers.Provider, from: string, calldata: string, value: bigint): Promise<boolean> {
  try { await provider.call({ to: UNIVERSAL_ROUTER_ROBINHOOD, data: calldata, from, value }); return true; }
  catch { return false; }
}

async function quoteV4(provider: ethers.Provider, from: string, launch: PonsLaunch, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const deadline = BigInt((await provider.getBlock('latest'))!.timestamp + 300);
  // lo: known-passing minimum (starts at 0 = accept any output), hi: known-failing.
  let lo = 0n, hi = amountIn;
  if (!await v4Simulates(provider, from, v4RouterCalldata(launch, zeroForOne, amountIn, lo, deadline), zeroForOne ? amountIn : 0n)) {
    throw new Error(`V4 swap simulation failed for ${zeroForOne ? 'ETH -> token' : 'token -> ETH'} on the graduated pool of ${launch.token}; the pool may be empty, the wallet may lack funds/allowance, or the routing calldata does not match the chain's Universal Router.`);
  }
  for (let i = 0; i < 32 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (await v4Simulates(provider, from, v4RouterCalldata(launch, zeroForOne, amountIn, mid, deadline), zeroForOne ? amountIn : 0n)) lo = mid; else hi = mid;
  }
  if (lo <= 0n) throw new Error(`V4 swap simulated to 0 output for ${amountIn} ${zeroForOne ? 'ETH' : 'tokens'} on the graduated pool; the pool may be empty or the token may have fees on transfer.`);
  return lo;
}

// The router pulls ERC20 input through Permit2; make sure the wallet has an
// allowance for the router before quoting (the simulation pays from the
// wallet, so it needs the allowance too).
async function ensureV4Permit2(signer: ethers.Wallet, token: string, amountIn: bigint, deadline: bigint): Promise<void> {
  const permit2 = new ethers.Contract(PERMIT2_ROBINHOOD, PERMIT2_ABI, signer);
  const [amount, expiration] = await permit2.allowance(signer.address, token, UNIVERSAL_ROUTER_ROBINHOOD);
  if (amount < amountIn || expiration < deadline) {
    const erc20Abi = get_erc20_abi();
    const tokenContract = new ethers.Contract(token, erc20Abi, signer);
    await tokenContract.approve(PERMIT2_ROBINHOOD, ethers.MaxUint256);
    await permit2.approve(token, UNIVERSAL_ROUTER_ROBINHOOD, (1n << 160n) - 1n, 0xffffffffffff);
  }
}

// Build and submit a v4 swap through the Universal Router. Native input is
// attached as value; ERC20 input is pulled from the wallet via Permit2.
async function swapPonsV4(signer: ethers.Wallet, launch: PonsLaunch, zeroForOne: boolean, amountIn: bigint, expectedOut: bigint): Promise<ethers.TransactionResponse> {
  const minimum = minOut(expectedOut);
  const deadline = BigInt((await signer.provider!.getBlock('latest'))!.timestamp + 300);
  const data = v4RouterCalldata(launch, zeroForOne, amountIn, minimum, deadline);
  if (zeroForOne) {
    return signer.sendTransaction({ to: UNIVERSAL_ROUTER_ROBINHOOD, data, value: amountIn });
  }
  return signer.sendTransaction({ to: UNIVERSAL_ROUTER_ROBINHOOD, data });
}

// Post-graduation buy: ETH -> token through the graduated v4 pool.
async function buyPonsV4(signer: ethers.Wallet, launch: PonsLaunch, walletAddress: string, amountIn: bigint): Promise<ethers.TransactionResponse> {
  const quoted = await quoteV4(signer.provider!, walletAddress, launch, true, amountIn);
  console.log(`Pons v4: spend ${ethers.formatEther(amountIn)} ETH, expect ~${ethers.formatEther(quoted)} tokens, min ${ethers.formatEther(minOut(quoted))} (slippage ${ROBINHOOD_SLIPPAGE_BPS / 100}%)`);
  return swapPonsV4(signer, launch, true, amountIn, quoted);
}

// Post-graduation sell: token -> ETH through the graduated v4 pool.
async function sellPonsV4(signer: ethers.Wallet, launch: PonsLaunch, walletAddress: string, tokenBalance: bigint): Promise<ethers.TransactionResponse> {
  const deadline = BigInt((await signer.provider!.getBlock('latest'))!.timestamp + 300);
  await ensureV4Permit2(signer, launch.token, tokenBalance, deadline);
  const quoted = await quoteV4(signer.provider!, walletAddress, launch, false, tokenBalance);
  console.log(`Pons v4: sell ${ethers.formatEther(tokenBalance)} tokens, expect ~${ethers.formatEther(quoted)} ETH, min ${ethers.formatEther(minOut(quoted))} (slippage ${ROBINHOOD_SLIPPAGE_BPS / 100}%)`);
  return swapPonsV4(signer, launch, false, tokenBalance, quoted);
}

const baseWallet = {
  privateKey: BASE_WALLET_PRIVATE_KEY,
  address: BASE_WALLET_ADDRESS,
}

let fileName = "";

export const buyToken = async (tokenAddress: string, wallet: Wallet, chainId: ChainId) => {
  const rpc = getRpc(chainId);
  const provider = new ethers.JsonRpcProvider(rpc);
  const block = await provider.getBlock("latest");
  const currentTimestamp = block?.timestamp || 9999999999999;
  try {
    const signer = new ethers.Wallet(wallet.privateKey, provider)
    let tx;
    if (chainId === ChainId.Robinhood) {
      const amountInWei = ethers.parseEther(wallet.amount.toString());
      // Pons v2 launch? Curve (pre-graduation) or graduated v4 pool; else Uniswap.
      const launch = await ponsLaunchFor(provider, tokenAddress);
      if (launch?.onCurve) {
        console.log("=================================== Buying ===================================")
        console.log(`Token Address: ${tokenAddress} (Pons v2 curve ${launch.curve})`)
        await delay(5000);
        tx = await buyPonsCurve(provider, signer, launch.curve, wallet.address, amountInWei);
      } else if (launch?.graduated) {
        console.log("=================================== Buying ===================================")
        console.log(`Token Address: ${tokenAddress} (Pons v2 graduated, Uniswap v4 pool)`)
        await delay(5000);
        tx = await buyPonsV4(signer, launch, wallet.address, amountInWei);
      } else {
      // Robinhood Chain has no V2-style router; SwapRouter02 wraps the sent ETH
      // into the chain's WETH when tokenIn is WETH and the call carries value.
      const routerAddress = getRouterAddress(chainId);
      const contract = new ethers.Contract(routerAddress, ROBINHOOD_ROUTER_ABI, signer);
      console.log("=================================== Buying ===================================")
      const amountInWei = ethers.parseEther(wallet.amount.toString());
      const feeTier = await poolFee(provider, tokenAddress);
      const quoted = await quoteV3(provider, WrappedNative[chainId], tokenAddress, feeTier, amountInWei);
      console.log(`Token Address: ${tokenAddress} (Uniswap V3, fee tier ${feeTier})`)
      console.log(`Quoted out: ${quoted} - minimum accepted: ${minOut(quoted)} (slippage ${ROBINHOOD_SLIPPAGE_BPS / 100}%)`)
      await delay(5000);
      tx = await contract.exactInputSingle({
        tokenIn: WrappedNative[chainId],
        tokenOut: tokenAddress,
        fee: feeTier,
        recipient: wallet.address,
        amountIn: amountInWei,
        amountOutMinimum: minOut(quoted),
        sqrtPriceLimitX96: 0n,
      }, { value: amountInWei });
      }
    } else {
      const routerAbi = get_router_abi();
      const routerAddress = getRouterAddress(chainId);
      const contract = new ethers.Contract(routerAddress, routerAbi, signer);
      console.log("=================================== Buying ===================================")
      console.log(`Token Address: ${tokenAddress}`)
      await delay(5000);
      tx = await contract
        .swapExactETHForTokensSupportingFeeOnTransferTokens(0,
          [WrappedNative[chainId], tokenAddress],
          wallet.address,
          currentTimestamp + 1000000000,
          {
            value: ethers.parseEther(wallet.amount.toString())
          });
    }
    await tx.wait();
    console.log(`Buy : ${tx.hash}`);
    return tx.hash;
  } catch (error) {
    console.log(error);
    await gather(wallet, provider);
    return "";
  }
}

export const sellToken = async (tokenAddress: string, wallet: Wallet, chainId: ChainId) => {
  const routerAddress = getRouterAddress(chainId);
  const rpc = getRpc(chainId);
  const provider = new ethers.JsonRpcProvider(rpc);
  const block = await provider.getBlock("latest");
  const currentTimestamp = block?.timestamp || 9999999999999;
  const erc20Abi = get_erc20_abi();
  try {
    const signer = new ethers.Wallet(wallet.privateKey, provider)
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, signer);
    const tokenBalance = await tokenContract.balanceOf(wallet.address);

    console.log("=================================== Approving ===================================")
    console.log(`Approving ${tokenAddress} to sell from ${wallet.address}`);
    await delay(5000);
    const approval = await tokenContract.approve(routerAddress, tokenBalance);
    console.log(`Approval : ${approval.hash}`);

    console.log("=================================== Selling ===================================")
    await delay(5000);
    let tx;
    if (chainId === ChainId.Robinhood) {
      // Pons v2 launch? Curve (pre-graduation) or graduated v4 pool; else Uniswap.
      const launch = await ponsLaunchFor(provider, tokenAddress);
      if (launch?.onCurve) {
        console.log(`Selling ${tokenAddress} via Pons v2 curve ${launch.curve}`);
        await delay(5000);
        tx = await sellPonsCurve(provider, signer, launch.curve, tokenAddress, wallet.address, tokenBalance);
        await tx.wait();
        console.log(`Sell : ${tx.hash}`);
        await gather(wallet, provider);
        return tx.hash;
      }
      if (launch?.graduated) {
        console.log(`Selling ${tokenAddress} via Pons v2 graduated pool (Uniswap v4)`);
        await delay(5000);
        tx = await sellPonsV4(signer, launch, wallet.address, tokenBalance);
        await tx.wait();
        console.log(`Sell : ${tx.hash}`);
        await gather(wallet, provider);
        return tx.hash;
      }
      // Atomic sell: swap token -> WETH to the router, then unwrap WETH to the
      // wallet as native ETH. Router WETH is an Arbitrum-style gateway proxy, so
      // unwrapping must go through the router's own unwrapWETH9.
      const contract = new ethers.Contract(routerAddress, ROBINHOOD_ROUTER_ABI, signer);
      const weth = WrappedNative[chainId];
      const feeTier = await poolFee(provider, tokenAddress);
      const quoted = await quoteV3(provider, tokenAddress, weth, feeTier, tokenBalance);
      const minimum = minOut(quoted);
      console.log(`Quoted out: ${quoted} - minimum accepted: ${minimum} (slippage ${ROBINHOOD_SLIPPAGE_BPS / 100}%)`);
      const swapData = new ethers.Interface(ROBINHOOD_ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
        tokenIn: tokenAddress,
        tokenOut: weth,
        fee: feeTier,
        recipient: routerAddress,
        amountIn: tokenBalance,
        amountOutMinimum: minimum,
        sqrtPriceLimitX96: 0n,
      }]);
      const unwrapData = new ethers.Interface(ROBINHOOD_ROUTER_ABI).encodeFunctionData('unwrapWETH9', [minimum, wallet.address]);
      tx = await contract.multicall([swapData, unwrapData]);
    } else {
      const routerAbi = get_router_abi();
      const contract = new ethers.Contract(routerAddress, routerAbi, signer);
      tx = await contract.swapExactTokensForETHSupportingFeeOnTransferTokens(tokenBalance, 0, [tokenAddress, WrappedNative[chainId]], wallet.address, currentTimestamp + 1000000000);
    }
    await tx.wait();
    console.log(`Sell : ${tx.hash}`);

    await gather(wallet, provider);
    return tx.hash;
  } catch (error) {
    console.log(error);
    return "Transaction Failed";
  }
}

export const processTransaction = async (wallet: Wallet, token_addr: string, chainId: number) => {
  const rpc = getRpc(chainId);
  const provider = new ethers.JsonRpcProvider(rpc);
  try {
    const transferAmount = (+wallet.amount + +fee).toFixed(6);
    const isTransferred = await sendEther(baseWallet.privateKey, wallet.address, transferAmount, provider);
    if (isTransferred) {
      await saveWallet({...wallet, funded: transferAmount}, fileName);
    }
    const hash = await buyToken(token_addr, wallet, chainId);

    if(hash == "") {
      console.log("Trading with the next wallet.");
      return;
    }

    const delayTime = getRandomDelay();
    console.log(`=================================== Delaying ${delayTime / 1000}s ===================================`)
    await delay(delayTime);
    await sellToken(token_addr, wallet, chainId)
  } catch (error) {
    console.error(`Error processing transaction for user`, error);
  }
  const delayTime = getRandomDelay();
  console.log(`=================================== Delaying ${delayTime / 1000}s ===================================`)
  await delay(delayTime);
}
const runBot = async () => {
  console.log(`Generating ${subWalletNum} subwallets`);
  fileName = await generateWallets(subWalletNum);
  const wallets = await readingWallets(fileName);

  for (let i = 0; i < wallets.length; i++) {
    await processTransaction(wallets[i], TARGET_TOKEN_ADDRESS, CHAINID);

    const delayTime = getRandomDelay();
    console.log(`=================================== Delaying ${delayTime / 1000}s ===================================`)
    await delay(delayTime);
  }
}


runBot()



