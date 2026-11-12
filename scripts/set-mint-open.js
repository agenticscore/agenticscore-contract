// Opens or closes minting. The account in DEPLOYER_PRIVATE_KEY must be the contract owner.
//   CONTRACT_ADDRESS  the deployed AgenticScore
//   OPEN              "true" or "false"
const { ethers } = require("hardhat");

async function main() {
  const { CONTRACT_ADDRESS, OPEN } = process.env;
  if (!ethers.isAddress(CONTRACT_ADDRESS || "")) throw new Error("Set CONTRACT_ADDRESS to the deployed contract");
  if (OPEN !== "true" && OPEN !== "false") throw new Error('Set OPEN to "true" or "false"');

  const nft = await ethers.getContractAt("AgenticScore", CONTRACT_ADDRESS);
  const tx = await nft.setMintOpen(OPEN === "true");
  await tx.wait();
  console.log(`mintOpen is now ${await nft.mintOpen()} (tx ${tx.hash})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
