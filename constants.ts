import * as dotenv from 'dotenv';
import { testVersion } from './config';
import { ChainId } from './types';
dotenv.config();

export const retrieveEnvVariable = (variableName: string) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    console.log(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

// Load environment variables from .env file
dotenv.config();

export const TARGET_TOKEN_ADDRESS = String(retrieveEnvVariable('TARGET_TOKEN_ADDRESS'));

export const ETH_RPC_ENDPOINT = String(retrieveEnvVariable('ETH_RPC_ENDPOINT'));
export const BSC_RPC_ENDPOINT = String(retrieveEnvVariable('BSC_RPC_ENDPOINT'));
export const ETH_SEPOLIA_RPC_ENDPOINT = String(retrieveEnvVariable('ETH_SEPOLIA_RPC_ENDPOINT'));
export const MEV_BLOCK_RPC_ENDPOINT = String(retrieveEnvVariable('MEV_BLOCK_RPC_ENDPOINT'));

export const BASE_WALLET_ADDRESS = String(retrieveEnvVariable('ETH_BASE_WALLET_ADDRESS'));
export const BASE_WALLET_PRIVATE_KEY = String(retrieveEnvVariable('ETH_BASE_WALLET_PRIVATE_KEY'));

// Constant variables
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const WETH_ADDRESS_SEPOLIA = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
export const UNISWAP_ROUTER_V2 = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
export const UNISWAP_ROUTER_V2_SEPOLIA = "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3"
export const UNISWAP_ROUTER_V3 = testVersion ? "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" : '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';
export const UNISWAP_FACTORY_V2 = testVersion ? "0xF62c03E08ada871A0bEb309762E260a7a6a880E6" : '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
export const UNISWAP_FACTORY_V2_SEPOLIA = "0xF62c03E08ada871A0bEb309762E260a7a6a880E6";
export const UNISWAP_FACTORY_V3 = testVersion ? "0x0227628f3F023bb0B980b67D528571c95c6DaC1c" : '0x1f98431c8ad98523631ae4a59f267346ea31f984';
export const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const PANCAKE_ROUTER_V2 = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const PANCAKE_FACTORY_V2 = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";

// Robinhood Chain (Arbitrum Orbit L2, chainId 4663, ETH gas).
// Addresses verified against https://docs.robinhood.com/chain/connecting/ and
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments,
// then confirmed live on-chain: router.WETH9() and router.factory() match, and the
// exactInputSingle / multicall / unwrapWETH9 / refundETH selectors exist in bytecode.
export const ROBINHOOD_RPC_ENDPOINT = String(process.env['ROBINHOOD_RPC_ENDPOINT'] || '');
export const UNISWAP_V3_ROUTER_ROBINHOOD = '0xCaf681a66D020601342297493863E78C959E5cb2';
export const WETH_ADDRESS_ROBINHOOD = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
// Pool fee tier (hundredths of a bip) of the token's V3 pool on Robinhood Chain.
export const ROBINHOOD_POOL_FEE = Number(process.env['ROBINHOOD_POOL_FEE'] || 3000);

export const CONFIRM_ENDPOINT = testVersion ? ETH_SEPOLIA_RPC_ENDPOINT : MEV_BLOCK_RPC_ENDPOINT;
export const ETH_ENDPOINT = testVersion ? ETH_SEPOLIA_RPC_ENDPOINT : ETH_RPC_ENDPOINT;
export const BSC_ENDPOINT = testVersion ? ETH_SEPOLIA_RPC_ENDPOINT : BSC_RPC_ENDPOINT;

export const routers: Record<ChainId, string> = {
  [ChainId.BSC]: PANCAKE_ROUTER_V2,
  [ChainId.Ethereum]: UNISWAP_ROUTER_V2,
  [ChainId.Sepolia]: UNISWAP_ROUTER_V2_SEPOLIA,
  [ChainId.Robinhood]: UNISWAP_V3_ROUTER_ROBINHOOD,
};

export const WrappedNative: Record<ChainId, string> ={
  [ChainId.BSC]: WBNB_ADDRESS,
  [ChainId.Ethereum]: WETH_ADDRESS,
  [ChainId.Sepolia]: WETH_ADDRESS_SEPOLIA,
  [ChainId.Robinhood]: WETH_ADDRESS_ROBINHOOD,
}

export const RPCs: Record<ChainId, string> = {
  [ChainId.BSC]: BSC_RPC_ENDPOINT,
  [ChainId.Ethereum]: ETH_RPC_ENDPOINT,
  [ChainId.Sepolia]: ETH_SEPOLIA_RPC_ENDPOINT,
  [ChainId.Robinhood]: ROBINHOOD_RPC_ENDPOINT,
}