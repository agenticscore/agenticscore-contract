# AgenticScore contracts

The soulbound NFT behind AgenticScore, for BNB Smart Chain. One file does the work:
`contracts/AgenticScore.sol`. The two files in `contracts/mocks/` exist only for tests and are never deployed.

**Two versions exist, and they differ in one thing: the mint fee.**

| Version | Mint fee | Where |
| --- | --- | --- |
| Free (deployed) | 0 | Live at `0xdb4aDa50DBa6445Fd56F1d3ea3309bb5519b40A8`, minting closed, source verified on BscScan and Sourcify. Its exact source is kept at `verify/AgenticScore-free-0xdb4aDa50.flat.sol` |
| Current source | 0.00008 BNB, owner-changeable | `contracts/AgenticScore.sol`, not deployed yet |

The free version cannot be changed: it is immutable and `mint` is not `payable`, so it can never take a fee.
The fee lives in the current source, which needs its own deployment.

**Status: not audited.** Read "Before mainnet" below.

## What the contract enforces

| Rule | How |
| --- | --- |
| 3,000 NFTs at most | `MAX_SUPPLY` constant, checked on every mint |
| One NFT per wallet | `balanceOf(msg.sender) != 0` reverts. There is no burn and no transfer, so a wallet can never free its slot |
| Soulbound | `_update` reverts on anything but a mint. `approve` and `setApprovalForAll` revert. ERC-5192 (`locked`, `Locked`) is implemented |
| Mint fee | `mint` is `payable` and requires `msg.value == mintFee` exactly, so nobody overpays by accident. The fee is 0.00008 BNB at deploy, the owner can change it up to `MAX_MINT_FEE` (0.005 BNB), and setting it to 0 makes the mint free again |
| Fees collected | Held in the contract and reported by `feesCollected()`. `withdraw()` sends the whole balance to the owner, and only the owner can call it, so the money can only ever go to the owner |
| Allowlist | The contract has none. It accepts a mint only with a voucher signed by `signer` (the backend) for exactly that wallet |
| Starting score | Carried in the voucher, emitted in the `Minted` event. Not stored, which keeps the mint cheap |
| Every NFT identical | `tokenURI` returns one URI for all tokens. The owner can change it until `freezeMetadata()` |
| Closed at deploy | `mintOpen` is false until the owner calls `setMintOpen(true)` |

Not in the contract, on purpose: the allowlist, score calculation, the leaderboard, and the USDT rewards. Rewards
are paid from a separate wallet, so no reward funds or logic live here.

## How a mint works

1. The wallet (or its agent) asks the backend for a voucher. The backend checks the allowlist, computes the
   starting score, and signs an EIP-712 message.
2. The wallet calls `mint(score, deadline, signature)` from its own address, sending the mint fee with it.
3. The contract checks the fee, recovers the signer, checks it equals `signer`, mints, and emits
   `Minted(wallet, tokenId, score)`. The agent reads the score from that event in the receipt.

The voucher is bound to the wallet, the score, and the deadline, and the domain binds it to this contract and chain,
so it cannot be reused for another wallet, edited, or replayed elsewhere.

```
domain:  { name: "AgenticScore", version: "1", chainId: 56, verifyingContract: <contract> }
type:    Mint(address wallet, uint256 score, uint256 deadline)
```

`scripts/sign-voucher.js` is a working reference for the backend. `hashVoucher(wallet, score, deadline)` on the
contract returns the digest it expects, so you can compare your own hashing against it.

**Score scale is your call.** The contract treats `score` as an opaque whole number. Since the formula uses logarithms,
sending the score times 100 (338.9 becomes 33890) keeps two decimals. Pick the scale once and keep it.

## Connecting it to the site and skill.md

In `skill.md`, the launch settings become:

```
CHAIN: BNB Smart Chain mainnet (chain ID 56)
CONTRACT_ADDRESS: <address from deploy>
VERIFY_ENDPOINT: <your backend URL>
MINT_FUNCTION: mint(uint256 score, uint256 deadline, bytes signature)
```

`VERIFY_ENDPOINT` has to return the three values `mint` takes: `score`, `deadline`, and `signature`.

## Deploy

```bash
npm install
cp .env.example .env     # fill it in
npm test
npm run deploy:testnet   # BNB testnet first
```

Then open minting only when the backend is ready:

```bash
CONTRACT_ADDRESS=0x... OPEN=true npx hardhat run scripts/set-mint-open.js --network bscTestnet
```

Run the whole flow on the testnet before mainnet: sign a voucher, mint from a test wallet, read the event. The default
RPC URLs in `hardhat.config.js` are public endpoints. Check them against the current BNB Chain docs and use your own
provider if you expect traffic.

The compiler target is `cancun`. BNB Smart Chain supports it since the Haber hard fork (June 2024), and
OpenZeppelin 5.6 needs it (`mcopy`).

## Deploying from Remix, or verifying on BscScan

`verify/AgenticScore.flat.sol` is the contract with OpenZeppelin 5.6.1 inlined into a single file: one
SPDX line, one `pragma solidity 0.8.28;`, no imports. It compiles on its own with the settings below, so
it is what BscScan's single-file verifier wants and what Remix can take by paste.

The settings have to match `hardhat.config.js` exactly, or the deployed bytecode is not the bytecode the
tests cover:

| Setting | Value |
| --- | --- |
| Compiler | `0.8.28` |
| Optimizer | enabled, 200 runs |
| EVM version | `cancun` |
| OpenZeppelin | `5.6.1` |

In Remix, paste the flat file, pick 0.8.28, tick the optimizer at 200 runs, and set the EVM version to
cancun under Advanced Configurations. Remix resolves `@openzeppelin/contracts/...` to the newest published
version, which is why the flat file exists: it pins 5.6.1 the same way `package-lock.json` does.

Constructor arguments, in order: `initialOwner`, `initialSigner`, `metadataURI_`. The mint fee is **not** a
constructor argument: the contract starts at 0.00008 BNB and the owner changes it with `setMintFee`, so a Remix
deploy cannot get the price wrong by mistyping an argument.

After deploying, read the state before trusting anything: `mintFee()` should be 0.00008 BNB, `mintOpen()` false,
`MAX_SUPPLY()` 3,000, and `owner()`/`signer()` the addresses you passed.

To regenerate the flat file after a contract change:

```bash
npx hardhat flatten contracts/AgenticScore.sol > /tmp/flat.sol
# then keep one SPDX line and one pragma line, because BscScan rejects duplicates:
grep -v '^// SPDX-License-Identifier' /tmp/flat.sol | grep -v '^pragma solidity' \
  | sed '1i // SPDX-License-Identifier: MIT\npragma solidity 0.8.28;' > verify/AgenticScore.flat.sol
```

## Gas and the mint fee

Two different numbers, and mixing them up puts a false claim on the site.

- **Gas** is paid to BNB Chain's validators, not to the project, and it is the same whether the mint is free or
  paid. Measured in the test suite: about **102,700 gas** for the first mint and **85,600** for later ones. At
  0.05 gwei, which is what BSC charges today, that is **0.0000051 BNB** and **0.0000043 BNB**: about $0.003.
- **The mint fee** is what the contract charges, 0.00008 BNB, and it goes to the owner through `withdraw()`.

So the honest sentence on the site is "mint fee 0.00008 BNB, plus network gas", never "free, gas only" while the
fee is non-zero. The project earns nothing from gas at any volume: all 3,000 mints together pay roughly
0.013 BNB in gas, and every wei of it goes to validators.

## Before mainnet

- **Get it reviewed.** 43 tests pass, and I checked that removing the one-per-wallet check, the soulbound guard, the
  signature check, or the fee check each makes tests fail. That is not an audit. The contract is small, but real
  money and real rewards depend on it, so have someone else read it.
- **Owner = multisig.** The owner can open and close minting, rotate the signer, change metadata, change the mint
  fee and withdraw the fees. Use a Safe, not one key. Ownership moves in two steps and cannot be renounced.
- **The fee is a public claim.** `mintFee()` is readable by anyone, and every mint shows the fee moving to the
  contract. Whatever the site and `skill.md` say about the price has to match what the contract charges, at the
  moment it charges it.
- **Protect the signer key.** Whoever holds it can sign vouchers for any wallet, which bypasses the allowlist (the cap
  and one-per-wallet rule still hold). Keep it on a server only, ideally in a KMS, and rotate with `setSigner` if it
  leaks. Rotating invalidates every unused voucher.
- **Decide on `freezeMetadata()`.** It is permanent. Do it once the metadata URL is final.
- **Verify the source on BscScan** after deploying, so anyone can read what is live.

## Tests

`npm test` runs 43 tests: the rules above, the mint fee (nothing sent, too little, too much, changed fee, the cap),
withdrawing (owner only, empty, repeated, after an ownership change), voucher tampering (wallet, score, deadline,
contract, signer), expired vouchers, the supply cap (via a harness that jumps to 2,999), smart-contract wallets,
ERC-5192, ownership, and gas.
