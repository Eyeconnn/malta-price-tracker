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
