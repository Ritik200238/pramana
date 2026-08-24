// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CoachAgent} from "../src/CoachAgent.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title ConformanceTest
 * @notice What this contract claims to be, checked against what it is.
 *
 *         `CoachAgent` was described as an ERC-7857 token. Compared against the
 *         published interface, it is not one: the standard specifies
 *         `transfer(from, to, tokenId, sealedKey, proof)`,
 *         `clone(to, tokenId, sealedKey, proof)` and
 *         `authorizeUsage(tokenId, executor, permissions)`, and this contract
 *         implements none of those signatures.
 *
 *         It follows the design — encrypted metadata, transfer by re-encryption
 *         under a sealed key, admitted only against an oracle-verified proof —
 *         and the difference is deliberate. The standard's `transfer` carries
 *         the new ciphertext location inside `proof`, decoded by the oracle. No
 *         oracle is deployed and that proof encoding is not specified anywhere
 *         we can read, so adopting the signatures would mean inventing a format
 *         and calling the result conformant.
 *
 *         These tests exist so the claim and the code cannot drift apart again.
 *         A standard half-implemented is worse than one honestly not
 *         implemented, because the first is discovered by somebody's tooling
 *         failing rather than by reading.
 */
contract ConformanceTest is Test {
    CoachAgent internal coach;
    address internal admin = makeAddr("admin");

    /// @dev ERC-165 identifiers, from the standards themselves.
    bytes4 internal constant ERC721_ID = type(IERC721).interfaceId;
    bytes4 internal constant ERC165_ID = type(IERC165).interfaceId;

    function setUp() public {
        coach = new CoachAgent(admin, address(0));
    }

    function test_isAGenuineERC721() public view {
        // This one is claimed and must hold: wallets, explorers and marketplaces
        // all key off it.
        assertTrue(coach.supportsInterface(ERC721_ID));
        assertTrue(coach.supportsInterface(ERC165_ID));
    }

    function test_doesNotAdvertiseAnInterfaceItDoesNotImplement() public view {
        // The ERC-7857 interface id, computed from the published signatures:
        //   transfer(address,address,uint256,bytes,bytes)
        //   clone(address,uint256,bytes,bytes)
        //   authorizeUsage(uint256,address,bytes)
        bytes4 erc7857 = bytes4(keccak256("transfer(address,address,uint256,bytes,bytes)"))
            ^ bytes4(keccak256("clone(address,uint256,bytes,bytes)"))
            ^ bytes4(keccak256("authorizeUsage(uint256,address,bytes)"));

        // Claiming it here would make tooling call functions that do not exist.
        assertFalse(coach.supportsInterface(erc7857));
    }

    function test_theStandardSignaturesAreGenuinelyAbsent() public view {
        // Asserted by selector rather than by reading the source, so this stays
        // true no matter how the file is reorganised.
        bytes4[3] memory standard = [
            bytes4(keccak256("transfer(address,address,uint256,bytes,bytes)")),
            bytes4(keccak256("clone(address,uint256,bytes,bytes)")),
            bytes4(keccak256("authorizeUsage(uint256,address,bytes)"))
        ];

        for (uint256 i = 0; i < standard.length; ++i) {
            (bool ok,) = address(coach).staticcall(abi.encodeWithSelector(standard[i]));
            // A missing function reverts. If one of these ever answers, the
            // contract has started implementing the standard and the
            // documentation above needs rewriting.
            assertFalse(ok, "a standard signature exists; update the claim");
        }
    }

    function test_theSemanticsTheStandardIsAboutArePresent() public {
        /*
         * Existence is proved by triggering each function's own error.
         *
         * A first attempt compared revert data against a bare selector call,
         * which proved nothing: calldata with no arguments fails ABI decoding,
         * so a function that exists and one that does not both revert the same
         * way. Reaching a contract-specific error means the function ran.
         */
        address owner = makeAddr("owner");
        vm.prank(owner);
        uint256 tokenId = coach.mintCoach(keccak256("root"), keccak256("meta"), 1);

        address stranger = makeAddr("stranger");

        // Each reverts with its own guard, which only a real function can do.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, stranger));
        coach.transferCoach(stranger, tokenId, keccak256("r"), keccak256("m"), "sealed", "proof");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, stranger));
        coach.cloneCoach(stranger, tokenId, keccak256("r"), keccak256("m"), "sealed", "proof");

        address[] memory executors = new address[](1);
        executors[0] = stranger;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CoachAgent.NotOwner.selector, tokenId, stranger));
        coach.authorizeUsage(tokenId, executors);
    }

    function test_transfersRequireAnOracleBeforeTheyCanHappen() public {
        // With no verifier deployed, a sealed-key transfer must refuse rather
        // than accept an unverified proof. That refusal is the reason the
        // standard exists, whatever the function is called.
        address owner = makeAddr("owner");
        vm.prank(owner);
        uint256 tokenId = coach.mintCoach(keccak256("root"), keccak256("meta"), 1);

        vm.prank(owner);
        vm.expectRevert(CoachAgent.NoOracle.selector);
        coach.transferCoach(
            makeAddr("recipient"), tokenId, keccak256("root2"), keccak256("meta2"), "sealed", "proof"
        );
    }
}
