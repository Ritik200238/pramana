// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CoachAgent, IOracle} from "../src/CoachAgent.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @dev Stands in for the TEE/ZKP oracle. Toggleable so both paths are tested.
contract MockOracle is IOracle {
    bool public shouldPass = true;

    function setShouldPass(bool value) external {
        shouldPass = value;
    }

    function verifyProof(bytes calldata) external view returns (bool) {
        return shouldPass;
    }
}

contract CoachAgentTest is Test {
    CoachAgent internal coach;
    MockOracle internal oracle;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal dietitian = makeAddr("dietitian");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant ROOT = keccak256("brain-v1");
    bytes32 internal constant META = keccak256("meta-v1");
    bytes internal constant SEALED = hex"deadbeef";
    bytes internal constant PROOF = hex"c0ffee";

    event CoachMinted(
        address indexed owner, uint256 indexed tokenId, bytes32 indexed rootHash, uint32 schemaVersion
    );
    event BrainEvolved(
        uint256 indexed tokenId, uint256 indexed version, bytes32 indexed rootHash, uint32 learnedCount
    );
    event UsageRevoked(uint256 indexed tokenId, address indexed executor);

    function setUp() public {
        oracle = new MockOracle();
        coach = new CoachAgent(admin, address(oracle));
    }

    function _mint(address owner) internal returns (uint256 tokenId) {
        vm.prank(owner);
        tokenId = coach.mintCoach(ROOT, META, 1);
    }

    function _one(address who) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = who;
    }

    // ------------------------------------------------------------------ mint

    function test_mintCreatesOwnedCoachWithBrain() public {
        vm.expectEmit(true, true, true, true);
        emit CoachMinted(alice, 1, ROOT, 1);

        uint256 tokenId = _mint(alice);

        assertEq(coach.ownerOf(tokenId), alice);
        assertEq(coach.versionCount(tokenId), 1);

        (bytes32 root, bytes32 meta, uint32 schema, uint32 learned,) = coach.currentBrain(tokenId);
        assertEq(root, ROOT);
        assertEq(meta, META);
        assertEq(schema, 1);
        assertEq(learned, 0);
    }

    function test_mintRejectsEmptyHashes() public {
        vm.prank(alice);
        vm.expectRevert(CoachAgent.EmptyRootHash.selector);
        coach.mintCoach(bytes32(0), META, 1);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.EmptyMetadataHash.selector);
        coach.mintCoach(ROOT, bytes32(0), 1);
    }

    function test_thereIsNoOperatorMintPath() public {
        // The whole ownership claim rests on this: if we could mint on someone's
        // behalf we could mint a coach they never trained.
        uint256 aliceToken = _mint(alice);

        vm.prank(attacker);
        uint256 attackerToken = coach.mintCoach(keccak256("forged"), keccak256("forged-meta"), 1);

        assertEq(coach.ownerOf(aliceToken), alice);
        assertEq(coach.ownerOf(attackerToken), attacker);
    }

    // ---------------------------------------------------------------- evolve

    function test_evolveAppendsVersionAndKeepsHistory() public {
        uint256 tokenId = _mint(alice);

        vm.expectEmit(true, true, true, true);
        emit BrainEvolved(tokenId, 1, keccak256("brain-v2"), 42);

        vm.prank(alice);
        uint256 version = coach.evolve(tokenId, keccak256("brain-v2"), keccak256("meta-v2"), 42);

        assertEq(version, 1);
        assertEq(coach.versionCount(tokenId), 2);

        // The original is still readable — "my coach has learned N things" must
        // be a verifiable claim, not a number on our dashboard.
        (bytes32 firstRoot,,,,) = coach.brainAt(tokenId, 0);
        assertEq(firstRoot, ROOT);

        (bytes32 latestRoot,,, uint32 learned,) = coach.currentBrain(tokenId);
        assertEq(latestRoot, keccak256("brain-v2"));
        assertEq(learned, 42);
    }

    function test_evolveCarriesSchemaVersionForward() public {
        vm.prank(alice);
        uint256 tokenId = coach.mintCoach(ROOT, META, 7);

        vm.prank(alice);
        coach.evolve(tokenId, keccak256("v2"), keccak256("m2"), 5);

        (,, uint32 schema,,) = coach.currentBrain(tokenId);
        assertEq(schema, 7, "an old brain must stay interpretable");
    }

    function test_onlyOwnerCanEvolve() public {
        uint256 tokenId = _mint(alice);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, attacker));
        coach.evolve(tokenId, keccak256("v2"), keccak256("m2"), 1);
    }

    function test_evolveRejectsEmptyHashes() public {
        uint256 tokenId = _mint(alice);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.EmptyRootHash.selector);
        coach.evolve(tokenId, bytes32(0), META, 1);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.EmptyMetadataHash.selector);
        coach.evolve(tokenId, ROOT, bytes32(0), 1);
    }

    // -------------------------------------------------------------- transfer

    function test_transferMovesOwnershipAndRecordsReEncryptedBrain() public {
        uint256 tokenId = _mint(alice);

        vm.prank(alice);
        coach.transferCoach(bob, tokenId, keccak256("brain-for-bob"), keccak256("meta-for-bob"), SEALED, PROOF);

        assertEq(coach.ownerOf(tokenId), bob);

        (bytes32 root,,,,) = coach.currentBrain(tokenId);
        assertEq(root, keccak256("brain-for-bob"), "the brain must be re-encrypted to the new owner");
        assertEq(coach.versionCount(tokenId), 2, "history survives the transfer");
    }

    function test_transferRequiresAValidProof() public {
        uint256 tokenId = _mint(alice);
        oracle.setShouldPass(false);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.InvalidProof.selector);
        coach.transferCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);

        assertEq(coach.ownerOf(tokenId), alice, "a failed proof must not move the token");
    }

    function test_transferRequiresASealedKey() public {
        uint256 tokenId = _mint(alice);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.InvalidProof.selector);
        coach.transferCoach(bob, tokenId, keccak256("x"), keccak256("y"), "", PROOF);
    }

    function test_transferClearsPreviousAuthorizations() public {
        // A dietitian the seller trusted must not inherit access to the buyer's
        // coach. Carrying grants across a sale would be a silent data leak.
        uint256 tokenId = _mint(alice);

        vm.prank(alice);
        coach.authorizeUsage(tokenId, _one(dietitian));
        assertTrue(coach.canUse(tokenId, dietitian));

        vm.prank(alice);
        coach.transferCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);

        assertFalse(coach.canUse(tokenId, dietitian), "authorisations must not survive a transfer");
    }

    function test_onlyOwnerCanTransfer() public {
        uint256 tokenId = _mint(alice);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, attacker));
        coach.transferCoach(attacker, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
    }

    function test_transferRejectsZeroAddress() public {
        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        vm.expectRevert(CoachAgent.ZeroAddress.selector);
        coach.transferCoach(address(0), tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
    }

    // ----------------------------------------------------------------- clone

    function test_cloneGivesACopyWithoutLosingTheOriginal() public {
        // The family case: your mother gets a coach that already knows the
        // kitchen, and you keep yours.
        vm.prank(alice);
        uint256 tokenId = coach.mintCoach(ROOT, META, 1);
        vm.prank(alice);
        coach.evolve(tokenId, keccak256("trained"), keccak256("trained-meta"), 120);

        vm.prank(alice);
        uint256 cloneId =
            coach.cloneCoach(bob, tokenId, keccak256("for-bob"), keccak256("meta-bob"), SEALED, PROOF);

        assertEq(coach.ownerOf(tokenId), alice, "the original stays with its owner");
        assertEq(coach.ownerOf(cloneId), bob);

        (,,, uint32 learned,) = coach.currentBrain(cloneId);
        assertEq(learned, 120, "a clone inherits what the coach had learned");
    }

    function test_cloneRequiresAValidProof() public {
        uint256 tokenId = _mint(alice);
        oracle.setShouldPass(false);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.InvalidProof.selector);
        coach.cloneCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
    }

    function test_cloneDoesNotCopyAuthorizations() public {
        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        coach.authorizeUsage(tokenId, _one(dietitian));

        vm.prank(alice);
        uint256 cloneId =
            coach.cloneCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);

        assertFalse(coach.canUse(cloneId, dietitian));
        assertTrue(coach.canUse(tokenId, dietitian), "the original's grants are untouched");
    }

    // --------------------------------------------------------- authorisation

    function test_authorizeLetsSomeoneUseWithoutOwning() public {
        uint256 tokenId = _mint(alice);

        vm.prank(alice);
        coach.authorizeUsage(tokenId, _one(dietitian));

        assertTrue(coach.canUse(tokenId, dietitian));
        assertEq(coach.ownerOf(tokenId), alice, "authorisation is not ownership");

        // And an executor cannot evolve or transfer it.
        vm.prank(dietitian);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, dietitian));
        coach.evolve(tokenId, keccak256("x"), keccak256("y"), 1);
    }

    function test_revokeWithdrawsAccess() public {
        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        coach.authorizeUsage(tokenId, _one(dietitian));

        vm.expectEmit(true, true, false, false);
        emit UsageRevoked(tokenId, dietitian);

        vm.prank(alice);
        coach.revokeUsage(tokenId, _one(dietitian));

        assertFalse(coach.canUse(tokenId, dietitian));
    }

    function test_ownerAlwaysCanUseTheirOwnCoach() public {
        uint256 tokenId = _mint(alice);
        assertTrue(coach.canUse(tokenId, alice));
    }

    function test_canUseIsFalseForAnUnknownToken() public view {
        assertFalse(coach.canUse(999, alice));
    }

    function test_cannotAuthorizeYourselfOrZero() public {
        uint256 tokenId = _mint(alice);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.CannotAuthorizeOwner.selector);
        coach.authorizeUsage(tokenId, _one(alice));

        vm.prank(alice);
        vm.expectRevert(CoachAgent.ZeroAddress.selector);
        coach.authorizeUsage(tokenId, _one(address(0)));
    }

    function test_authorizationLoopsAreBounded() public {
        uint256 tokenId = _mint(alice);

        // Read the constant before pranking: a view call inside expectRevert
        // would consume the prank, and the call under test would then be made
        // by the test contract rather than by alice.
        uint256 maximum = coach.MAX_AUTHORIZATIONS_PER_CALL();
        uint256 tooMany = maximum + 1;

        address[] memory many = new address[](tooMany);
        for (uint256 i = 0; i < tooMany; ++i) {
            // casting to 'uint160' is safe because the loop is bounded by
            // MAX_AUTHORIZATIONS_PER_CALL + 1 (33), far below uint160's range.
            // forge-lint: disable-next-line(unsafe-typecast)
            many[i] = address(uint160(i + 1));
        }

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CoachAgent.TooManyAuthorizations.selector, tooMany, maximum)
        );
        coach.authorizeUsage(tokenId, many);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CoachAgent.TooManyAuthorizations.selector, tooMany, maximum)
        );
        coach.revokeUsage(tokenId, many);
    }

    function test_onlyOwnerCanAuthorizeOrRevoke() public {
        uint256 tokenId = _mint(alice);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, attacker));
        coach.authorizeUsage(tokenId, _one(attacker));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, attacker));
        coach.revokeUsage(tokenId, _one(dietitian));
    }

    // --------------------------------------------------------------- pausing

    function test_pauseBlocksMintEvolveTransferAuthorize() public {
        uint256 tokenId = _mint(alice);

        vm.prank(admin);
        coach.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        coach.mintCoach(ROOT, META, 1);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        coach.evolve(tokenId, keccak256("x"), keccak256("y"), 1);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        coach.transferCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
    }

    function test_revocationSurvivesAPause() public {
        // Withdrawing access during an incident is exactly when it must work.
        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        coach.authorizeUsage(tokenId, _one(dietitian));

        vm.prank(admin);
        coach.pause();

        vm.prank(alice);
        coach.revokeUsage(tokenId, _one(dietitian));
        assertFalse(coach.canUse(tokenId, dietitian));
    }

    function test_onlyPauserMayPause() public {
        bytes32 pauserRole = coach.PAUSER_ROLE();

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, pauserRole
            )
        );
        coach.pause();
    }

    function test_unpauseRestoresMinting() public {
        vm.startPrank(admin);
        coach.pause();
        coach.unpause();
        vm.stopPrank();

        uint256 tokenId = _mint(alice);
        assertEq(coach.ownerOf(tokenId), alice);
    }

    // ----------------------------------------------------------------- admin

    function test_adminCanReplaceTheOracle() public {
        MockOracle next = new MockOracle();
        vm.prank(admin);
        coach.setOracle(address(next));
        assertEq(address(coach.oracle()), address(next));
    }

    function test_nonAdminCannotReplaceTheOracle() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, bytes32(0)
            )
        );
        coach.setOracle(address(0));
    }

    function test_transferFailsClosedWithNoOracle() public {
        // If the oracle is unset, re-encryption cannot be verified. Failing
        // closed is the only safe direction: the alternative is moving a brain
        // that may not decrypt for its new owner.
        vm.prank(admin);
        coach.setOracle(address(0));

        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        vm.expectRevert(CoachAgent.NoOracle.selector);
        coach.transferCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
    }

    function test_constructorRejectsZeroAdmin() public {
        vm.expectRevert(CoachAgent.ZeroAddress.selector);
        new CoachAgent(address(0), address(oracle));
    }

    // ----------------------------------------------------------------- views

    function test_unknownTokenReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.UnknownToken.selector, 42));
        coach.currentBrain(42);

        vm.expectRevert(abi.encodeWithSelector(CoachAgent.UnknownToken.selector, 42));
        coach.getMetadataHash(42);
    }

    function test_brainAtRevertsPastTheEnd() public {
        uint256 tokenId = _mint(alice);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.UnknownToken.selector, tokenId));
        coach.brainAt(tokenId, 5);
    }

    function test_metadataHashTracksTheLatestVersion() public {
        uint256 tokenId = _mint(alice);
        assertEq(coach.getMetadataHash(tokenId), META);

        vm.prank(alice);
        coach.evolve(tokenId, keccak256("v2"), keccak256("m2"), 3);
        assertEq(coach.getMetadataHash(tokenId), keccak256("m2"));
    }

    function test_supportsBothInterfaces() public view {
        assertTrue(coach.supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(coach.supportsInterface(0x7965db0b), "AccessControl");
    }

    function test_transferringToSelfIsHarmless() public {
        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        coach.transferCoach(alice, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
        assertEq(coach.ownerOf(tokenId), alice);
    }

    function test_standardErc721TransferStillMovesTheToken() public {
        // Inherited ERC-721 transfer does NOT re-encrypt. It is left available
        // deliberately for marketplace compatibility, and the new owner simply
        // cannot read the brain until the previous owner runs transferCoach.
        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        coach.transferFrom(alice, bob, tokenId);

        assertEq(coach.ownerOf(tokenId), bob);
        (bytes32 root,,,,) = coach.currentBrain(tokenId);
        assertEq(root, ROOT, "the ciphertext is unchanged, so bob cannot decrypt it");
    }

    function test_burnedOrMissingTokenCannotBeEvolved() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.UnknownToken.selector, 77));
        coach.evolve(77, ROOT, META, 1);
    }

    function test_erc721OwnerOfRevertsForUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        coach.ownerOf(99);
    }

    // ------------------------------------------------- remaining guard rails

    function test_cloneRejectsZeroAddressAndEmptyInputs() public {
        uint256 tokenId = _mint(alice);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.ZeroAddress.selector);
        coach.cloneCoach(address(0), tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.EmptyRootHash.selector);
        coach.cloneCoach(bob, tokenId, bytes32(0), keccak256("y"), SEALED, PROOF);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.EmptyMetadataHash.selector);
        coach.cloneCoach(bob, tokenId, keccak256("x"), bytes32(0), SEALED, PROOF);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.InvalidProof.selector);
        coach.cloneCoach(bob, tokenId, keccak256("x"), keccak256("y"), "", PROOF);
    }

    function test_transferRejectsEmptyHashes() public {
        uint256 tokenId = _mint(alice);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.EmptyRootHash.selector);
        coach.transferCoach(bob, tokenId, bytes32(0), keccak256("y"), SEALED, PROOF);

        vm.prank(alice);
        vm.expectRevert(CoachAgent.EmptyMetadataHash.selector);
        coach.transferCoach(bob, tokenId, keccak256("x"), bytes32(0), SEALED, PROOF);
    }

    function test_onlyOwnerCanClone() public {
        uint256 tokenId = _mint(alice);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, attacker));
        coach.cloneCoach(attacker, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
    }

    function test_cloneFailsClosedWithNoOracle() public {
        vm.prank(admin);
        coach.setOracle(address(0));

        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        vm.expectRevert(CoachAgent.NoOracle.selector);
        coach.cloneCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
    }

    function test_transferWithNoPriorAuthorizationsIsFine() public {
        // Exercises the clear-authorisations loop with an empty list.
        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        coach.transferCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
        assertEq(coach.ownerOf(tokenId), bob);
    }

    function test_authorizedExecutorLosesAccessButOthersAreUnaffected() public {
        uint256 tokenId = _mint(alice);
        address helper = makeAddr("helper");

        address[] memory both = new address[](2);
        both[0] = dietitian;
        both[1] = helper;

        vm.prank(alice);
        coach.authorizeUsage(tokenId, both);

        vm.prank(alice);
        coach.revokeUsage(tokenId, _one(dietitian));

        assertFalse(coach.canUse(tokenId, dietitian));
        assertTrue(coach.canUse(tokenId, helper), "revoking one must not revoke the rest");
    }

    function test_pauseBlocksCloneAndAuthorize() public {
        uint256 tokenId = _mint(alice);

        vm.prank(admin);
        coach.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        coach.cloneCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        coach.authorizeUsage(tokenId, _one(dietitian));
    }

    function test_versionLimitStopsUnboundedGrowth() public {
        // A brain that has evolved this many times is a client bug, not a user —
        // but the ceiling has to actually hold, or a loop could grow storage
        // without limit.
        uint256 tokenId = _mint(alice);
        uint256 limit = coach.MAX_VERSIONS();

        vm.startPrank(alice);
        for (uint256 i = coach.versionCount(tokenId); i < limit; ++i) {
            coach.evolve(tokenId, keccak256(abi.encode(i)), keccak256(abi.encode("m", i)), uint32(i));
        }

        vm.expectRevert(abi.encodeWithSelector(CoachAgent.VersionLimitReached.selector, tokenId));
        coach.evolve(tokenId, keccak256("one-too-many"), keccak256("meta"), 1);

        vm.expectRevert(abi.encodeWithSelector(CoachAgent.VersionLimitReached.selector, tokenId));
        coach.transferCoach(bob, tokenId, keccak256("x"), keccak256("y"), SEALED, PROOF);
        vm.stopPrank();

        assertEq(coach.versionCount(tokenId), limit);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_brainRoundTrips(bytes32 root, bytes32 meta, uint32 learned) public {
        vm.assume(root != bytes32(0) && meta != bytes32(0));

        uint256 tokenId = _mint(alice);
        vm.prank(alice);
        coach.evolve(tokenId, root, meta, learned);

        (bytes32 storedRoot, bytes32 storedMeta,, uint32 storedLearned,) = coach.currentBrain(tokenId);
        assertEq(storedRoot, root);
        assertEq(storedMeta, meta);
        assertEq(storedLearned, learned);
    }

    function testFuzz_nonOwnerNeverGainsUse(address stranger) public {
        vm.assume(stranger != alice && stranger != address(0));
        uint256 tokenId = _mint(alice);
        assertFalse(coach.canUse(tokenId, stranger));
    }

    function testFuzz_historyGrowsMonotonically(uint8 steps) public {
        uint256 count = uint256(steps) % 12;
        uint256 tokenId = _mint(alice);

        for (uint256 i = 0; i < count; ++i) {
            vm.prank(alice);
            coach.evolve(tokenId, keccak256(abi.encode(i)), keccak256(abi.encode("m", i)), uint32(i));
        }

        assertEq(coach.versionCount(tokenId), count + 1);
    }
}
