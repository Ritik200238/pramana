// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {HealthRecordAnchor} from "../src/HealthRecordAnchor.sol";
import {CoachAgent} from "../src/CoachAgent.sol";

/**
 * @title Deploy
 * @notice Deploys both contracts to 0G Chain.
 *
 * Usage:
 *   forge script script/Deploy.s.sol:Deploy --rpc-url og_testnet --broadcast
 *   forge script script/Deploy.s.sol:Deploy --rpc-url og_mainnet --broadcast
 *
 * Required environment:
 *   PRIVATE_KEY  deployer key
 *   ADMIN        address receiving DEFAULT_ADMIN_ROLE and PAUSER_ROLE
 *
 * Optional environment:
 *   ORACLE       ERC-7857 transfer-proof verifier. Zero until one is deployed,
 *                which disables sealed-key transfers rather than accepting
 *                unverified ones.
 *
 * @dev ADMIN is required explicitly rather than defaulting to the deployer.
 *      Silently handing pause authority to whichever hot key happened to run
 *      the deployment is how that authority ends up somewhere nobody intended.
 */
contract Deploy is Script {
    /// 0G Galileo testnet. Some older docs still say 16601; the canonical value is 16602.
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;

    function run() external returns (HealthRecordAnchor anchor, CoachAgent coach) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN");
        address oracle = vm.envOr("ORACLE", address(0));

        require(admin != address(0), "ADMIN must not be the zero address");

        uint256 chainId = block.chainid;
        require(
            chainId == OG_TESTNET_CHAIN_ID || chainId == OG_MAINNET_CHAIN_ID,
            "Refusing to deploy: not a recognised 0G chain id"
        );

        address deployer = vm.addr(deployerKey);
        console.log("Chain id :", chainId);
        console.log("Deployer :", deployer);
        console.log("Admin    :", admin);
        console.log("Oracle   :", oracle);

        vm.startBroadcast(deployerKey);
        anchor = new HealthRecordAnchor(admin);
        coach = new CoachAgent(admin, oracle);
        vm.stopBroadcast();

        console.log("HealthRecordAnchor:", address(anchor));
        console.log("CoachAgent        :", address(coach));

        // Fail the run rather than leave a misconfigured contract on chain.
        // Every one of these is cheap here and unfixable later.
        require(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), admin), "anchor: admin role not set");
        require(anchor.hasRole(anchor.PAUSER_ROLE(), admin), "anchor: pauser role not set");
        require(coach.hasRole(coach.DEFAULT_ADMIN_ROLE(), admin), "coach: admin role not set");
        require(coach.hasRole(coach.PAUSER_ROLE(), admin), "coach: pauser role not set");

        // The deployer must hold nothing. A hot key that keeps pause authority
        // after the deployment is a standing risk for no benefit.
        require(
            deployer == admin || !anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), deployer),
            "anchor: deployer retained admin"
        );
        require(
            deployer == admin || !coach.hasRole(coach.DEFAULT_ADMIN_ROLE(), deployer),
            "coach: deployer retained admin"
        );
    }
}
