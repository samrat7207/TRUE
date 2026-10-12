// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TrustRegistry: the public "notice board" of the TRUE network.
// It stores ONLY public information: which institutions exist and whether they are verified, their PUBLIC
// keys, which registers (checkers) exist and what they may ask for, and a fingerprint (hash) of the
// revocation list. No personal data is ever stored here.
contract TrustRegistry {
    // State of an issuer signing key.
    // Retired = no longer signing, old credentials still fine. Compromised = leaked, reject everything it signed.
    enum KeyState { None, Active, Retired, Compromised }

    struct IssuerKey { string publicJwk; KeyState state; }
    // A register (verifier): what it may ask for, and the ONE issuer and credential type it accepts.
    // pinnedTo is "<issuer id>|<credential type>", or empty for a verifier that is not pinned.
    struct Verifier { string name; string allowedClaims; string publicJwk; bool registered; string pinnedTo; }
    struct StatusAnchor { bytes32 listHash; uint256 version; }

    address public owner; // the registry operator: decides who is an issuer, who is verified, who is a verifier

    string[] public issuerIds; // every issuer ever registered, so apps can list institutions
    mapping(string => address) public issuerAdmin; // issuer id => the account that manages that issuer
    mapping(string => string) public issuerName;
    mapping(string => bool) public issuerVerified; // true once the operator has checked the institution
    mapping(string => mapping(string => IssuerKey)) public issuerKeys; // issuer id => key id => key
    mapping(string => Verifier) public verifiers; // verifier id => entry
    mapping(string => StatusAnchor) public statusAnchors; // list id => fingerprint of that revocation list

    event IssuerRegistered(string issuerId, string name, address admin);
    event IssuerVerifiedChanged(string issuerId, bool verified);
    event IssuerKeyChanged(string issuerId, string keyId, KeyState state);
    event VerifierRegistered(string verifierId, string name, string allowedClaims, string pinnedTo);
    event VerifierRemoved(string verifierId);
    event StatusListAnchored(string issuerId, bytes32 listHash, uint256 version);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "only the registry owner");
        _;
    }

    // Only the account registered for this issuer may change its keys or its revocation fingerprint.
    modifier onlyIssuer(string calldata issuerId) {
        require(msg.sender == issuerAdmin[issuerId], "only this issuer's admin");
        _;
    }

    function issuerCount() external view returns (uint256) {
        return issuerIds.length;
    }

    function registerIssuer(string calldata issuerId, string calldata name, address admin) external onlyOwner {
        if (issuerAdmin[issuerId] == address(0)) issuerIds.push(issuerId); // list each issuer once
        issuerAdmin[issuerId] = admin;
        issuerName[issuerId] = name;
        emit IssuerRegistered(issuerId, name, admin);
    }

    // Mark an institution as verified (or not). New sign-ups start unverified.
    function setIssuerVerified(string calldata issuerId, bool verified) external onlyOwner {
        issuerVerified[issuerId] = verified;
        emit IssuerVerifiedChanged(issuerId, verified);
    }

    // allowedClaims is a comma-separated list, e.g. "name,blood_group". Wallets refuse requests that ask for more.
    function registerVerifier(
        string calldata verifierId, string calldata name, string calldata allowedClaims, string calldata publicJwk,
        string calldata pinnedTo
    ) external onlyOwner {
        verifiers[verifierId] = Verifier(name, allowedClaims, publicJwk, true, pinnedTo);
        emit VerifierRegistered(verifierId, name, allowedClaims, pinnedTo);
    }

    // A deleted register: wallets and verifiers treat it as unregistered from now on.
    function removeVerifier(string calldata verifierId) external onlyOwner {
        delete verifiers[verifierId];
        emit VerifierRemoved(verifierId);
    }

    // Publish a new signing key. A key id can be used once, so an old key can never be silently replaced.
    function addIssuerKey(string calldata issuerId, string calldata keyId, string calldata publicJwk)
        external onlyIssuer(issuerId)
    {
        require(issuerKeys[issuerId][keyId].state == KeyState.None, "key id already used");
        issuerKeys[issuerId][keyId] = IssuerKey(publicJwk, KeyState.Active);
        emit IssuerKeyChanged(issuerId, keyId, KeyState.Active);
    }

    // Retire a key or mark it Compromised (emergency). A Compromised key stays Compromised.
    function setIssuerKeyState(string calldata issuerId, string calldata keyId, KeyState state)
        external onlyIssuer(issuerId)
    {
        KeyState current = issuerKeys[issuerId][keyId].state;
        require(current != KeyState.None, "unknown key");
        require(current != KeyState.Compromised, "a compromised key cannot be restored");
        require(state == KeyState.Retired || state == KeyState.Compromised, "can only retire or mark compromised");
        issuerKeys[issuerId][keyId].state = state;
        emit IssuerKeyChanged(issuerId, keyId, state);
    }

    // Publish the fingerprint of the current revocation list. The version must go up, so an old list cannot be replayed.
    function anchorStatusList(string calldata issuerId, bytes32 listHash, uint256 version)
        external onlyIssuer(issuerId)
    {
        require(version > statusAnchors[issuerId].version, "version must increase");
        statusAnchors[issuerId] = StatusAnchor(listHash, version);
        emit StatusListAnchored(issuerId, listHash, version);
    }
}
