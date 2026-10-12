import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';

describe('Hello', async () => {
  const { viem } = await network.create();

  it('stores and returns a value on the local chain', async () => {
    const hello = await viem.deployContract('Hello');
    assert.equal(await hello.read.note(), 'TRUE');
    await hello.write.setNote(['chain works']);
    assert.equal(await hello.read.note(), 'chain works');
  });
});
