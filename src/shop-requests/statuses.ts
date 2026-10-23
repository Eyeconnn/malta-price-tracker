// Shop request statuses, shared by the PC task, the Worker and the Add shop page. Pure.

export const SHOP_REQUEST_STATUSES = ['pending', 'checking', 'active', 'needs_setup', 'blocked', 'failed', 'rejected'] as const;
export type ShopRequestStatus = (typeof SHOP_REQUEST_STATUSES)[number];

/** The admin may send a request back to pending (retry) from these statuses only. */
export const RETRY_FROM: readonly ShopRequestStatus[] = ['failed', 'blocked'];
/** The admin may reject a request in these statuses (also while it is checked: the check then leaves it rejected), not once its shop is active. */
export const REJECT_FROM: readonly ShopRequestStatus[] = ['pending', 'checking', 'needs_setup', 'blocked', 'failed'];
/** Statuses that count towards the cap of open checks. */
export const QUEUED: readonly ShopRequestStatus[] = ['pending', 'checking'];
export const MAX_QUEUED = 20;

export const STATUS_LABELS: Record<ShopRequestStatus, string> = {
  pending: 'Waiting',
  checking: 'Checking',
  active: 'Active',
  needs_setup: 'Needs setup',
  blocked: 'Blocked',
  failed: 'Failed',
  rejected: 'Rejected',
};

export const PLATFORM_LABELS: Record<string, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  'magento-graphql': 'Magento (GraphQL)',
  'magento-html': 'Magento (pages)',
  unknown: 'Not recognised',
};
