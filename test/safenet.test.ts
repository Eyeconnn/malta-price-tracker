import { describe, expect, it } from 'vitest';
import { safeFetch } from '../src/http/safeNet.js';

describe('safeFetch', () => {
  it('refuses private IP literals', async () => {
    await expect(safeFetch('http://127.0.0.1:9/')).rejects.toThrow(/private address/);
    await expect(safeFetch('http://[::1]:9/')).rejects.toThrow(/private address/);
  });
  it('refuses host names that resolve to private addresses', async () => {
    await expect(safeFetch('http://localhost:9/')).rejects.toThrow();
  });
});

describe('isPrivateAddress', () => {
  it('blocks local NAT64, site-local, IPv4-compatible and Teredo IPv6 ranges', async () => {
    const { isPrivateAddress } = await import('../src/http/safeNet.js');
    for (const ip of ['64:ff9b:1::a00:1', 'fec0::1', 'feff::1', '::7f00:1', '::a00:1', '2001::1', '2001:0:4136:e378::1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['2a00:1450:4001::1', '2001:4860:4860::8888', '8.8.8.8', '64:ff9b:2::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
