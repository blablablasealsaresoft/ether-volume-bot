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
import { ROBINHOOD_POOL_FEE, ROBINHOOD_SLIPPAGE_BPS, UNISWAP_V3_FACTORY_ROBINHOOD, UNISWAP_V3_QUOTER_ROBINHOOD, WrappedNative } from './constants';
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



