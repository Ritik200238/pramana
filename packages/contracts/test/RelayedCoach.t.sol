// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CoachAgent} from "../src/CoachAgent.sol";

/**
 * @title RelayedCoachTest
 * @notice The relayed mint and evolve, tested from the relayer's side.
 *
 *         A coach is the asset this product asks people to believe they own, so
 *         the question here is narrow: can whoever pays for the transaction end
 *         up owning it, changing it, or replaying it? Every test below is an
 *         attempt to make that happen.
 */
contract RelayedCoachTest is Test {
    CoachAgent internal coach;

    address internal admin = makeAddr("admin");
    address internal relayer = makeAddr("relayer");

    uint256 internal ownerKey = 0xA11CE;
    address internal owner;
    uint256 internal otherKey = 0xB0B;

    bytes32 internal constant MINT_TYPEHASH = keccak256(
        "MintCoach(bytes32 rootHash,bytes32 metadataHash,uint32 schemaVersion,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant EVOLVE_TYPEHASH = keccak256(
        "Evolve(uint256 tokenId,bytes32 rootHash,bytes32 metadataHash,uint32 learnedCount,uint256 nonce,uint256 deadline)"
    );

    bytes32 internal root = keccak256("brain");
    bytes32 internal meta = keccak256("brain-plaintext");

    function setUp() public {
        coach = new CoachAgent(admin, address(0));
        owner = vm.addr(ownerKey);
    }

    // ---------------------------------------------------------------- helpers

    function _domain() internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            coach.eip712Domain();
        return keccak256(
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
    }

    function _sign(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _mintHash(uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return keccak256(abi.encode(MINT_TYPEHASH, root, meta, uint32(1), nonce, deadline));
    }

    function _relayMint(uint256 nonce, uint256 deadline) internal returns (uint256) {
        bytes memory signature = _sign(ownerKey, _mintHash(nonce, deadline));
        vm.prank(relayer);
        return coach.mintCoachFor(owner, root, meta, 1, nonce, deadline, signature);
    }

    // ------------------------------------------------------------------- mint

    function test_relayerMayPayForAnOwnerSignedMint() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 tokenId = _relayMint(1, deadline);

        // The coach belongs to the signer. This is the entire claim.
        assertEq(coach.ownerOf(tokenId), owner);
        assertEq(coach.balanceOf(relayer), 0);
        assertEq(coach.versionCount(tokenId), 1);
    }

    function test_relayerCannotMintToItself() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(otherKey, _mintHash(1, deadline));

        // A signature from somebody else does not become a coach for the relayer.
        vm.prank(relayer);
        vm.expectRevert(CoachAgent.InvalidSignature.selector);
        coach.mintCoachFor(owner, root, meta, 1, 1, deadline, signature);
    }

    function test_relayerCannotSubstituteADifferentBrain() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, _mintHash(1, deadline));

        vm.prank(relayer);
        vm.expectRevert(CoachAgent.InvalidSignature.selector);
        coach.mintCoachFor(owner, keccak256("someone elses brain"), meta, 1, 1, deadline, signature);
    }

    function test_aMintSignatureCannotBeReplayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        _relayMint(7, deadline);

        // Otherwise a relayer could mint an unbounded number of coaches to an
        // owner who asked for one.
        bytes memory signature = _sign(ownerKey, _mintHash(7, deadline));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NonceAlreadyUsed.selector, owner, 7));
        coach.mintCoachFor(owner, root, meta, 1, 7, deadline, signature);
    }

    function test_anExpiredMintSignatureIsWorthless() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, _mintHash(1, deadline));

        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.SignatureExpired.selector, deadline));
        coach.mintCoachFor(owner, root, meta, 1, 1, deadline, signature);
    }

    function test_relayedMintRespectsThePause() public {
        vm.prank(admin);
        coach.pause();

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(ownerKey, _mintHash(1, deadline));

        vm.prank(relayer);
        vm.expectRevert();
        coach.mintCoachFor(owner, root, meta, 1, 1, deadline, signature);
    }

    function test_relayedMintValidatesHashesIdentically() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(MINT_TYPEHASH, bytes32(0), meta, uint32(1), uint256(1), deadline));
        bytes memory signature = _sign(ownerKey, structHash);

        // Both entry points share one implementation precisely so a rule cannot
        // hold on one path and not the other.
        vm.prank(relayer);
        vm.expectRevert(CoachAgent.EmptyRootHash.selector);
        coach.mintCoachFor(owner, bytes32(0), meta, 1, 1, deadline, signature);
    }

    // ----------------------------------------------------------------- evolve

    function _evolveHash(uint256 tokenId, bytes32 newRoot, uint32 learned, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(EVOLVE_TYPEHASH, tokenId, newRoot, keccak256("meta2"), learned, nonce, deadline)
        );
    }

    function test_relayerMayPayForAnOwnerSignedEvolve() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 tokenId = _relayMint(1, deadline);

        bytes32 newRoot = keccak256("brain-v2");
        bytes memory signature = _sign(ownerKey, _evolveHash(tokenId, newRoot, 340, 2, deadline));

        vm.prank(relayer);
        uint256 version =
            coach.evolveFor(owner, tokenId, newRoot, keccak256("meta2"), 340, 2, deadline, signature);

        assertEq(version, 1);
        assertEq(coach.versionCount(tokenId), 2);
        // "My coach has learned 340 things" has to be checkable, not a dashboard number.
        assertEq(coach.ownerOf(tokenId), owner);
    }

    function test_evolveRequiresTheSignerToStillOwnIt() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 tokenId = _relayMint(1, deadline);

        // The owner signs, then transfers the coach away before it is submitted.
        bytes32 newRoot = keccak256("brain-v2");
        bytes memory signature = _sign(ownerKey, _evolveHash(tokenId, newRoot, 1, 2, deadline));

        address recipient = vm.addr(otherKey);
        vm.prank(owner);
        coach.transferFrom(owner, recipient, tokenId);

        // A stale signature must not reach into somebody else's coach.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, owner));
        coach.evolveFor(owner, tokenId, newRoot, keccak256("meta2"), 1, 2, deadline, signature);
    }

    function test_relayerCannotEvolveSomebodyElsesCoach() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 tokenId = _relayMint(1, deadline);

        bytes32 newRoot = keccak256("brain-v2");
        bytes memory forged = _sign(otherKey, _evolveHash(tokenId, newRoot, 1, 2, deadline));

        vm.prank(relayer);
        vm.expectRevert(CoachAgent.InvalidSignature.selector);
        coach.evolveFor(owner, tokenId, newRoot, keccak256("meta2"), 1, 2, deadline, forged);
    }

    function test_anEvolveSignatureCannotBeReplayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 tokenId = _relayMint(1, deadline);

        bytes32 newRoot = keccak256("brain-v2");
        bytes memory signature = _sign(ownerKey, _evolveHash(tokenId, newRoot, 5, 2, deadline));

        vm.prank(relayer);
        coach.evolveFor(owner, tokenId, newRoot, keccak256("meta2"), 5, 2, deadline, signature);

        // Replaying would pad the version history with duplicates and inflate
        // the learned count the product shows the user.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NonceAlreadyUsed.selector, owner, 2));
        coach.evolveFor(owner, tokenId, newRoot, keccak256("meta2"), 5, 2, deadline, signature);
    }

    function test_mintAndEvolveShareOneNonceSpace() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 tokenId = _relayMint(3, deadline);

        // A nonce spent on a mint cannot be reused for an evolve. One space per
        // owner is simpler to reason about than two that can drift apart.
        bytes32 newRoot = keccak256("brain-v2");
        bytes memory signature = _sign(ownerKey, _evolveHash(tokenId, newRoot, 1, 3, deadline));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NonceAlreadyUsed.selector, owner, 3));
        coach.evolveFor(owner, tokenId, newRoot, keccak256("meta2"), 1, 3, deadline, signature);
    }

    function test_nonceUsageIsReadableBeforeSpending() public {
        assertFalse(coach.nonceUsed(owner, 11));

        _relayMint(11, block.timestamp + 1 hours);

        // A relayer needs to know which nonces are spent to choose the next one
        // without paying for a transaction that will revert.
        assertTrue(coach.nonceUsed(owner, 11));
        assertFalse(coach.nonceUsed(vm.addr(otherKey), 11));
    }

    function testFuzz_onlyTheRealOwnerEverMints(uint256 wrongKey) public {
        wrongKey = bound(wrongKey, 1, type(uint128).max);
        vm.assume(wrongKey != ownerKey);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(wrongKey, _mintHash(1, deadline));

        vm.prank(relayer);
        vm.expectRevert(CoachAgent.InvalidSignature.selector);
        coach.mintCoachFor(owner, root, meta, 1, 1, deadline, signature);
    }
}
