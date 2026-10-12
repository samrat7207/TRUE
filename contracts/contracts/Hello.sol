// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// M0 hello-world: proves the local chain toolchain works. Replaced by TrustRegistry in M2.
contract Hello {
    string public note = "TRUE";

    function setNote(string calldata newNote) external {
        note = newNote;
    }
}
