// Deploys AgenticScore. Minting stays CLOSED until the owner calls setMintOpen(true).
//
//   OWNER_ADDRESS            who controls the contract (use a multisig for mainnet)
//   VOUCHER_SIGNER_ADDRESS   the backend address whose signatures the contract accepts
//   METADATA_URI             the one metadata URL every NFT will return
//   DEPLOYER_PRIVATE_KEY     pays the deploy gas (in .env)
const { ethers, network } = require("hardhat");

async function main() {
  const { OWNER_ADDRESS, VOUCHER_SIGNER_ADDRESS, METADATA_URI } = process.env;
  for (const [name, value] of Object.entries({ OWNER_ADDRESS, VOUCHER_SIGNER_ADDRESS, METADATA_URI })) {
    if (!value) throw new Error(`Set ${name} in .env`);
  }
  if (!ethers.isAddress(OWNER_ADDRESS)) throw new Error("OWNER_ADDRESS is not an address");
  if (!ethers.isAddress(VOUCHER_SIGNER_ADDRESS)) throw new Error("VOUCHER_SIGNER_ADDRESS is not an address");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set DEPLOYER_PRIVATE_KEY in .env");

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:   ${network.name}`);
  console.log(`Deployer:  ${deployer.address} (${ethers.formatEther(balance)} BNB)`);
  console.log(`Owner:     ${OWNER_ADDRESS}`);
  console.log(`Signer:    ${VOUCHER_SIGNER_ADDRESS}`);
  console.log(`Metadata:  ${METADATA_URI}`);

  const Factory = await ethers.getContractFactory("AgenticScore");
  const nft = await Factory.deploy(OWNER_ADDRESS, VOUCHER_SIGNER_ADDRESS, METADATA_URI);
  await nft.waitForDeployment();

  const address = await nft.getAddress();
  console.log("");
  console.log(`AgenticScore deployed at ${address}`);
  console.log(`Tx: ${nft.deploymentTransaction().hash}`);
  console.log("Minting is CLOSED. Open it with scripts/set-mint-open.js when the backend is ready.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
