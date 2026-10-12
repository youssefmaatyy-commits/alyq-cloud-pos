/** Condition-based route readiness, shared by old and current UI suites. */
export async function waitForCondition(condition, { label = 'UI state', timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25)); // polling, not a fixed settle delay
  }
}

export async function waitForRoute(dom, hash) {
  const target = (hash.replace(/^#/, '') || '/').split('?')[0];
  const canonical = /^\/(pos|products|categories|catalog|management|inventory|sync|system-health|sales|customers|returns|refunds|shifts|expenses|approvals|reports|online|audit|settings)(\/|$)/.test(target)
    ? `/dashboard${target}` : target;
  const document = dom.window.document;
  await waitForCondition(() => {
    const committed = document.querySelector('[data-testid="route-location"]')?.getAttribute('data-path');
    // An anonymous direct staff deep link must finish at Login, not mount a shell.
    if (canonical.startsWith('/dashboard') && committed === '/login') return Boolean(document.querySelector("input[autocomplete='username']"));
    if (committed !== canonical) return false;
    if (document.querySelector('[role="progressbar"], [aria-busy="true"], .animate-spin')) return false;
    if (/\/products\/(new|[^/]+\/edit)$/.test(canonical)) {
      return Boolean(document.querySelector('#sku')) && (document.querySelector('#category_id')?.options.length ?? 0) > 1;
    }
    if (document.querySelector('[data-testid="route-access-denied"]')) return true;
    if (canonical === '/store') return Boolean(document.querySelector('main section, [data-testid="v2-home"]'));
    if (canonical === '/dashboard/inventory/stock') {
      const filter = document.querySelector('select[aria-label="Status"]');
      const wanted = new URLSearchParams(hash.split('?')[1] || '').get('status');
      return Boolean(filter) && (!wanted || filter.value === wanted);
    }
    if (canonical === '/dashboard') return Boolean(document.querySelector('[data-testid="dash-kpi-row"]'));
    if (canonical.startsWith('/dashboard')) return Boolean(document.querySelector('main h1'));
    if (/^\/store\/products\/[^/]+$/.test(canonical)) return Boolean(document.querySelector('[data-testid="product-add-to-cart"], [data-testid="v2-pdp-add"]'));
    if (canonical === '/login') return Boolean(document.querySelector("input[autocomplete='username']"));
    return Boolean(document.querySelector('header, h1'));
  }, { label: `committed and ready route ${canonical}` });
}
