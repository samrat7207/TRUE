import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';

describe('TrustRegistry', async () => {
  const { viem } = await network.create();
  const [owner, issuer, stranger] = await viem.getWalletClients();
  const registry = await viem.deployContract('TrustRegistry');
  const as = (client: typeof owner) => ({ account: client.account });
  const HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

  it('owner registers an issuer; the issuer publishes a key', async () => {
    await registry.write.registerIssuer(['issuer:a', 'Issuer A', issuer.account.address], as(owner));
    await registry.write.addIssuerKey(['issuer:a', 'key-1', '{"kty":"EC"}'], as(issuer));
    const [jwk, state] = await registry.read.issuerKeys(['issuer:a', 'key-1']);
    assert.equal(jwk, '{"kty":"EC"}');
    assert.equal(state, 1); // Active
  });

  it('a stranger cannot publish keys or register anyone', async () => {
    await assert.rejects(registry.write.addIssuerKey(['issuer:a', 'key-x', '{}'], as(stranger)));
    await assert.rejects(registry.write.registerVerifier(['verifier:x', 'X', 'name', '{}', ''], as(stranger)));
  });

  it('a key id cannot be reused, and a compromised key cannot be restored', async () => {
    await assert.rejects(registry.write.addIssuerKey(['issuer:a', 'key-1', '{"other":1}'], as(issuer)));
    await registry.write.setIssuerKeyState(['issuer:a', 'key-1', 3], as(issuer)); // Compromised
    assert.equal((await registry.read.issuerKeys(['issuer:a', 'key-1']))[1], 3);
    await assert.rejects(registry.write.setIssuerKeyState(['issuer:a', 'key-1', 2], as(issuer)));
  });

  it('owner registers a verifier with its allowed claims', async () => {
    await registry.write.registerVerifier(['verifier:lib', 'Gate register', 'name,blood_group', '{"kty":"EC"}', 'inst:a|StudentID'], as(owner));
    const [name, allowedClaims, , registered, pinnedTo] = await registry.read.verifiers(['verifier:lib']);
    assert.equal(name, 'Gate register');
    assert.equal(allowedClaims, 'name,blood_group');
    assert.equal(registered, true);
    assert.equal(pinnedTo, 'inst:a|StudentID');
    assert.equal((await registry.read.verifiers(['verifier:fake']))[3], false);
    // A removed verifier is unregistered again; only the owner may remove.
    await assert.rejects(registry.write.removeVerifier(['verifier:lib'], as(stranger)));
    await registry.write.removeVerifier(['verifier:lib'], as(owner));
    assert.equal((await registry.read.verifiers(['verifier:lib']))[3], false);
  });

  it('institutions are listed once, and only the owner can mark one verified', async () => {
    await registry.write.registerIssuer(['inst:b', 'Institution B', issuer.account.address], as(owner));
    await registry.write.registerIssuer(['inst:b', 'Institution B renamed', issuer.account.address], as(owner));
    const count = await registry.read.issuerCount();
    const ids = await Promise.all(Array.from({ length: Number(count) }, (_, i) => registry.read.issuerIds([BigInt(i)])));
    assert.equal(ids.filter((id) => id === 'inst:b').length, 1);
    assert.equal(await registry.read.issuerVerified(['inst:b']), false); // new institutions start unverified
    await assert.rejects(registry.write.setIssuerVerified(['inst:b', true], as(issuer)));
    await registry.write.setIssuerVerified(['inst:b', true], as(owner));
    assert.equal(await registry.read.issuerVerified(['inst:b']), true);
  });

  it('status list anchor: version must increase', async () => {
    await registry.write.anchorStatusList(['issuer:a', HASH, 1n], as(issuer));
    assert.equal((await registry.read.statusAnchors(['issuer:a']))[0], HASH);
    await assert.rejects(registry.write.anchorStatusList(['issuer:a', HASH, 1n], as(issuer)));
    await assert.rejects(registry.write.anchorStatusList(['issuer:a', HASH, 5n], as(stranger)));
  });
});
