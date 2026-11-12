const { expect } = require("chai");
const { ethers } = require("hardhat");

const URI = "ipfs://example-metadata/agenticscore.json";
const FEE = 80_000_000_000_000n; // 0.00008 BNB, the fee the contract sets at deploy
const MAX_FEE = ethers.parseEther("0.005");

describe("AgenticScore", function () {
  let owner, backend, alice, bob, carol, stranger;
  let nft, chainId, domain;

  const types = {
    Mint: [
      { name: "wallet", type: "address" },
      { name: "score", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  };

  async function now() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  async function voucher(wallet, score = 33890n, ttl = 3600, signerWallet = backend) {
    const deadline = BigInt((await now()) + ttl);
    const value = { wallet: typeof wallet === "string" ? wallet : wallet.address, score, deadline };
    const signature = await signerWallet.signTypedData(domain, types, value);
    return { score, deadline, signature };
  }

  async function mintAs(user, score = 33890n, fee = FEE) {
    const v = await voucher(user, score);
    return nft.connect(user).mint(v.score, v.deadline, v.signature, { value: fee });
  }

  beforeEach(async function () {
    [owner, backend, alice, bob, carol, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AgenticScore");
    nft = await Factory.deploy(owner.address, backend.address, URI);
    await nft.waitForDeployment();
    chainId = (await ethers.provider.getNetwork()).chainId;
    domain = { name: "AgenticScore", version: "1", chainId, verifyingContract: await nft.getAddress() };
  });

  describe("deploy", function () {
    it("starts closed, empty, capped at 3,000, and priced at 0.00008 BNB", async function () {
      expect(await nft.mintOpen()).to.equal(false);
      expect(await nft.totalSupply()).to.equal(0n);
      expect(await nft.MAX_SUPPLY()).to.equal(3000n);
      expect(await nft.signer()).to.equal(backend.address);
      expect(await nft.owner()).to.equal(owner.address);
      expect(await nft.name()).to.equal("AgenticScore");
      expect(await nft.mintFee()).to.equal(FEE);
      expect(await nft.MAX_MINT_FEE()).to.equal(MAX_FEE);
      expect(await nft.feesCollected()).to.equal(0n);
    });

    it("refuses a zero signer", async function () {
      const Factory = await ethers.getContractFactory("AgenticScore");
      await expect(Factory.deploy(owner.address, ethers.ZeroAddress, URI)).to.be.revertedWithCustomError(
        Factory,
        "ZeroAddress"
      );
    });
  });

  describe("minting", function () {
    it("is rejected while closed", async function () {
      await expect(mintAs(alice)).to.be.revertedWithCustomError(nft, "MintClosed");
    });

    describe("once open", function () {
      beforeEach(async function () {
        await nft.setMintOpen(true);
      });

      it("mints token 1 to the caller and reports the starting score in the event", async function () {
        const v = await voucher(alice, 33890n);
        await expect(nft.connect(alice).mint(v.score, v.deadline, v.signature, { value: FEE }))
          .to.emit(nft, "Minted")
          .withArgs(alice.address, 1n, 33890n)
          .and.to.emit(nft, "Locked")
          .withArgs(1n);
        expect(await nft.ownerOf(1n)).to.equal(alice.address);
        expect(await nft.balanceOf(alice.address)).to.equal(1n);
        expect(await nft.totalSupply()).to.equal(1n);
      });

      it("numbers tokens in order", async function () {
        await mintAs(alice);
        await mintAs(bob);
        await mintAs(carol);
        expect(await nft.ownerOf(1n)).to.equal(alice.address);
        expect(await nft.ownerOf(2n)).to.equal(bob.address);
        expect(await nft.ownerOf(3n)).to.equal(carol.address);
      });

      it("allows one NFT per wallet", async function () {
        await mintAs(alice);
        await expect(mintAs(alice)).to.be.revertedWithCustomError(nft, "AlreadyMinted");
      });

      it("rejects an expired voucher", async function () {
        const v = await voucher(alice, 100n, -1);
        await expect(
          nft.connect(alice).mint(v.score, v.deadline, v.signature, { value: FEE })
        ).to.be.revertedWithCustomError(nft, "VoucherExpired");
      });

      it("rejects a voucher signed by anyone but the backend signer", async function () {
        const v = await voucher(alice, 100n, 3600, stranger);
        await expect(
          nft.connect(alice).mint(v.score, v.deadline, v.signature, { value: FEE })
        ).to.be.revertedWithCustomError(nft, "InvalidSignature");
      });

      it("binds the voucher to one wallet", async function () {
        const v = await voucher(alice);
        await expect(
          nft.connect(bob).mint(v.score, v.deadline, v.signature, { value: FEE })
        ).to.be.revertedWithCustomError(nft, "InvalidSignature");
      });

      it("binds the voucher to its score, so the score cannot be edited", async function () {
        const v = await voucher(alice, 100n);
        await expect(
          nft.connect(alice).mint(9999n, v.deadline, v.signature, { value: FEE })
        ).to.be.revertedWithCustomError(nft, "InvalidSignature");
      });

      it("binds the voucher to its deadline", async function () {
        const v = await voucher(alice, 100n);
        await expect(
          nft.connect(alice).mint(v.score, v.deadline + 1000n, v.signature, { value: FEE })
        ).to.be.revertedWithCustomError(nft, "InvalidSignature");
      });

      it("rejects a voucher made for another contract or chain", async function () {
        const deadline = BigInt((await now()) + 3600);
        const value = { wallet: alice.address, score: 100n, deadline };
        const wrongDomain = { ...domain, verifyingContract: stranger.address };
        const signature = await backend.signTypedData(wrongDomain, types, value);
        await expect(
          nft.connect(alice).mint(100n, deadline, signature, { value: FEE })
        ).to.be.revertedWithCustomError(nft, "InvalidSignature");
      });

      it("hashes vouchers the same way as the off-chain EIP-712 encoder", async function () {
        const value = { wallet: alice.address, score: 777n, deadline: 123456n };
        const offchain = ethers.TypedDataEncoder.hash(domain, types, value);
        expect(await nft.hashVoucher(value.wallet, value.score, value.deadline)).to.equal(offchain);
      });

      it("does not accept plain BNB transfers", async function () {
        await expect(alice.sendTransaction({ to: await nft.getAddress(), value: 1n })).to.be.reverted;
      });

      it("works for a smart-contract wallet that cannot receive ERC-721 safely", async function () {
        const Wallet = await ethers.getContractFactory("ContractWallet");
        const wallet = await Wallet.deploy();
        await wallet.waitForDeployment();
        const walletAddress = await wallet.getAddress();
        const v = await voucher(walletAddress, 500n);
        await wallet.mintFrom(await nft.getAddress(), v.score, v.deadline, v.signature, { value: FEE });
        expect(await nft.ownerOf(1n)).to.equal(walletAddress);
        expect(await nft.feesCollected()).to.equal(FEE);
      });

      it("reports its gas use", async function () {
        const v = await voucher(alice);
        const tx = await nft.connect(alice).mint(v.score, v.deadline, v.signature, { value: FEE });
        const receipt = await tx.wait();
        console.log("        first mint gas:", receipt.gasUsed.toString());
        const v2 = await voucher(bob);
        const tx2 = await nft.connect(bob).mint(v2.score, v2.deadline, v2.signature, { value: FEE });
        const receipt2 = await tx2.wait();
        console.log("        later mint gas:", receipt2.gasUsed.toString());
        expect(receipt2.gasUsed).to.be.lessThan(200000n);
      });
    });

    describe("the mint fee", function () {
      beforeEach(async function () {
        await nft.setMintOpen(true);
      });

      it("rejects a mint that sends nothing", async function () {
        await expect(mintAs(alice, 33890n, 0n)).to.be.revertedWithCustomError(nft, "WrongFee");
      });

      it("rejects a mint that sends too little", async function () {
        await expect(mintAs(alice, 33890n, FEE - 1n)).to.be.revertedWithCustomError(nft, "WrongFee");
      });

      it("rejects a mint that sends too much, so nobody overpays by accident", async function () {
        await expect(mintAs(alice, 33890n, FEE + 1n)).to.be.revertedWithCustomError(nft, "WrongFee");
      });

      it("holds the fees and reports them", async function () {
        await mintAs(alice);
        await mintAs(bob);
        expect(await nft.feesCollected()).to.equal(FEE * 2n);
        expect(await ethers.provider.getBalance(await nft.getAddress())).to.equal(FEE * 2n);
      });

      it("lets the owner change the fee, and the new fee applies to the next mint", async function () {
        const newFee = ethers.parseEther("0.0001");
        await expect(nft.setMintFee(newFee)).to.emit(nft, "MintFeeUpdated").withArgs(FEE, newFee);
        expect(await nft.mintFee()).to.equal(newFee);
        await expect(mintAs(alice, 33890n, FEE)).to.be.revertedWithCustomError(nft, "WrongFee");
        await mintAs(alice, 33890n, newFee);
        expect(await nft.feesCollected()).to.equal(newFee);
      });

      it("refuses a fee above the cap", async function () {
        await expect(nft.setMintFee(MAX_FEE + 1n)).to.be.revertedWithCustomError(nft, "FeeTooHigh");
        await nft.setMintFee(MAX_FEE);
        expect(await nft.mintFee()).to.equal(MAX_FEE);
      });

      it("lets only the owner change the fee", async function () {
        await expect(nft.connect(stranger).setMintFee(1n)).to.be.revertedWithCustomError(
          nft,
          "OwnableUnauthorizedAccount"
        );
      });

      it("allows a zero fee, which is how the mint is made free again", async function () {
        await nft.setMintFee(0n);
        await mintAs(alice, 33890n, 0n);
        expect(await nft.totalSupply()).to.equal(1n);
        expect(await nft.feesCollected()).to.equal(0n);
      });
    });

    describe("supply cap", function () {
      let harness, harnessDomain;
      beforeEach(async function () {
        const Harness = await ethers.getContractFactory("AgenticScoreHarness");
        harness = await Harness.deploy(owner.address, backend.address, URI);
        await harness.waitForDeployment();
        await harness.setMintOpen(true);
        harnessDomain = { ...domain, verifyingContract: await harness.getAddress() };
      });

      async function harnessMint(user) {
        const deadline = BigInt((await now()) + 3600);
        const signature = await backend.signTypedData(harnessDomain, types, { wallet: user.address, score: 1n, deadline });
        return harness.connect(user).mint(1n, deadline, signature, { value: FEE });
      }

      it("hands out token 3,000 and then stops", async function () {
        await harness.setTotalMintedForTest(2999n);
        await expect(harnessMint(alice)).to.emit(harness, "Minted").withArgs(alice.address, 3000n, 1n);
        expect(await harness.totalSupply()).to.equal(3000n);
        await expect(harnessMint(bob)).to.be.revertedWithCustomError(harness, "SoldOut");
      });
    });
  });

  describe("withdrawing", function () {
    beforeEach(async function () {
      await nft.setMintOpen(true);
      await mintAs(alice);
      await mintAs(bob);
    });

    it("sends the whole balance to the owner, and the contract is left empty", async function () {
      const nftAddress = await nft.getAddress();
      await expect(nft.withdraw()).to.changeEtherBalance(owner, FEE * 2n);
      expect(await ethers.provider.getBalance(nftAddress)).to.equal(0n);
      expect(await nft.feesCollected()).to.equal(0n);
    });

    it("says out loud what it sent, and to whom", async function () {
      await expect(nft.withdraw()).to.emit(nft, "Withdrawn").withArgs(owner.address, FEE * 2n);
    });

    it("lets only the owner withdraw", async function () {
      await expect(nft.connect(stranger).withdraw()).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      expect(await nft.feesCollected()).to.equal(FEE * 2n);
    });

    it("reverts when there is nothing to withdraw", async function () {
      await nft.withdraw();
      await expect(nft.withdraw()).to.be.revertedWithCustomError(nft, "NothingToWithdraw");
    });

    it("can be withdrawn more than once, as fees keep coming in", async function () {
      await nft.withdraw();
      await mintAs(carol);
      expect(await nft.feesCollected()).to.equal(FEE);
      await expect(nft.withdraw()).to.emit(nft, "Withdrawn").withArgs(owner.address, FEE);
      expect(await nft.feesCollected()).to.equal(0n);
    });

    it("sends the fees to the owner even after ownership moves", async function () {
      await nft.transferOwnership(bob.address);
      await nft.connect(bob).acceptOwnership();
      await expect(nft.connect(bob).withdraw()).to.emit(nft, "Withdrawn").withArgs(bob.address, FEE * 2n);
      expect(await nft.feesCollected()).to.equal(0n);
    });
  });

  describe("soulbound", function () {
    beforeEach(async function () {
      await nft.setMintOpen(true);
      await mintAs(alice);
    });

    it("blocks transferFrom, even by the owner of the token", async function () {
      await expect(nft.connect(alice).transferFrom(alice.address, bob.address, 1n)).to.be.revertedWithCustomError(
        nft,
        "Soulbound"
      );
    });

    it("blocks both safeTransferFrom forms", async function () {
      await expect(
        nft.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 1n)
      ).to.be.revertedWithCustomError(nft, "Soulbound");
      await expect(
        nft.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, bob.address, 1n, "0x")
      ).to.be.revertedWithCustomError(nft, "Soulbound");
    });

    it("blocks approvals", async function () {
      await expect(nft.connect(alice).approve(bob.address, 1n)).to.be.revertedWithCustomError(nft, "Soulbound");
      await expect(nft.connect(alice).setApprovalForAll(bob.address, true)).to.be.revertedWithCustomError(
        nft,
        "Soulbound"
      );
    });

    it("has no burn path, so a wallet cannot free its slot", async function () {
      expect(nft.interface.getFunction("burn")).to.equal(null);
      await expect(nft.connect(alice).transferFrom(alice.address, ethers.ZeroAddress, 1n)).to.be.reverted;
    });

    it("says every token is locked (ERC-5192)", async function () {
      expect(await nft.locked(1n)).to.equal(true);
      await expect(nft.locked(2n)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });

    it("advertises ERC-165, ERC-721, ERC-721 Metadata, and ERC-5192", async function () {
      expect(await nft.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true);
      expect(await nft.supportsInterface("0x5b5e139f")).to.equal(true);
      expect(await nft.supportsInterface("0xb45a3c0e")).to.equal(true);
      expect(await nft.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  describe("metadata", function () {
    beforeEach(async function () {
      await nft.setMintOpen(true);
      await mintAs(alice);
      await mintAs(bob);
    });

    it("returns the same URI for every token", async function () {
      expect(await nft.tokenURI(1n)).to.equal(URI);
      expect(await nft.tokenURI(2n)).to.equal(URI);
      await expect(nft.tokenURI(3n)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });

    it("lets only the owner change it, until it is frozen", async function () {
      await expect(nft.connect(stranger).setMetadataURI("ipfs://x")).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await expect(nft.setMetadataURI("ipfs://new")).to.emit(nft, "MetadataURIUpdated").withArgs("ipfs://new");
      expect(await nft.tokenURI(1n)).to.equal("ipfs://new");

      await expect(nft.connect(stranger).freezeMetadata()).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await expect(nft.freezeMetadata()).to.emit(nft, "MetadataFrozen");
      await expect(nft.setMetadataURI("ipfs://later")).to.be.revertedWithCustomError(nft, "MetadataIsFrozen");
      expect(await nft.tokenURI(1n)).to.equal("ipfs://new");
    });
  });

  describe("owner controls", function () {
    it("only the owner can open and close minting", async function () {
      await expect(nft.connect(stranger).setMintOpen(true)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await expect(nft.setMintOpen(true)).to.emit(nft, "MintOpenUpdated").withArgs(true);
      await nft.setMintOpen(false);
      await expect(mintAs(alice)).to.be.revertedWithCustomError(nft, "MintClosed");
    });

    it("rotating the signer kills old vouchers and accepts new ones", async function () {
      await nft.setMintOpen(true);
      const oldVoucher = await voucher(alice);
      await expect(nft.connect(stranger).setSigner(stranger.address)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await expect(nft.setSigner(carol.address)).to.emit(nft, "SignerUpdated").withArgs(backend.address, carol.address);
      await expect(
        nft.connect(alice).mint(oldVoucher.score, oldVoucher.deadline, oldVoucher.signature, { value: FEE })
      ).to.be.revertedWithCustomError(nft, "InvalidSignature");
      const fresh = await voucher(alice, 5n, 3600, carol);
      await nft.connect(alice).mint(fresh.score, fresh.deadline, fresh.signature, { value: FEE });
      expect(await nft.ownerOf(1n)).to.equal(alice.address);
    });

    it("refuses a zero signer", async function () {
      await expect(nft.setSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(nft, "ZeroAddress");
    });

    it("hands ownership over in two steps, and cannot be renounced", async function () {
      await nft.transferOwnership(bob.address);
      expect(await nft.owner()).to.equal(owner.address);
      await expect(nft.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await nft.connect(bob).acceptOwnership();
      expect(await nft.owner()).to.equal(bob.address);
      await expect(nft.connect(bob).renounceOwnership()).to.be.revertedWithCustomError(nft, "RenounceDisabled");
      expect(await nft.owner()).to.equal(bob.address);
    });
  });
});
