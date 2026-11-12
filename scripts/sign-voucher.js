// Signs one mint voucher. This is exactly what the backend must do after it has checked the
// allowlist and computed the wallet's starting score. It needs no network access.
//
//   VOUCHER_SIGNER_PRIVATE_KEY  the key behind the contract's `signer` address
//   CONTRACT_ADDRESS            the deployed AgenticScore
//   CHAIN_ID                    56 for BNB Smart Chain, 97 for the testnet (default 56)
//   WALLET                      the wallet that will mint
//   SCORE                       starting score as a whole number (decide the scale, see README)
//   TTL_SECONDS                 how long the voucher stays valid (default 900)
const { ethers } = require("ethers");

async function main() {
  const { VOUCHER_SIGNER_PRIVATE_KEY, CONTRACT_ADDRESS, WALLET, SCORE } = process.env;
  const chainId = BigInt(process.env.CHAIN_ID || "56");
  const ttl = Number(process.env.TTL_SECONDS || "900");

  if (!VOUCHER_SIGNER_PRIVATE_KEY) throw new Error("Set VOUCHER_SIGNER_PRIVATE_KEY");
  if (!ethers.isAddress(CONTRACT_ADDRESS || "")) throw new Error("Set CONTRACT_ADDRESS");
  if (!ethers.isAddress(WALLET || "")) throw new Error("Set WALLET");
  if (!/^\d+$/.test(SCORE || "")) throw new Error("Set SCORE to a whole number");

  const signer = new ethers.Wallet(VOUCHER_SIGNER_PRIVATE_KEY);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + ttl);

  const domain = { name: "AgenticScore", version: "1", chainId, verifyingContract: CONTRACT_ADDRESS };
  const types = {
    Mint: [
      { name: "wallet", type: "address" },
      { name: "score", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  };
  const value = { wallet: WALLET, score: BigInt(SCORE), deadline };

  const signature = await signer.signTypedData(domain, types, value);

  console.log(
    JSON.stringify(
      {
        signer: signer.address,
        wallet: WALLET,
        score: SCORE,
        deadline: deadline.toString(),
        signature
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
