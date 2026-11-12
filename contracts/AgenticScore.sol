// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev ERC-5192 "Minimal Soulbound NFTs". Marketplaces and indexers read this to know a token cannot move.
interface IERC5192 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    function locked(uint256 tokenId) external view returns (bool);
}

/// @title AgenticScore
/// @notice One soulbound NFT per wallet, 3,000 in total, 0.00008 BNB to mint.
///
/// How a mint works
/// ----------------
/// The backend checks the allowlist, computes the wallet's starting score, and signs an EIP-712
/// voucher for exactly that wallet. The wallet (or the agent acting for it) submits the voucher
/// to `mint` together with the mint fee. The contract checks the fee and the signature, mints,
/// and emits the score in `Minted`, so the agent can read it straight from the transaction receipt.
///
/// What lives on-chain and what does not
/// -------------------------------------
/// - On-chain: who minted, token IDs, the supply cap, the one-per-wallet rule, the starting score
///   (as an event, not in storage, to keep the mint cheap), the mint fee, and the fees collected,
///   which the owner withdraws.
/// - Off-chain: the allowlist, the score and its growth during a batch, the leaderboard, and the
///   USDT rewards, which are paid from a separate wallet. No reward funds pass through here.
///
/// The contract trusts the backend signer for the allowlist and the score. It cannot verify either.
contract AgenticScore is ERC721, Ownable2Step, EIP712, IERC5192 {
    /// @notice Hard cap on the number of NFTs that will ever exist.
    uint256 public constant MAX_SUPPLY = 3000;

    /// @notice Ceiling the owner can raise the mint fee to. A leaked owner key cannot set a fee
    ///         higher than this, so the worst it can do to minters is bounded.
    uint256 public constant MAX_MINT_FEE = 0.005 ether;

    /// @dev EIP-712 type of the voucher the backend signs.
    bytes32 private constant MINT_TYPEHASH = keccak256("Mint(address wallet,uint256 score,uint256 deadline)");

    /// @notice Address whose signatures the contract accepts as proof of eligibility.
    address public signer;

    /// @notice Fee charged for one mint, in wei. Fixed at deploy, changeable by the owner up to
    ///         MAX_MINT_FEE. 0.00008 BNB to start.
    uint256 public mintFee = 0.00008 ether;

    /// @notice Minting is closed at deploy and opened by the owner.
    bool public mintOpen;

    /// @notice Once true, the metadata URI can never change again.
    bool public metadataFrozen;

    uint256 internal _totalMinted;
    string private _metadataURI;

    /// @notice Emitted on every mint. `score` is the wallet's starting score, as signed by the backend.
    event Minted(address indexed wallet, uint256 indexed tokenId, uint256 score);
    event SignerUpdated(address indexed previousSigner, address indexed newSigner);
    event MintOpenUpdated(bool open);
    event MetadataURIUpdated(string uri);
    event MetadataFrozen();
    event MintFeeUpdated(uint256 previousFee, uint256 newFee);
    event Withdrawn(address indexed to, uint256 amount);

    error Soulbound();
    error MintClosed();
    error VoucherExpired();
    error AlreadyMinted();
    error SoldOut();
    error InvalidSignature();
    error ZeroAddress();
    error MetadataIsFrozen();
    error RenounceDisabled();
    error WrongFee(uint256 expected, uint256 sent);
    error FeeTooHigh();
    error NothingToWithdraw();
    error WithdrawFailed();

    constructor(address initialOwner, address initialSigner, string memory metadataURI_)
        ERC721("AgenticScore", "AGSC")
        Ownable(initialOwner)
        EIP712("AgenticScore", "1")
    {
        if (initialSigner == address(0)) revert ZeroAddress();
        signer = initialSigner;
        _metadataURI = metadataURI_;
        emit SignerUpdated(address(0), initialSigner);
    }

    // ---------------------------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------------------------

    /// @notice Mint your AgenticScore NFT. Costs `mintFee`, which is 0.00008 BNB at deploy, on top
    ///         of the network gas. The call must carry exactly the fee: too little or too much
    ///         reverts, so nobody overpays by accident.
    /// @param score    Starting score from the backend voucher. The contract treats it as an opaque number.
    /// @param deadline Unix time after which the voucher is no longer accepted.
    /// @param signature Backend signature over (msg.sender, score, deadline).
    /// @return tokenId The new token ID. IDs run from 1 to MAX_SUPPLY.
    function mint(uint256 score, uint256 deadline, bytes calldata signature)
        external
        payable
        returns (uint256 tokenId)
    {
        if (msg.value != mintFee) revert WrongFee(mintFee, msg.value);
        if (!mintOpen) revert MintClosed();
        if (block.timestamp > deadline) revert VoucherExpired();
        // Tokens cannot move or burn, so a balance above zero means this wallet already minted.
        if (balanceOf(msg.sender) != 0) revert AlreadyMinted();
        if (_totalMinted >= MAX_SUPPLY) revert SoldOut();

        if (ECDSA.recover(hashVoucher(msg.sender, score, deadline), signature) != signer) {
            revert InvalidSignature();
        }

        tokenId = ++_totalMinted;
        // _mint, not _safeMint: a smart-contract wallet that does not implement onERC721Received
        // must still be able to receive its token, and a soulbound token cannot be lost in transit.
        _mint(msg.sender, tokenId);

        emit Locked(tokenId);
        emit Minted(msg.sender, tokenId, score);
    }

    /// @notice The EIP-712 digest the backend must sign for a voucher. Exposed so tools and tests
    ///         can check their own hashing against the contract.
    function hashVoucher(address wallet, uint256 score, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MINT_TYPEHASH, wallet, score, deadline)));
    }

    /// @notice Number of NFTs minted so far.
    function totalSupply() external view returns (uint256) {
        return _totalMinted;
    }

    /// @notice Fees collected and not yet withdrawn.
    function feesCollected() external view returns (uint256) {
        return address(this).balance;
    }

    // ---------------------------------------------------------------------------------------
    // Owner controls
    // ---------------------------------------------------------------------------------------

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenUpdated(open);
    }

    /// @notice Change the mint fee. Applies to mints that have not been sent yet, so raise it
    ///         between batches, not during one. Capped at MAX_MINT_FEE.
    function setMintFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_MINT_FEE) revert FeeTooHigh();
        emit MintFeeUpdated(mintFee, newFee);
        mintFee = newFee;
    }

    /// @notice Send every fee collected so far to the owner. Anyone can mint, but only the owner
    ///         can move the money out, and it can only ever go to the owner.
    function withdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToWithdraw();
        emit Withdrawn(owner(), balance);
        (bool ok, ) = owner().call{value: balance}("");
        if (!ok) revert WithdrawFailed();
    }

    /// @notice Rotate the voucher signer. Vouchers signed by the old signer stop working at once.
    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerUpdated(signer, newSigner);
        signer = newSigner;
    }

    function setMetadataURI(string calldata uri) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        _metadataURI = uri;
        emit MetadataURIUpdated(uri);
    }

    /// @notice Lock the metadata URI for good. Cannot be undone.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// @dev Disabled. Renouncing would strand the signer, the open/closed switch and the collected
    ///      fees with no owner.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------------------------
    // Metadata
    // ---------------------------------------------------------------------------------------

    /// @notice Every NFT is identical, so every token returns the same URI.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _metadataURI;
    }

    // ---------------------------------------------------------------------------------------
    // Soulbound
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc IERC5192
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @dev Only a mint (token has no owner yet) may pass. Transfers and burns revert.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC5192).interfaceId || super.supportsInterface(interfaceId);
    }
}
