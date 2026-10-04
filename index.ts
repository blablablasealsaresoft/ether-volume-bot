import {
  get_erc20_abi,
  get_router_abi,
} from './fetchAbi';
import {
  BASE_WALLET_ADDRESS,
  BASE_WALLET_PRIVATE_KEY,
  TARGET_TOKEN_ADDRESS,
  WrappedNative
} from './constants'
import { ChainId, Wallet } from './types';
import { ROBINHOOD_POOL_FEE, UNISWAP_V3_ROUTER_ROBINHOOD } from './constants';
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
const V3_ETH_IN = (weth: string, token: string, recipient: string, amountInWei: bigint) => ({
  tokenIn: weth,
  tokenOut: token,
  fee: ROBINHOOD_POOL_FEE,
  recipient,
  amountIn: amountInWei,
  amountOutMinimum: 0n,
  sqrtPriceLimitX96: 0n,
});

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
      console.log(`Token Address: ${tokenAddress} (Uniswap V3, fee tier ${ROBINHOOD_POOL_FEE})`)
      await delay(5000);
      tx = await contract.exactInputSingle(
        V3_ETH_IN(WrappedNative[chainId], tokenAddress, wallet.address, ethers.parseEther(wallet.amount.toString())),
        { value: ethers.parseEther(wallet.amount.toString()) });
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
      const swapData = new ethers.Interface(ROBINHOOD_ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
        tokenIn: tokenAddress,
        tokenOut: weth,
        fee: ROBINHOOD_POOL_FEE,
        recipient: routerAddress,
        amountIn: tokenBalance,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }]);
      const unwrapData = new ethers.Interface(ROBINHOOD_ROUTER_ABI).encodeFunctionData('unwrapWETH9', [0n, wallet.address]);
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



