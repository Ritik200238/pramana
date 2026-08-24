// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HealthRecordAnchor} from "../src/HealthRecordAnchor.sol";

/**
 * @title RelayedAnchorTest
 * @notice The relayed path is the one a relayer could abuse, so it is tested
 *         from the relayer's side: every test below is an attempt to make the
 *         contract write something the owner did not sign for.
 *
 *         The property being defended is narrow and worth stating plainly. A
 *         relayer chooses whether to submit and may drop a signature it does
 *         not like. It must not be able to author one, point it at a different
 *         account, change what it says, replay it, or use it after it expired.
 */
contract RelayedAnchorTest is Test {
    HealthRecordAnchor internal anchor;

    address internal admin = makeAddr("admin");
    address internal relayer = makeAddr("relayer");

    uint256 internal ownerKey = 0xA11CE;
    address internal owner;

    uint256 internal otherKey = 0xB0B;

    bytes32 internal constant ANCHOR_TYPEHASH = keccak256(
        "AnchorSnapshot(bytes32 rootHashesHash,uint32 schemaVersion,uint256 nonce,uint256 deadline)"
    );

    function setUp() public {
        anchor = new HealthRecordAnchor(admin);
        owner = vm.addr(ownerKey);
    }

    // ---------------------------------------------------------------- helpers

    function _hashes(bytes32 first) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](1);
        list[0] = first;
    }

    function _digest(
        bytes32[] memory rootHashes,
        uint32 schemaVersion,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ANCHOR_TYPEHASH,
                keccak256(abi.encodePacked(rootHashes)),
                schemaVersion,
                nonce,
                deadline
            )
        );

        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            anchor.eip712Domain();

        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(
        uint256 key,
        bytes32[] memory rootHashes,
        uint32 schemaVersion,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, _digest(rootHashes, schemaVersion, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------ the happy path

    function test_relayerMayPayForAnOwnerSignedAnchor() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, roots, 1, 7, deadline);

        vm.prank(relayer);
        uint256 index = anchor.anchorSnapshotFor(owner, roots, 1, 7, deadline, signature);

        assertEq(index, 0);
        // The snapshot belongs to the signer, never to whoever paid.
        assertEq(anchor.snapshotCount(owner), 1);
        assertEq(anchor.snapshotCount(relayer), 0);
    }

    function test_relayedAndDirectAnchorsShareOneHistory() public {
        bytes32[] memory first = _hashes(keccak256("one"));
        vm.prank(owner);
        anchor.anchorSnapshot(first, 1);

        bytes32[] memory second = _hashes(keccak256("two"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, second, 1, 1, deadline);

        vm.prank(relayer);
        uint256 index = anchor.anchorSnapshotFor(owner, second, 1, 1, deadline, signature);

        // Moving who pays must not fork the timeline.
        assertEq(index, 1);
        assertEq(anchor.snapshotCount(owner), 2);
    }

    // ------------------------------------------------------------------ attacks

    function test_relayerCannotForgeASignature() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;

        // Signed by somebody else entirely, presented as the owner's.
        bytes memory signature = _sign(otherKey, roots, 1, 1, deadline);

        vm.prank(relayer);
        vm.expectRevert(HealthRecordAnchor.InvalidSignature.selector);
        anchor.anchorSnapshotFor(owner, roots, 1, 1, deadline, signature);
    }

    function test_relayerCannotRedirectAnAnchorToAnotherAccount() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, roots, 1, 1, deadline);

        // The owner signed for their own record; naming a different one must
        // fail rather than write somebody else's history.
        vm.prank(relayer);
        vm.expectRevert(HealthRecordAnchor.InvalidSignature.selector);
        anchor.anchorSnapshotFor(vm.addr(otherKey), roots, 1, 1, deadline, signature);
    }

    function test_relayerCannotAlterWhatWasSigned() public {
        bytes32[] memory signed = _hashes(keccak256("what the user wrote"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, signed, 1, 1, deadline);

        bytes32[] memory swapped = _hashes(keccak256("what the relayer prefers"));

        vm.prank(relayer);
        vm.expectRevert(HealthRecordAnchor.InvalidSignature.selector);
        anchor.anchorSnapshotFor(owner, swapped, 1, 1, deadline, signature);
    }

    function test_relayerCannotChangeTheSchemaVersion() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, roots, 1, 1, deadline);

        vm.prank(relayer);
        vm.expectRevert(HealthRecordAnchor.InvalidSignature.selector);
        anchor.anchorSnapshotFor(owner, roots, 2, 1, deadline, signature);
    }

    function test_aSignatureCannotBeReplayed() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, roots, 1, 42, deadline);

        vm.prank(relayer);
        anchor.anchorSnapshotFor(owner, roots, 1, 42, deadline, signature);

        // Without the nonce, a relayer could resubmit the same anchor forever
        // and pad somebody's history with duplicates.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(HealthRecordAnchor.NonceAlreadyUsed.selector, owner, 42)
        );
        anchor.anchorSnapshotFor(owner, roots, 1, 42, deadline, signature);
    }

    function test_anExpiredSignatureIsWorthless() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, roots, 1, 1, deadline);

        vm.warp(deadline + 1);

        // A relayer that sat on a signature must not be able to publish it
        // long after the user asked for it.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(HealthRecordAnchor.SignatureExpired.selector, deadline)
        );
        anchor.anchorSnapshotFor(owner, roots, 1, 1, deadline, signature);
    }

    function test_aSignatureIsBoundToThisContractAndChain() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, roots, 1, 1, deadline);

        // EIP-712 binds the domain, so the same signature is meaningless to a
        // second deployment. Without that, a signature gathered on testnet
        // would anchor on mainnet.
        HealthRecordAnchor other = new HealthRecordAnchor(admin);

        vm.prank(relayer);
        vm.expectRevert(HealthRecordAnchor.InvalidSignature.selector);
        other.anchorSnapshotFor(owner, roots, 1, 1, deadline, signature);
    }

    function test_aGarbageSignatureIsRejected() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(relayer);
        vm.expectRevert();
        anchor.anchorSnapshotFor(owner, roots, 1, 1, deadline, hex"deadbeef");
    }

    function test_relayedAnchorsRespectThePause() public {
        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, roots, 1, 1, deadline);

        vm.prank(admin);
        anchor.pause();

        // An incident switch that only covered the direct path would not be one.
        vm.prank(relayer);
        vm.expectRevert();
        anchor.anchorSnapshotFor(owner, roots, 1, 1, deadline, signature);
    }

    function test_relayedAnchorsValidateFragmentsIdentically() public {
        bytes32[] memory empty = new bytes32[](0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, empty, 1, 1, deadline);

        // Both entry points share one implementation precisely so that a
        // validation rule cannot exist on one path and not the other.
        vm.prank(relayer);
        vm.expectRevert(HealthRecordAnchor.NoFragments.selector);
        anchor.anchorSnapshotFor(owner, empty, 1, 1, deadline, signature);
    }

    function test_nonceUsageIsReadableBeforeSpending() public {
        assertFalse(anchor.nonceUsed(owner, 5));

        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, roots, 1, 5, deadline);

        vm.prank(relayer);
        anchor.anchorSnapshotFor(owner, roots, 1, 5, deadline, signature);

        // A relayer needs to know which nonces are spent to pick the next one
        // without wasting a transaction.
        assertTrue(anchor.nonceUsed(owner, 5));
    }

    function testFuzz_onlyTheRealSignerEverWrites(uint256 wrongKey) public {
        wrongKey = bound(wrongKey, 1, type(uint128).max);
        vm.assume(wrongKey != ownerKey);

        bytes32[] memory roots = _hashes(keccak256("snapshot"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(wrongKey, roots, 1, 1, deadline);

        vm.prank(relayer);
        vm.expectRevert(HealthRecordAnchor.InvalidSignature.selector);
        anchor.anchorSnapshotFor(owner, roots, 1, 1, deadline, signature);
    }
}
