import type { HardhatUserConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

// Local chain only. Nothing here points at a public network.
const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],
  solidity: '0.8.28',
};

export default config;
