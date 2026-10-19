import type { Adapter } from '../types.js';

export const html: Adapter = {
  // eslint-disable-next-line require-yield
  async *crawl() {
    throw new Error('html adapter not implemented yet');
  },
  async fetchOne() {
    throw new Error('html adapter not implemented yet');
  },
};
