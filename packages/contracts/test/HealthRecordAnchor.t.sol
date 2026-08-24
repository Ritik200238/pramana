// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HealthRecordAnchor} from "../src/HealthRecordAnchor.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract HealthRecordAnchorTest is Test {
    HealthRecordAnchor internal anchor;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal doctor = makeAddr("doctor");
    address internal attacker = makeAddr("attacker");

    event SnapshotAnchored(
        address indexed owner,
        uint256 indexed index,
        bytes32 indexed firstRootHash,
        uint256 fragmentCount,
        uint32 schemaVersion
    );
    event AccessGranted(address indexed owner, address indexed grantee, uint256 upToIndex);
    event AccessRevoked(address indexed owner, address indexed grantee);

    function setUp() public {
        anchor = new HealthRecordAnchor(admin);
    }

    // ---------------------------------------------------------------- helpers

    function _hashes(bytes32 first) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](1);
        list[0] = first;
    }

    function _one(address who) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = who;
    }

    function _anchorOne(address owner, bytes32 root) internal returns (uint256 index) {
        vm.prank(owner);
        index = anchor.anchorSnapshot(_hashes(root), 1);
    }

    /// @dev Distinct non-zero addresses for exercising the array bounds.
    function _distinctGrantees(uint256 count) internal pure returns (address[] memory list) {
        list = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            // casting to 'uint160' is safe because the loop is bounded by
            // MAX_GRANTS_PER_CALL + 1 (33), far below uint160's range.
            // forge-lint: disable-next-line(unsafe-typecast)
            list[i] = address(uint160(i + 1));
        }
    }

    // ------------------------------------------------------------- anchoring

    function test_anchorStoresSnapshotAndEmits() public {
        bytes32 root = keccak256("snapshot-1");

        vm.expectEmit(true, true, true, true);
        emit SnapshotAnchored(alice, 0, root, 1, 1);

        vm.prank(alice);
        uint256 index = anchor.anchorSnapshot(_hashes(root), 1);

        assertEq(index, 0);
        assertEq(anchor.snapshotCount(alice), 1);

        (bytes32[] memory stored, uint32 schema, uint64 createdAt) = anchor.snapshotAt(alice, 0);
        assertEq(stored.length, 1);
        assertEq(stored[0], root);
        assertEq(schema, 1);
        assertEq(createdAt, uint64(block.timestamp));
    }

    function test_historyIsAppendOnly() public {
        _anchorOne(alice, keccak256("s1"));
        _anchorOne(alice, keccak256("s2"));
        _anchorOne(alice, keccak256("s3"));

        assertEq(anchor.snapshotCount(alice), 3);

        (bytes32[] memory first,,) = anchor.snapshotAt(alice, 0);
        (bytes32[] memory last,,) = anchor.latestSnapshot(alice);
        assertEq(first[0], keccak256("s1"), "history must not be mutated");
        assertEq(last[0], keccak256("s3"));
    }

    function test_multiFragmentSnapshotRoundTrips() public {
        bytes32[] memory roots = new bytes32[](3);
        roots[0] = keccak256("f0");
        roots[1] = keccak256("f1");
        roots[2] = keccak256("f2");

        vm.prank(alice);
        anchor.anchorSnapshot(roots, 2);

        (bytes32[] memory stored, uint32 schema,) = anchor.latestSnapshot(alice);
        assertEq(stored.length, 3);
        assertEq(stored[2], keccak256("f2"), "fragment order must be preserved");
        assertEq(schema, 2);
    }

    function test_revertsOnEmptyFragmentList() public {
        vm.prank(alice);
        vm.expectRevert(HealthRecordAnchor.NoFragments.selector);
        anchor.anchorSnapshot(new bytes32[](0), 1);
    }

    function test_revertsOnZeroRootHash() public {
        bytes32[] memory roots = new bytes32[](2);
        roots[0] = keccak256("ok");
        roots[1] = bytes32(0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HealthRecordAnchor.EmptyRootHash.selector, 1));
        anchor.anchorSnapshot(roots, 1);
    }

    function test_revertsAboveFragmentCap() public {
        uint256 tooMany = anchor.MAX_FRAGMENTS() + 1;
        bytes32[] memory roots = new bytes32[](tooMany);
        for (uint256 i = 0; i < tooMany; ++i) {
            roots[i] = keccak256(abi.encode(i));
        }

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                HealthRecordAnchor.TooManyFragments.selector, tooMany, anchor.MAX_FRAGMENTS()
            )
        );
        anchor.anchorSnapshot(roots, 1);
    }

    function test_snapshotsAreIsolatedPerOwner() public {
        _anchorOne(alice, keccak256("alice"));
        assertEq(anchor.snapshotCount(bob), 0, "bob must not inherit alice's history");

        vm.expectRevert(abi.encodeWithSelector(HealthRecordAnchor.NoSnapshots.selector, bob));
        anchor.latestSnapshot(bob);
    }

    function test_snapshotAtRevertsOutOfRange() public {
        _anchorOne(alice, keccak256("s1"));
        vm.expectRevert(
            abi.encodeWithSelector(HealthRecordAnchor.SnapshotOutOfRange.selector, alice, 5)
        );
        anchor.snapshotAt(alice, 5);
    }

    // ------------------------------------------------------- access control

    function test_grantAllowsReadUpToCurrentIndex() public {
        _anchorOne(alice, keccak256("s1"));
        _anchorOne(alice, keccak256("s2"));

        vm.expectEmit(true, true, false, true);
        emit AccessGranted(alice, doctor, 1);

        vm.prank(alice);
        anchor.grantAccess(_one(doctor));

        assertTrue(anchor.canRead(alice, doctor, 0));
        assertTrue(anchor.canRead(alice, doctor, 1));

        (bool granted, uint256 upTo) = anchor.grantOf(alice, doctor);
        assertTrue(granted);
        assertEq(upTo, 1);
    }

    function test_grantDoesNotExtendToFutureSnapshots() public {
        // This is the point of pinning grants to an index: sharing a report with
        // a doctor today must not silently expose everything logged next year.
        _anchorOne(alice, keccak256("s1"));

        vm.prank(alice);
        anchor.grantAccess(_one(doctor));

        _anchorOne(alice, keccak256("s2-future"));

        assertTrue(anchor.canRead(alice, doctor, 0));
        assertFalse(anchor.canRead(alice, doctor, 1), "future snapshots must stay private");
    }

    function test_regrantExtendsTheWindow() public {
        _anchorOne(alice, keccak256("s1"));
        vm.prank(alice);
        anchor.grantAccess(_one(doctor));

        _anchorOne(alice, keccak256("s2"));
        vm.prank(alice);
        anchor.grantAccess(_one(doctor));

        assertTrue(anchor.canRead(alice, doctor, 1));
    }

    function test_revokeRemovesAuthorisation() public {
        _anchorOne(alice, keccak256("s1"));
        vm.prank(alice);
        anchor.grantAccess(_one(doctor));
        assertTrue(anchor.canRead(alice, doctor, 0));

        vm.expectEmit(true, true, false, false);
        emit AccessRevoked(alice, doctor);

        vm.prank(alice);
        anchor.revokeAccess(_one(doctor));

        assertFalse(anchor.canRead(alice, doctor, 0));
        (bool granted,) = anchor.grantOf(alice, doctor);
        assertFalse(granted);
    }

    function test_ownerAlwaysReadsOwnRecordWithoutAGrant() public {
        _anchorOne(alice, keccak256("s1"));
        assertTrue(anchor.canRead(alice, alice, 0));
        assertFalse(anchor.canRead(alice, alice, 1), "but only snapshots that exist");
    }

    function test_cannotGrantBeforeAnchoringAnything() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HealthRecordAnchor.NoSnapshots.selector, alice));
        anchor.grantAccess(_one(doctor));
    }

    function test_cannotGrantToSelfOrZero() public {
        _anchorOne(alice, keccak256("s1"));

        vm.prank(alice);
        vm.expectRevert(HealthRecordAnchor.CannotGrantToSelf.selector);
        anchor.grantAccess(_one(alice));

        vm.prank(alice);
        vm.expectRevert(HealthRecordAnchor.ZeroGrantee.selector);
        anchor.grantAccess(_one(address(0)));
    }

    function test_grantLoopIsBounded() public {
        _anchorOne(alice, keccak256("s1"));
        uint256 tooMany = anchor.MAX_GRANTS_PER_CALL() + 1;
        address[] memory grantees = _distinctGrantees(tooMany);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                HealthRecordAnchor.TooManyGrants.selector, tooMany, anchor.MAX_GRANTS_PER_CALL()
            )
        );
        anchor.grantAccess(grantees);
    }

    function test_revokeLoopIsBounded() public {
        // Revocation takes the same unbounded-array precaution as granting.
        uint256 tooMany = anchor.MAX_GRANTS_PER_CALL() + 1;
        address[] memory grantees = _distinctGrantees(tooMany);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                HealthRecordAnchor.TooManyGrants.selector, tooMany, anchor.MAX_GRANTS_PER_CALL()
            )
        );
        anchor.revokeAccess(grantees);
    }

    function test_revokingSomethingNeverGrantedIsHarmless() public {
        // Idempotent by design: a client retrying a revoke must not revert.
        vm.prank(alice);
        anchor.revokeAccess(_one(doctor));
        assertFalse(anchor.canRead(alice, doctor, 0));
    }

    // --------------------------------------------------------- adversarial

    function test_attackerCannotAnchorForSomeoneElse() public {
        // There is no operator path by design. The attacker can only ever write
        // to their own history, never to alice's.
        vm.prank(attacker);
        anchor.anchorSnapshot(_hashes(keccak256("forged")), 1);

        assertEq(anchor.snapshotCount(alice), 0, "alice's history must be untouched");
        assertEq(anchor.snapshotCount(attacker), 1);
    }

    function test_attackerCannotGrantThemselvesAccess() public {
        _anchorOne(alice, keccak256("s1"));

        // The attacker granting "access" only ever writes into their own grant
        // map, which is meaningless without snapshots of their own.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(HealthRecordAnchor.NoSnapshots.selector, attacker));
        anchor.grantAccess(_one(attacker));

        assertFalse(anchor.canRead(alice, attacker, 0));
    }

    function test_attackerCannotRevokeSomeoneElsesGrant() public {
        _anchorOne(alice, keccak256("s1"));
        vm.prank(alice);
        anchor.grantAccess(_one(doctor));

        vm.prank(attacker);
        anchor.revokeAccess(_one(doctor));

        assertTrue(anchor.canRead(alice, doctor, 0), "only the owner may revoke their own grants");
    }

    function test_adminHasNoAuthorityOverUserRecords() public {
        // The admin can pause. It cannot read, write, grant, or revoke.
        _anchorOne(alice, keccak256("s1"));

        vm.prank(admin);
        anchor.revokeAccess(_one(doctor));

        vm.prank(admin);
        anchor.anchorSnapshot(_hashes(keccak256("admin-own")), 1);

        assertEq(anchor.snapshotCount(alice), 1, "admin must not be able to alter alice's history");
        (bytes32[] memory stored,,) = anchor.snapshotAt(alice, 0);
        assertEq(stored[0], keccak256("s1"));
    }

    // --------------------------------------------------------------- pausing

    function test_pauseBlocksAnchoringAndGranting() public {
        _anchorOne(alice, keccak256("s1"));

        vm.prank(admin);
        anchor.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        anchor.anchorSnapshot(_hashes(keccak256("s2")), 1);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        anchor.grantAccess(_one(doctor));
    }

    function test_pauseDoesNotBlockRevocationOrReads() public {
        // Revocation must survive a pause: a user withdrawing access during an
        // incident is exactly when they most need it to work.
        _anchorOne(alice, keccak256("s1"));
        vm.prank(alice);
        anchor.grantAccess(_one(doctor));

        vm.prank(admin);
        anchor.pause();

        vm.prank(alice);
        anchor.revokeAccess(_one(doctor));
        assertFalse(anchor.canRead(alice, doctor, 0));

        assertEq(anchor.snapshotCount(alice), 1, "reads stay available while paused");
    }

    function test_onlyPauserMayPause() public {
        // Read the role before pranking: a view call would otherwise consume
        // the prank and pause() would be invoked by the test contract itself.
        bytes32 pauserRole = anchor.PAUSER_ROLE();

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, pauserRole
            )
        );
        anchor.pause();

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, pauserRole
            )
        );
        anchor.unpause();
    }

    function test_unpauseRestoresAnchoring() public {
        vm.startPrank(admin);
        anchor.pause();
        anchor.unpause();
        vm.stopPrank();

        vm.prank(alice);
        anchor.anchorSnapshot(_hashes(keccak256("s1")), 1);
        assertEq(anchor.snapshotCount(alice), 1);
    }

    function test_constructorRejectsZeroAdmin() public {
        vm.expectRevert(HealthRecordAnchor.ZeroGrantee.selector);
        new HealthRecordAnchor(address(0));
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_anchorPreservesArbitraryRoots(bytes32 root, uint32 schema) public {
        vm.assume(root != bytes32(0));

        vm.prank(alice);
        anchor.anchorSnapshot(_hashes(root), schema);

        (bytes32[] memory stored, uint32 storedSchema,) = anchor.latestSnapshot(alice);
        assertEq(stored[0], root);
        assertEq(storedSchema, schema);
    }

    function testFuzz_grantNeverLeaksFutureSnapshots(uint8 before, uint8 afterGrant) public {
        uint256 beforeCount = uint256(before) % 8 + 1;
        uint256 afterCount = uint256(afterGrant) % 8;

        for (uint256 i = 0; i < beforeCount; ++i) {
            _anchorOne(alice, keccak256(abi.encode("before", i)));
        }

        vm.prank(alice);
        anchor.grantAccess(_one(doctor));

        for (uint256 i = 0; i < afterCount; ++i) {
            _anchorOne(alice, keccak256(abi.encode("after", i)));
        }

        for (uint256 i = 0; i < beforeCount; ++i) {
            assertTrue(anchor.canRead(alice, doctor, i), "granted range must remain readable");
        }
        for (uint256 i = beforeCount; i < beforeCount + afterCount; ++i) {
            assertFalse(anchor.canRead(alice, doctor, i), "post-grant snapshots must stay private");
        }
    }

    function testFuzz_nonOwnerNeverGainsAccess(address stranger) public {
        vm.assume(stranger != alice && stranger != address(0));

        _anchorOne(alice, keccak256("s1"));
        assertFalse(anchor.canRead(alice, stranger, 0));
    }
}
