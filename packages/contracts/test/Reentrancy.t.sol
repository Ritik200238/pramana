// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CoachAgent, IOracle} from "../src/CoachAgent.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * Minting hands control to the recipient. What it must not hand over is a
 * half-built coach.
 *
 * `_safeMint` calls `onERC721Received` on the receiving contract, which is
 * arbitrary code running in the middle of our function. Both mint paths used to
 * write the brain *after* that call, so for the length of the callback a token
 * existed that owned nothing: `currentBrain` reverted on an empty array,
 * `versionCount` read zero, and anything built on "a coach has a brain" was
 * wrong.
 *
 * Slither found it as reentrancy-no-eth on `cloneCoach`. `_mintCoach` had the
 * identical shape and was not flagged, which is the useful reminder that a
 * static analyser reports what it reaches rather than everything that is there.
 *
 * These tests reenter on purpose and read the state a real attacker would.
 */
contract ReentrantOracle is IOracle {
    function verifyProof(bytes calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * A recipient that looks at the coach it is being given, from inside the
 * callback, before the transaction that creates it has finished.
 */
contract PryingReceiver is IERC721Receiver {
    CoachAgent public immutable coach;

    /** What was true during the callback, recorded for the test to inspect. */
    uint256 public seenVersionCount;
    bytes32 public seenRootHash;
    address public seenOwner;
    bool public brainWasReadable;
    bool public reentered;

    constructor(CoachAgent coach_) {
        coach = coach_;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        reentered = true;
        seenOwner = coach.ownerOf(tokenId);
        seenVersionCount = coach.versionCount(tokenId);

        // Reading the brain is what breaks if the push has not happened yet.
        try coach.currentBrain(tokenId) returns (bytes32 rootHash, bytes32, uint32, uint32, uint64) {
            brainWasReadable = true;
            seenRootHash = rootHash;
        } catch {
            brainWasReadable = false;
        }

        return IERC721Receiver.onERC721Received.selector;
    }
}

contract ReentrancyTest is Test {
    CoachAgent internal coach;
    ReentrantOracle internal oracle;

    bytes32 internal constant ROOT = keccak256("brain-v1");
    bytes32 internal constant META = keccak256("meta-v1");
    bytes internal constant SEALED = hex"deadbeef";
    bytes internal constant PROOF = hex"c0ffee";

    address internal admin = makeAddr("admin");

    function setUp() public {
        oracle = new ReentrantOracle();
        coach = new CoachAgent(admin, address(oracle));
    }

    function test_MintedCoachHasItsBrainDuringTheCallback() public {
        PryingReceiver receiver = new PryingReceiver(coach);

        vm.prank(address(receiver));
        uint256 tokenId = coach.mintCoach(ROOT, META, 1);

        assertTrue(receiver.reentered(), "the callback must actually have run");

        // The whole point: a coach handed to somebody is complete when they get
        // it, not a moment later.
        assertTrue(receiver.brainWasReadable(), "the brain must exist before the token is handed over");
        assertEq(receiver.seenVersionCount(), 1, "version count must already be one");
        assertEq(receiver.seenRootHash(), ROOT, "and it must be the right brain");
        assertEq(receiver.seenOwner(), address(receiver));

        // And it is still true afterwards.
        assertEq(coach.versionCount(tokenId), 1);
    }

    function test_ClonedCoachHasItsBrainDuringTheCallback() public {
        address owner = makeAddr("owner");
        vm.prank(owner);
        uint256 sourceId = coach.mintCoach(ROOT, META, 3);

        PryingReceiver receiver = new PryingReceiver(coach);

        bytes32 newRoot = keccak256("brain-cloned");
        bytes32 newMeta = keccak256("meta-cloned");

        vm.prank(owner);
        uint256 clonedId = coach.cloneCoach(address(receiver), sourceId, newRoot, newMeta, SEALED, PROOF);

        assertTrue(receiver.reentered(), "the callback must actually have run");
        assertTrue(receiver.brainWasReadable(), "a cloned coach must arrive complete");
        assertEq(receiver.seenVersionCount(), 1);
        assertEq(receiver.seenRootHash(), newRoot, "the clone carries its own brain, not the source's");

        // The source is untouched, which is the other thing a half-built clone
        // could have disturbed.
        (bytes32 sourceRoot,,, uint32 learned,) = coach.currentBrain(sourceId);
        assertEq(sourceRoot, ROOT);
        assertEq(coach.versionCount(sourceId), 1);
        assertEq(coach.ownerOf(clonedId), address(receiver));
        assertEq(learned, 0);
    }

    /**
     * The id is taken before the callback, so a recipient that mints again from
     * inside it cannot collide with the token being handed to it.
     */
    function test_ReentrantMintCannotCollideWithTheTokenBeingMinted() public {
        PryingReceiver receiver = new PryingReceiver(coach);

        vm.prank(address(receiver));
        uint256 first = coach.mintCoach(ROOT, META, 1);

        address other = makeAddr("other");
        vm.prank(other);
        uint256 second = coach.mintCoach(keccak256("another"), META, 1);

        assertTrue(second != first, "ids must never be reused");
        assertEq(coach.ownerOf(first), address(receiver));
        assertEq(coach.ownerOf(second), other);
    }
}
