// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title HealthRecordAnchor
 * @notice On-chain ownership and access control for encrypted health records
 *         stored on 0G Storage.
 *
 * @dev Why this contract exists.
 *
 *      The record itself never touches the chain. Snapshots are ECIES-encrypted
 *      to the user's own public key and written to 0G Storage, which returns
 *      root hashes. Those hashes are the retrieval key: without them the data is
 *      unreachable, and whoever holds them controls access to the ciphertext.
 *
 *      Holding them in our database would make "your record, not ours" a policy
 *      promise. Anchoring them here makes it a property of the system: the user
 *      owns the pointer, the grant list is public and revocable, and the record
 *      outlives the company that produced it.
 *
 *      Design constraints that shaped this:
 *
 *      - **No plaintext, no PII, ever.** Only content-addressed hashes. Anything
 *        written here is permanent and world-readable.
 *      - **The user is the only writer.** The backend pays for storage but has
 *        no authority over a user's anchors; there is no admin path to publish
 *        or mutate someone's record.
 *      - **Revocation is honest about what it can do.** Revoking removes on-chain
 *        authorisation and emits an event. It cannot un-share bytes a grantee
 *        already downloaded and decrypted. The natural-language docs must say
 *        this too — claiming otherwise would be a lie the chain cannot enforce.
 *      - **Append-only history.** Snapshots form a chain per user, so a record
 *        has a verifiable timeline rather than a mutable current value.
 */
contract HealthRecordAnchor is AccessControl, Pausable {
    /// @notice May pause anchoring in an incident. Cannot read, write, or revoke user data.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Bounds the per-call grant loop so a caller cannot construct an unbounded transaction.
    uint256 public constant MAX_GRANTS_PER_CALL = 32;

    /// @dev Bounds the fragment list. A snapshot needing more than this is a client-side bug.
    uint256 public constant MAX_FRAGMENTS = 64;

    struct Snapshot {
        /// @dev Ordered 0G Storage root hashes. All are required to reconstruct the payload.
        bytes32[] rootHashes;
        /// @dev Client-side schema version, so future readers can interpret old payloads.
        uint32 schemaVersion;
        uint64 createdAt;
    }

    /// @dev owner => append-only snapshot history.
    mapping(address owner => Snapshot[]) private _snapshots;

    /// @dev owner => grantee => index+1 of the newest snapshot they may read. 0 means no access.
    mapping(address owner => mapping(address grantee => uint256 upToIndexPlusOne)) private _grants;

    event SnapshotAnchored(
        address indexed owner,
        uint256 indexed index,
        bytes32 indexed firstRootHash,
        uint256 fragmentCount,
        uint32 schemaVersion
    );

    event AccessGranted(address indexed owner, address indexed grantee, uint256 upToIndex);

    event AccessRevoked(address indexed owner, address indexed grantee);

    error NoFragments();
    error TooManyFragments(uint256 provided, uint256 maximum);
    error EmptyRootHash(uint256 position);
    error TooManyGrants(uint256 provided, uint256 maximum);
    error NoSnapshots(address owner);
    error SnapshotOutOfRange(address owner, uint256 index);
    error CannotGrantToSelf();
    error ZeroGrantee();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroGrantee();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /**
     * @notice Anchor a new encrypted snapshot of the caller's record.
     * @param rootHashes Ordered 0G Storage root hashes for this snapshot.
     * @param schemaVersion Client-side payload schema version.
     * @return index Position of the new snapshot in the caller's history.
     *
     * @dev Only ever callable by the record's owner. There is deliberately no
     *      operator or backend path: if we could anchor on a user's behalf, we
     *      could also anchor something they did not author.
     */
    function anchorSnapshot(bytes32[] calldata rootHashes, uint32 schemaVersion)
        external
        whenNotPaused
        returns (uint256 index)
    {
        uint256 count = rootHashes.length;
        if (count == 0) revert NoFragments();
        if (count > MAX_FRAGMENTS) revert TooManyFragments(count, MAX_FRAGMENTS);

        for (uint256 i = 0; i < count; ++i) {
            if (rootHashes[i] == bytes32(0)) revert EmptyRootHash(i);
        }

        Snapshot[] storage history = _snapshots[msg.sender];
        index = history.length;

        history.push(
            Snapshot({
                rootHashes: rootHashes,
                schemaVersion: schemaVersion,
                createdAt: uint64(block.timestamp)
            })
        );

        emit SnapshotAnchored(msg.sender, index, rootHashes[0], count, schemaVersion);
    }

    /**
     * @notice Grant read authorisation over the caller's snapshots up to and
     *         including the newest one at call time.
     *
     * @dev Grants are pinned to an index rather than being open-ended, so
     *      sharing a report with a doctor today does not silently expose
     *      everything you log next year. Re-granting extends the window.
     *
     *      This authorises; it does not distribute keys. The grantee still needs
     *      the decryption key, handed over off-chain.
     */
    function grantAccess(address[] calldata grantees) external whenNotPaused {
        uint256 count = grantees.length;
        if (count > MAX_GRANTS_PER_CALL) revert TooManyGrants(count, MAX_GRANTS_PER_CALL);

        uint256 historyLength = _snapshots[msg.sender].length;
        if (historyLength == 0) revert NoSnapshots(msg.sender);

        for (uint256 i = 0; i < count; ++i) {
            address grantee = grantees[i];
            if (grantee == address(0)) revert ZeroGrantee();
            if (grantee == msg.sender) revert CannotGrantToSelf();

            _grants[msg.sender][grantee] = historyLength;
            emit AccessGranted(msg.sender, grantee, historyLength - 1);
        }
    }

    /**
     * @notice Withdraw a grantee's authorisation.
     *
     * @dev Honest limitation, stated because the product must state it too:
     *      this removes on-chain authorisation and emits a public record of the
     *      revocation. It cannot retract ciphertext a grantee already fetched,
     *      nor a key they already hold. No contract can.
     */
    function revokeAccess(address[] calldata grantees) external {
        uint256 count = grantees.length;
        if (count > MAX_GRANTS_PER_CALL) revert TooManyGrants(count, MAX_GRANTS_PER_CALL);

        for (uint256 i = 0; i < count; ++i) {
            address grantee = grantees[i];
            delete _grants[msg.sender][grantee];
            emit AccessRevoked(msg.sender, grantee);
        }
    }

    /// @notice Number of snapshots anchored by `owner`.
    function snapshotCount(address owner) external view returns (uint256) {
        return _snapshots[owner].length;
    }

    /// @notice Read one snapshot. Reverts if `index` does not exist.
    function snapshotAt(address owner, uint256 index)
        external
        view
        returns (bytes32[] memory rootHashes, uint32 schemaVersion, uint64 createdAt)
    {
        Snapshot[] storage history = _snapshots[owner];
        if (index >= history.length) revert SnapshotOutOfRange(owner, index);
        Snapshot storage snapshot = history[index];
        return (snapshot.rootHashes, snapshot.schemaVersion, snapshot.createdAt);
    }

    /// @notice The owner's most recent snapshot. Reverts if they have none.
    function latestSnapshot(address owner)
        external
        view
        returns (bytes32[] memory rootHashes, uint32 schemaVersion, uint64 createdAt)
    {
        Snapshot[] storage history = _snapshots[owner];
        uint256 length = history.length;
        if (length == 0) revert NoSnapshots(owner);
        Snapshot storage snapshot = history[length - 1];
        return (snapshot.rootHashes, snapshot.schemaVersion, snapshot.createdAt);
    }

    /**
     * @notice Whether `grantee` is authorised to read `owner`'s snapshot at `index`.
     * @dev An owner always reads their own record without a grant.
     */
    function canRead(address owner, address grantee, uint256 index) external view returns (bool) {
        if (owner == grantee) return index < _snapshots[owner].length;
        uint256 upToPlusOne = _grants[owner][grantee];
        if (upToPlusOne == 0) return false;
        return index < upToPlusOne;
    }

    /// @notice Highest snapshot index `grantee` may read, and whether any grant exists.
    function grantOf(address owner, address grantee)
        external
        view
        returns (bool granted, uint256 upToIndex)
    {
        uint256 upToPlusOne = _grants[owner][grantee];
        if (upToPlusOne == 0) return (false, 0);
        return (true, upToPlusOne - 1);
    }

    /// @notice Halt new anchors and grants during an incident. Reads and revocations stay open.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
