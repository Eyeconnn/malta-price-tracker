import type { Adapter } from '../types.js';

export const magento: Adapter = {
  // eslint-disable-next-line require-yield
  async *crawl() {
    throw new Error('magento adapter not implemented yet');
  },
  async fetchOne() {
    throw new Error('magento adapter not implemented yet');
  },
};
