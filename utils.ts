import { amountMax, amountMin, fee, maxInterval, minInterval } from "./config";
import { BASE_WALLET_ADDRESS, BSC_ENDPOINT, ETH_ENDPOINT, PANCAKE_ROUTER_V2, routers, RPCs, UNISWAP_ROUTER_V2, WBNB_ADDRESS, WETH_ADDRESS, WETH_ADDRESS_SEPOLIA } from "./constants";
import { get_erc20_abi } from "./fetchAbi";
import { ChainId } from "./types";
import { Provider, Wallet, ethers } from 'ethers';
import fs from 'fs';

export function getRpc(chainId: ChainId) {
  return RPCs[chainId];
}

export function getRouterAddress(chainId: ChainId, version?: number) {
  return routers[chainId];
}

export function getRandomDelay() {
  return Math.floor(Math.random() * (maxInterval - minInterval + 1)) + minInterval;
}

export function getRandomEthAmount() {
  return Number((Math.random() * (amountMax - amountMin) + amountMin).toFixed(6));
}


export const generateWallets = async (num: number) => {
  const wallets = [];

  for (let i = 0; i < num; i++) {
    const wallet = Wallet.createRandom();
    wallets.push({
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic?.phrase || "No Mnemonic", // Some wallets may not have mnemonics
      amount: getRandomEthAmount().toFixed(6),
      funded: 0
    });
  }

  // Save to JSON file
  const fileName = `./wallets/${Math.floor(Date.now() / 1000)}.json`
  console.log(`Saving Wallets in ${fileName}`);
  fs.writeFileSync(fileName, JSON.stringify(wallets, null, 2));

  console.log(`Generated ${num} wallets and saved to ${fileName}`);
  return fileName;
};

export const readingWallets = async (fileName: string) => {
  try {
    // Read the file contents
    const data = fs.readFileSync(fileName, "utf-8");

    // Parse JSON into an array
    const wallets = JSON.parse(data);
    return wallets;
  } catch (error) {
    console.error("❌ Error reading wallets file:", error);
    return [];
  }
}

export const saveWallet = async (wallet: any, fileName: string) => {
  const wallets = await readingWallets(fileName);
  const newWallets = wallets.map((item: any) => {
    if (wallet.privateKey.toLowerCase() == item.privateKey.toLowerCase())
      return wallet
    else return item
  });

  fs.writeFileSync(fileName, JSON.stringify(newWallets, null, 2));
  return fileName;
}

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const getTokenBalance = async (tokenAddress: string, walletAddress: string, provider: Provider) => {

  const erc20Abi = get_erc20_abi();
  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);

  try {
    const balance = await tokenContract.balanceOf(walletAddress);

    const balanceInDecimals = ethers.formatUnits(balance, 18); // Change 18 if token has different decimals

    console.log(`Token balance: ${balanceInDecimals} tokens`);
    return balanceInDecimals;
  } catch (error) {
    console.error("Error getting token balance:", error);
    return 0;
  }
};


export const sendEther = async (fromPrvateKey: string, to: string, amount: string, provider: Provider): Promise<boolean> => {
  const wallet = new Wallet(fromPrvateKey, provider);
  console.log({to, amount})
  // Robinhood Chain (Arbitrum Orbit): build EIP-1559 fees explicitly from the
  // live base fee. getFeeData here lags the base fee and produces caps barely
  // above it, which the chain rejects ("max fee per gas less than block base
  // fee"). A 6x cap + 0.1 gwei headroom is safe: Orbit chains ignore priority
  // tips, so only the base fee is ever paid.
  const block = await provider.getBlock('latest');
  const base = block?.baseFeePerGas ?? 0n;
  const tx: ethers.TransactionRequest = {
    to,
    value: ethers.parseEther(amount), // Convert amount to wei
    gasLimit: 100_000, // Robinhood Chain rejects the 21k minimum as "intrinsic gas too low"
    type: 2,
    maxFeePerGas: base * 6n + ethers.parseUnits('0.1', 'gwei'),
    maxPriorityFeePerGas: 0n,
  };

  
  try {
    const txResponse = await wallet.sendTransaction(tx);
    const receipt = await txResponse.wait();
    console.log("Fund transferred: ", receipt?.hash);
    return true;
  } catch (error) {
    console.log(error);
    return false;
  }
};

export const gather = async (wallet: any, provider: Provider) => {
  console.log("Gathering funds from", wallet.address);

  // Get balance (BigInt)
  const balance = await provider.getBalance(wallet.address);
  
  if (balance === 0n) {
    console.log("No funds available.");
    return;
  }

  // Fetch the live base fee and deduct the worst-case gas cost using the same
// cap sendEther signs with (base*6 + 0.1 gwei), so the swept amount always
// leaves enough for the transfer's own gas.
const block = await provider.getBlock('latest');
const base = block?.baseFeePerGas ?? 0n;
const gasLimit = 100_000n; // Robinhood Chain rejects 21k transfers as "intrinsic gas too low"
const maxFeePerGas = base * 6n + ethers.parseUnits('0.1', 'gwei');
const gasFee = gasLimit * maxFeePerGas;

  // Ensure there's enough ETH to cover gas fees
  if (balance <= gasFee) {
    console.log("Not enough balance to cover gas fees.");
    return;
  }

  // Calculate final amount to send (balance - gasFee)
  const amountToSend = balance - gasFee;
  const etherAmount = ethers.formatEther(amountToSend); // Convert BigInt to string

  console.log(`Sending ${etherAmount} ETH after deducting gas fees.`);

  // Send ETH to BASE_WALLET_ADDRESS
  await sendEther(wallet.privateKey, BASE_WALLET_ADDRESS, etherAmount, provider);
};