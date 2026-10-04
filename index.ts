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
import { PONS_V2_FACTORY, ROBINHOOD_POOL_FEE, ROBINHOOD_SLIPPAGE_BPS, UNISWAP_V3_FACTORY_ROBINHOOD, UNISWAP_V3_QUOTER_ROBINHOOD, WrappedNative } from './constants';
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

// If the token is a live Pons v2 launch on its bonding curve, return the curve
// address; otherwise null (the token trades on a DEX instead).
export async function ponsCurveFor(provider: ethers.JsonRpcProvider, tokenAddress: string): Promise<string | null> {
  const factory = new ethers.Contract(PONS_V2_FACTORY, PONS_FACTORY_ABI, provider);
  const launch: { curve: string; pairToken: string; phase: bigint; exists: boolean } = await factory.getLaunchedToken(tokenAddress);
  if (!launch.exists) return null;
  // phase 0 = NotGraduated. Once graduated, trades belong on the Uniswap v4 pool.
  if (launch.phase !== 0n) return null;
  if (launch.pairToken !== ethers.ZeroAddress) throw new Error(`Pons v2 launch ${tokenAddress} is paired against ${launch.pairToken}, not ETH; the bot only supports ETH-paired curves.`);
  const curve = new ethers.Contract(launch.curve, PONS_CURVE_ABI, provider);
  if (await curve.graduated()) return null;
  return launch.curve;
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
  await token.approve(curveAddress, tokenBalance);
  return curve.sell(tokenBalance, minimum, walletAddress);
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
      // A live Pons v2 launch trades its bonding curve, not Uniswap.
      const curveAddress = await ponsCurveFor(provider, tokenAddress);
      if (curveAddress) {
        console.log("=================================== Buying ===================================")
        console.log(`Token Address: ${tokenAddress} (Pons v2 curve ${curveAddress})`)
        await delay(5000);
        tx = await buyPonsCurve(provider, signer, curveAddress, wallet.address, amountInWei);
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
      // A live Pons v2 launch trades its bonding curve, not Uniswap.
      const curveAddress = await ponsCurveFor(provider, tokenAddress);
      if (curveAddress) {
        console.log(`Selling ${tokenAddress} via Pons v2 curve ${curveAddress}`);
        await delay(5000);
        tx = await sellPonsCurve(provider, signer, curveAddress, tokenAddress, wallet.address, tokenBalance);
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



