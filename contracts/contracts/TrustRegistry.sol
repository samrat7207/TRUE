// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TrustRegistry: the public "notice board" of the TRUE network.
// It stores ONLY public information: who the issuers and verifiers are, their PUBLIC keys,
// and a fingerprint (hash) of each issuer's revocation list. No personal data is ever stored here.
contract TrustRegistry {
    // State of an issuer signing key.
    // Retired = replaced normally, old credentials still fine. Compromised = leaked, reject everything it signed.
    enum KeyState { None, Active, Retired, Compromised }

    struct IssuerKey { string publicJwk; KeyState state; }
    struct Verifier { string name; string allowedClaims; string publicJwk; bool registered; }
    struct StatusAnchor { bytes32 listHash; uint256 version; }

    address public owner; // the registry operator: decides who is an issuer or a verifier

    mapping(string => address) public issuerAdmin; // issuer id => the account that manages that issuer
    mapping(string => string) public issuerName;
    mapping(string => mapping(string => IssuerKey)) public issuerKeys; // issuer id => key id => key
    mapping(string => Verifier) public verifiers; // verifier id => entry
    mapping(string => StatusAnchor) public statusAnchors; // issuer id => fingerprint of its revocation list

    event IssuerRegistered(string issuerId, string name, address admin);
    event IssuerKeyChanged(string issuerId, string keyId, KeyState state);
    event VerifierRegistered(string verifierId, string name, string allowedClaims);
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

    function registerIssuer(string calldata issuerId, string calldata name, address admin) external onlyOwner {
        issuerAdmin[issuerId] = admin;
        issuerName[issuerId] = name;
        emit IssuerRegistered(issuerId, name, admin);
    }

    // allowedClaims is a comma-separated list, e.g. "name,photo,pnr". Wallets flag requests that ask for more.
    function registerVerifier(
        string calldata verifierId, string calldata name, string calldata allowedClaims, string calldata publicJwk
    ) external onlyOwner {
        verifiers[verifierId] = Verifier(name, allowedClaims, publicJwk, true);
        emit VerifierRegistered(verifierId, name, allowedClaims);
    }

    // Publish a new signing key. A key id can be used once, so an old key can never be silently replaced.
    function addIssuerKey(string calldata issuerId, string calldata keyId, string calldata publicJwk)
        external onlyIssuer(issuerId)
    {
        require(issuerKeys[issuerId][keyId].state == KeyState.None, "key id already used");
        issuerKeys[issuerId][keyId] = IssuerKey(publicJwk, KeyState.Active);
        emit IssuerKeyChanged(issuerId, keyId, KeyState.Active);
    }

    // Retire a key (normal rotation) or mark it Compromised (emergency). A Compromised key stays Compromised.
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
