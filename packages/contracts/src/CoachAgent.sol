// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title IOracle
 * @notice Verifies a re-encryption proof produced inside a TEE.
 * @dev The oracle attests that ciphertext under a new key decrypts to the same
 *      plaintext as the old — without either the chain or the sender learning
 *      the plaintext. Interface per the 0G Agentic ID specification.
 */
interface IOracle {
    function verifyProof(bytes calldata proof) external view returns (bool);
}

/**
 * @title CoachAgent
 * @notice An owned, transferable nutrition coach whose learned intelligence
 *         lives encrypted on 0G Storage.
 *
 * @dev **On ERC-7857, stated precisely.**
 *
 *      This contract follows ERC-7857's design — metadata that is encrypted,
 *      transferred by re-encrypting to the recipient under a sealed key, and
 *      admitted only against an oracle-verified proof — but it does **not**
 *      implement `IERC7857`, and does not advertise it through
 *      `supportsInterface`. It is an ERC-721 with those semantics.
 *
 *      The difference is in the signatures, and it is deliberate rather than an
 *      oversight. The standard's `transfer(from, to, tokenId, sealedKey, proof)`
 *      carries the new ciphertext location inside `proof`, decoded by the
 *      oracle. No oracle is deployed yet, and the encoding of that proof is not
 *      specified in the documentation, so implementing those exact signatures
 *      would mean inventing a format and calling the result conformant. The
 *      functions here take the new root and metadata hashes explicitly instead.
 *
 *      Anything reading `supportsInterface` will therefore not find ERC-7857
 *      here, which is the honest answer. Adopting the interface is a small
 *      change once a verifier and its proof format exist.
 *
 * @dev **Why this contract is the product, not a wrapper around it.**
 *
 *      This app's entire moat is that the coach learns you. On day one it asks
 *      two questions per meal; by week four it asks none, because it has
 *      settled how much dal you eat and whether your roti has ghee. That
 *      accumulated state — settled attributes, your versions of your foods,
 *      your portions — *is* the coach's intelligence, and it is worth more to
 *      you every week.
 *
 *      Everywhere else, that learned state is the company's asset. You rent
 *      access to a model of yourself, and when you leave, it stays. Users named
 *      this exactly: "Once you stop your subscription you lose your data. Wow,
 *      that's an automatic no from me."
 *
 *      Here the learned state is an ERC-7857 token. The brain is ECIES-encrypted
 *      to the owner and stored on 0G Storage; this contract holds the pointer,
 *      the integrity commitment, and the ownership. Which means:
 *
 *        - You **own** the coach. Not a licence — the token.
 *        - You can **transfer** it, and the metadata is re-encrypted to the new
 *          owner. Your trained coach can leave with you.
 *        - You can **clone** it — hand your mother a copy of a coach that
 *          already knows your kitchen, without giving up your own.
 *        - You can **authorise** a dietitian to use it without owning it, and
 *          revoke that later.
 *
 *      None of this is expressible without a chain and an encrypted-metadata
 *      NFT standard. Remove 0G and you do not get a slightly worse version of
 *      this product; you get a different product, in which we own your coach.
 *
 *      **What is deliberately NOT here:** the brain itself. Only root hashes and
 *      commitments. Everything written on chain is permanent and public, so the
 *      only safe thing to write is a pointer to ciphertext.
 */
contract CoachAgent is ERC721, AccessControl, Pausable, EIP712 {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Bounds the authorisation loop so no caller can build an unbounded transaction.
    uint256 public constant MAX_AUTHORIZATIONS_PER_CALL = 32;

    /// @dev A brain that has evolved this many times is a client bug, not a user.
    uint256 public constant MAX_VERSIONS = 4096;

    struct Brain {
        /// @dev 0G Storage root hash of the ECIES-encrypted learned state.
        bytes32 rootHash;
        /// @dev Commitment to the plaintext, so a swapped ciphertext is detectable.
        bytes32 metadataHash;
        /// @dev Client-side schema version of the serialised brain.
        uint32 schemaVersion;
        /// @dev How many settled attributes this version encodes. The moat, counted.
        uint32 learnedCount;
        uint64 createdAt;
    }

    /// @dev tokenId => append-only version history. The coach's whole life.
    mapping(uint256 tokenId => Brain[]) private _brains;

    /// @dev tokenId => executor => may run this coach without owning it.
    mapping(uint256 tokenId => mapping(address executor => bool)) private _authorized;

    /// @dev Oracle that verifies re-encryption proofs on transfer and clone.
    IOracle public oracle;

    uint256 private _nextTokenId = 1;

    event CoachMinted(
        address indexed owner, uint256 indexed tokenId, bytes32 indexed rootHash, uint32 schemaVersion
    );

    event BrainEvolved(
        uint256 indexed tokenId,
        uint256 indexed version,
        bytes32 indexed rootHash,
        uint32 learnedCount
    );

    event CoachTransferred(
        address indexed from, address indexed to, uint256 indexed tokenId, bytes32 newRootHash
    );

    event CoachCloned(
        uint256 indexed sourceTokenId, uint256 indexed newTokenId, address indexed to
    );

    event UsageAuthorized(uint256 indexed tokenId, address indexed executor);
    event UsageRevoked(uint256 indexed tokenId, address indexed executor);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    error NotOwner(uint256 tokenId, address caller);
    error UnknownToken(uint256 tokenId);
    error EmptyRootHash();
    error EmptyMetadataHash();
    error InvalidProof();
    error TooManyAuthorizations(uint256 provided, uint256 maximum);
    error VersionLimitReached(uint256 tokenId);
    error ZeroAddress();
    error CannotAuthorizeOwner();
    error NoOracle();
    error InvalidSignature();
    error NonceAlreadyUsed(address owner, uint256 nonce);
    error SignatureExpired(uint256 deadline);

    bytes32 private constant MINT_TYPEHASH = keccak256(
        "MintCoach(bytes32 rootHash,bytes32 metadataHash,uint32 schemaVersion,uint256 nonce,uint256 deadline)"
    );

    bytes32 private constant EVOLVE_TYPEHASH = keccak256(
        "Evolve(uint256 tokenId,bytes32 rootHash,bytes32 metadataHash,uint32 learnedCount,uint256 nonce,uint256 deadline)"
    );

    /// @dev owner => consumed nonces. A signature is good exactly once.
    mapping(address owner => mapping(uint256 nonce => bool used)) private _usedNonces;

    /// @notice Whether a relayed nonce has already been spent.
    function nonceUsed(address owner, uint256 nonce) external view returns (bool) {
        return _usedNonces[owner][nonce];
    }

    /// @dev Shared by both relayed entry points, so neither can forget a check.
    function _consumeSignature(address owner, uint256 nonce, uint256 deadline, bytes32 structHash, bytes calldata signature)
        private
    {
        // Deadlines here are minutes and a validator can move the clock by
        // seconds, which cannot reach far enough to matter. Same comparison
        // EIP-2612 permit uses.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        if (_usedNonces[owner][nonce]) revert NonceAlreadyUsed(owner, nonce);
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != owner) revert InvalidSignature();
        _usedNonces[owner][nonce] = true;
    }

    constructor(address admin, address initialOracle)
        ERC721("It Asks Coach", "COACH")
        EIP712("CoachAgent", "1")
    {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        oracle = IOracle(initialOracle);
    }

    // ------------------------------------------------------------------ mint

    /**
     * @notice Mint a coach for the caller.
     * @param rootHash 0G Storage root hash of the encrypted brain.
     * @param metadataHash Commitment to the plaintext brain.
     * @param schemaVersion Serialisation version, so old brains stay readable.
     *
     * @dev Self-mint only. There is no operator path anywhere in this contract:
     *      if we could mint on a user's behalf we could also mint a coach they
     *      did not train, and the ownership claim would be ours to make rather
     *      than theirs to hold.
     */
    function mintCoach(bytes32 rootHash, bytes32 metadataHash, uint32 schemaVersion)
        external
        whenNotPaused
        returns (uint256 tokenId)
    {
        return _mintCoach(msg.sender, rootHash, metadataHash, schemaVersion);
    }

    /// @dev The one place a coach is minted, so both entry points validate identically.
    function _mintCoach(address owner, bytes32 rootHash, bytes32 metadataHash, uint32 schemaVersion)
        private
        returns (uint256 tokenId)
    {
        if (rootHash == bytes32(0)) revert EmptyRootHash();
        if (metadataHash == bytes32(0)) revert EmptyMetadataHash();

        tokenId = _nextTokenId++;

        /*
         * The brain is written before the token is minted, not after.
         *
         * `_safeMint` calls `onERC721Received` on the recipient, which hands
         * control to arbitrary code while this function is half finished. With
         * the push afterwards, that code sees a token that exists and owns
         * nothing: `currentBrain` reverts on an empty array, `versionCount`
         * reads zero, and anything integrating against "a coach has a brain"
         * is wrong for the length of the callback.
         *
         * Effects before interactions. Writing our own mapping before the
         * token exists is harmless; letting somebody observe the gap is not.
         */
        _brains[tokenId].push(
            Brain({
                rootHash: rootHash,
                metadataHash: metadataHash,
                schemaVersion: schemaVersion,
                learnedCount: 0,
                createdAt: uint64(block.timestamp)
            })
        );

        _safeMint(owner, tokenId);

        emit CoachMinted(owner, tokenId, rootHash, schemaVersion);
    }

    // ---------------------------------------------------------------- evolve

    /**
     * @notice Record that the coach has learned more.
     * @param learnedCount Settled attributes encoded in this version.
     *
     * @dev Append-only. Every version the coach has ever had stays readable,
     *      which is what makes "my coach has learned 340 things about how I eat"
     *      a verifiable claim rather than a number on our dashboard.
     *
     *      Called after a batch of corrections or answers, not per meal —
     *      per-meal writes would put a chain in the middle of a camera shutter.
     */
    function evolve(uint256 tokenId, bytes32 rootHash, bytes32 metadataHash, uint32 learnedCount)
        external
        whenNotPaused
        returns (uint256 version)
    {
        _requireOwner(tokenId);
        return _evolve(tokenId, rootHash, metadataHash, learnedCount);
    }

    /// @dev The one place a brain version is appended.
    function _evolve(uint256 tokenId, bytes32 rootHash, bytes32 metadataHash, uint32 learnedCount)
        private
        returns (uint256 version)
    {
        if (rootHash == bytes32(0)) revert EmptyRootHash();
        if (metadataHash == bytes32(0)) revert EmptyMetadataHash();

        Brain[] storage history = _brains[tokenId];
        if (history.length >= MAX_VERSIONS) revert VersionLimitReached(tokenId);

        version = history.length;
        history.push(
            Brain({
                rootHash: rootHash,
                metadataHash: metadataHash,
                schemaVersion: history[version - 1].schemaVersion,
                learnedCount: learnedCount,
                createdAt: uint64(block.timestamp)
            })
        );

        emit BrainEvolved(tokenId, version, rootHash, learnedCount);
    }

    /**
     * @notice Mint a coach for an owner who signed for it, paid for by anyone.
     *
     * @dev The same reasoning as HealthRecordAnchor's relayed anchor. A person
     *      who signs in with a phone number holds no wallet and cannot fund an
     *      address, so requiring them to send this transaction meant nobody
     *      could own a coach at all — which made the ownership claim decorative.
     *
     *      The coach is minted to `owner` and to nobody else. A relayer may
     *      decline to submit; that is the whole of its authority.
     */
    function mintCoachFor(
        address owner,
        bytes32 rootHash,
        bytes32 metadataHash,
        uint32 schemaVersion,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused returns (uint256 tokenId) {
        _consumeSignature(
            owner,
            nonce,
            deadline,
            keccak256(
                abi.encode(MINT_TYPEHASH, rootHash, metadataHash, schemaVersion, nonce, deadline)
            ),
            signature
        );

        return _mintCoach(owner, rootHash, metadataHash, schemaVersion);
    }

    /**
     * @notice Record a new brain version on behalf of the coach's owner.
     *
     * @dev Ownership is still checked against `owner`, so a signature from
     *      somebody who has since transferred the coach away cannot evolve it.
     */
    function evolveFor(
        address owner,
        uint256 tokenId,
        bytes32 rootHash,
        bytes32 metadataHash,
        uint32 learnedCount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused returns (uint256 version) {
        if (_ownerOf(tokenId) != owner) revert NotOwner(tokenId, owner);

        _consumeSignature(
            owner,
            nonce,
            deadline,
            keccak256(
                abi.encode(
                    EVOLVE_TYPEHASH, tokenId, rootHash, metadataHash, learnedCount, nonce, deadline
                )
            ),
            signature
        );

        return _evolve(tokenId, rootHash, metadataHash, learnedCount);
    }

    // -------------------------------------------------------------- transfer

    /**
     * @notice Transfer a coach, re-encrypting its brain to the recipient.
     * @param sealedKey The brain's key, sealed to the recipient.
     * @param proof TEE proof that the new ciphertext decrypts to the same brain.
     *
     * @dev ERC-7857's central idea, and the reason a plain ERC-721 will not do:
     *      moving the token has to move the *ability to read the brain*, without
     *      the plaintext ever touching the chain. The oracle attests to that
     *      equivalence; we never see it.
     *
     *      The new root hash is appended as a version rather than replacing the
     *      old, so a transferred coach keeps its history and the previous owner
     *      keeps their proof of what they trained.
     */
    function transferCoach(
        address to,
        uint256 tokenId,
        bytes32 newRootHash,
        bytes32 newMetadataHash,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external whenNotPaused {
        _requireOwner(tokenId);
        if (to == address(0)) revert ZeroAddress();
        if (newRootHash == bytes32(0)) revert EmptyRootHash();
        if (newMetadataHash == bytes32(0)) revert EmptyMetadataHash();
        if (sealedKey.length == 0) revert InvalidProof();
        _requireValidProof(proof);

        Brain[] storage history = _brains[tokenId];
        if (history.length >= MAX_VERSIONS) revert VersionLimitReached(tokenId);

        Brain storage current = history[history.length - 1];
        history.push(
            Brain({
                rootHash: newRootHash,
                metadataHash: newMetadataHash,
                schemaVersion: current.schemaVersion,
                learnedCount: current.learnedCount,
                createdAt: uint64(block.timestamp)
            })
        );

        address from = _ownerOf(tokenId);

        // Authorisations are personal to the previous owner's arrangements.
        // Carrying them across a sale would silently hand a stranger's dietitian
        // access to the new owner's coach.
        _clearAuthorizations(tokenId);

        _transfer(from, to, tokenId);
        emit CoachTransferred(from, to, tokenId, newRootHash);
    }

    // ----------------------------------------------------------------- clone

    /**
     * @notice Give someone a copy of this coach, brain included.
     *
     * @dev The family case, and the one that made this worth building: a coach
     *      that already knows your kitchen, your dal, and your portions is
     *      immediately useful to whoever else eats there. Cloning hands them a
     *      trained coach without giving up your own, and without either of you
     *      sharing a login.
     */
    function cloneCoach(
        address to,
        uint256 tokenId,
        bytes32 newRootHash,
        bytes32 newMetadataHash,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external whenNotPaused returns (uint256 newTokenId) {
        _requireOwner(tokenId);
        if (to == address(0)) revert ZeroAddress();
        if (newRootHash == bytes32(0)) revert EmptyRootHash();
        if (newMetadataHash == bytes32(0)) revert EmptyMetadataHash();
        if (sealedKey.length == 0) revert InvalidProof();
        _requireValidProof(proof);

        Brain storage source = _brains[tokenId][_brains[tokenId].length - 1];

        newTokenId = _nextTokenId++;

        // Effects before the interaction, for the same reason as `_mintCoach`:
        // `_safeMint` hands control to the recipient, and it must not be able
        // to observe a coach that exists without a brain.
        _brains[newTokenId].push(
            Brain({
                rootHash: newRootHash,
                metadataHash: newMetadataHash,
                schemaVersion: source.schemaVersion,
                learnedCount: source.learnedCount,
                createdAt: uint64(block.timestamp)
            })
        );

        _safeMint(to, newTokenId);

        emit CoachCloned(tokenId, newTokenId, to);
        emit CoachMinted(to, newTokenId, newRootHash, source.schemaVersion);
    }

    // --------------------------------------------------------- authorisation

    /**
     * @notice Let someone run your coach without owning it.
     *
     * @dev A dietitian, or a family member helping you. They get to use the
     *      coach; they do not get the token, cannot evolve it, and cannot
     *      transfer it. Revocable at any time.
     */
    function authorizeUsage(uint256 tokenId, address[] calldata executors) external whenNotPaused {
        _requireOwner(tokenId);
        uint256 count = executors.length;
        if (count > MAX_AUTHORIZATIONS_PER_CALL) {
            revert TooManyAuthorizations(count, MAX_AUTHORIZATIONS_PER_CALL);
        }

        for (uint256 i = 0; i < count; ++i) {
            address executor = executors[i];
            if (executor == address(0)) revert ZeroAddress();
            if (executor == msg.sender) revert CannotAuthorizeOwner();

            _authorized[tokenId][executor] = true;
            _authorizedList[tokenId].push(executor);
            emit UsageAuthorized(tokenId, executor);
        }
    }

    /**
     * @notice Withdraw someone's access.
     *
     * @dev Deliberately not gated by `whenNotPaused`. Someone withdrawing access
     *      during an incident is exactly when it must work.
     *
     *      Honest limitation, stated because the product must state it too: this
     *      removes on-chain authorisation. It cannot retract a brain someone has
     *      already downloaded and decrypted. No contract can.
     */
    function revokeUsage(uint256 tokenId, address[] calldata executors) external {
        _requireOwner(tokenId);
        uint256 count = executors.length;
        if (count > MAX_AUTHORIZATIONS_PER_CALL) {
            revert TooManyAuthorizations(count, MAX_AUTHORIZATIONS_PER_CALL);
        }

        for (uint256 i = 0; i < count; ++i) {
            _authorized[tokenId][executors[i]] = false;
            emit UsageRevoked(tokenId, executors[i]);
        }
    }

    /// @dev Executors ever authorised, so a transfer can clear them all.
    mapping(uint256 tokenId => address[] executors) private _authorizedList;

    function _clearAuthorizations(uint256 tokenId) private {
        address[] storage list = _authorizedList[tokenId];
        uint256 length = list.length;
        for (uint256 i = 0; i < length; ++i) {
            _authorized[tokenId][list[i]] = false;
        }
        delete _authorizedList[tokenId];
    }

    // ----------------------------------------------------------------- views

    /// @notice Whether `executor` may run this coach. The owner always may.
    function canUse(uint256 tokenId, address executor) external view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        if (_ownerOf(tokenId) == executor) return true;
        return _authorized[tokenId][executor];
    }

    /// @notice The coach's current brain.
    function currentBrain(uint256 tokenId)
        external
        view
        returns (bytes32 rootHash, bytes32 metadataHash, uint32 schemaVersion, uint32 learnedCount, uint64 createdAt)
    {
        Brain[] storage history = _brains[tokenId];
        if (history.length == 0) revert UnknownToken(tokenId);
        Brain storage brain = history[history.length - 1];
        return (brain.rootHash, brain.metadataHash, brain.schemaVersion, brain.learnedCount, brain.createdAt);
    }

    /// @notice One historical version. The coach's whole life stays readable.
    function brainAt(uint256 tokenId, uint256 version)
        external
        view
        returns (bytes32 rootHash, bytes32 metadataHash, uint32 schemaVersion, uint32 learnedCount, uint64 createdAt)
    {
        Brain[] storage history = _brains[tokenId];
        if (version >= history.length) revert UnknownToken(tokenId);
        Brain storage brain = history[version];
        return (brain.rootHash, brain.metadataHash, brain.schemaVersion, brain.learnedCount, brain.createdAt);
    }

    function versionCount(uint256 tokenId) external view returns (uint256) {
        return _brains[tokenId].length;
    }

    /// @notice The integrity commitment, in the sense ERC-7857 uses.
    function getMetadataHash(uint256 tokenId) external view returns (bytes32) {
        Brain[] storage history = _brains[tokenId];
        if (history.length == 0) revert UnknownToken(tokenId);
        return history[history.length - 1].metadataHash;
    }

    // ----------------------------------------------------------------- admin

    function setOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit OracleUpdated(address(oracle), newOracle);
        oracle = IOracle(newOracle);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------- internal

    function _requireOwner(uint256 tokenId) private view {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert UnknownToken(tokenId);
        if (owner != msg.sender) revert NotOwner(tokenId, msg.sender);
    }

    function _requireValidProof(bytes calldata proof) private view {
        if (address(oracle) == address(0)) revert NoOracle();
        if (!oracle.verifyProof(proof)) revert InvalidProof();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
