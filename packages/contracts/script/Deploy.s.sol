// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {HealthRecordAnchor} from "../src/HealthRecordAnchor.sol";

/**
 * @title Deploy
 * @notice Deploys HealthRecordAnchor to 0G Chain.
 *
 * Usage:
 *   forge script script/Deploy.s.sol:Deploy --rpc-url og_testnet --broadcast
 *   forge script script/Deploy.s.sol:Deploy --rpc-url og_mainnet --broadcast
 *
 * Required environment:
 *   PRIVATE_KEY  deployer key
 *   ADMIN        address receiving DEFAULT_ADMIN_ROLE and PAUSER_ROLE
 *
 * @dev ADMIN is required explicitly rather than defaulting to the deployer.
 *      Silently handing pause authority to whichever hot key happened to run
 *      the deployment is how that authority ends up somewhere nobody intended.
 */
contract Deploy is Script {
    /// 0G Galileo testnet. Some older docs still say 16601; the canonical value is 16602.
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;

    function run() external returns (HealthRecordAnchor anchor) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN");

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

        vm.startBroadcast(deployerKey);
        anchor = new HealthRecordAnchor(admin);
        vm.stopBroadcast();

        console.log("HealthRecordAnchor:", address(anchor));

        // Fail the run rather than leave a misconfigured contract on chain.
        require(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), admin), "admin role not set");
        require(anchor.hasRole(anchor.PAUSER_ROLE(), admin), "pauser role not set");
    }
}
