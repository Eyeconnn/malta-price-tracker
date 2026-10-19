import type { Adapter, AdapterName } from '../types.js';
import { shopify } from './shopify.js';
import { woo } from './woo.js';
import { magento } from './magento.js';
import { html } from './html.js';

const adapters: Partial<Record<AdapterName, Adapter>> = { shopify, woo, magento, html };

export function adapterFor(name: AdapterName): Adapter {
  const a = adapters[name];
  if (!a) throw new Error(`adapter "${name}" is not implemented yet`);
  return a;
}
