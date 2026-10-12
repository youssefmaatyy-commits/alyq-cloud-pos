/** Condition-based route readiness, shared by old and current UI suites. */
export async function waitForCondition(condition, { label = 'UI state', timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25)); // polling, not a fixed settle delay
  }
}

export async function waitForRoute(dom, hash, { normalizeStorePath = (value) => value } = {}) {
  let normalized = normalizeStorePath(hash.replace(/^#/, '') || '/');
  let target = normalized.split('?')[0];
  // Canonical unknown public pages redirect home too; PDP identifiers remain
  // dynamic and may legitimately render a noindex not-found state.
  if (target.startsWith('/store/') && !/^\/store\/(products(?:\/[^/]+)?|cart|checkout|confirmation|track|account|about|contact)$/.test(target)) {
    target = '/store'; normalized = '/store';
  }
  const expectedSearch = normalized.includes('?') ? '?' + normalized.split('?').slice(1).join('?') : '';
  const canonical = /^\/(pos|products|categories|catalog|management|inventory|sync|system-health|sales|customers|returns|refunds|shifts|expenses|approvals|reports|online|audit|settings)(\/|$)/.test(target)
    ? `/dashboard${target}` : target;
  const document = dom.window.document;
  await waitForCondition(() => {
    const committed = document.querySelector('[data-testid="route-location"]')?.getAttribute('data-path');
    // An anonymous direct staff deep link must finish at Login, not mount a shell.
    if (canonical.startsWith('/dashboard') && committed === '/login') return Boolean(document.querySelector("input[autocomplete='username']"));
    if (committed !== canonical) return false;
    const actual = dom.window.location.hash.replace(/^#/, '');
    // A transient <Navigate> route is not a completed redirect. Same-path query
    // navigation must also leave the previous query before readiness is claimed.
    if (actual.split('?')[0] !== canonical) return false;
    const actualSearch = actual.includes('?') ? '?' + actual.split('?').slice(1).join('?') : '';
    // Inventory consumes a valid initial status with replace after applying it.
    // Its selected filter below remains mandatory; other queries must match.
    const consumedStatus = canonical === '/dashboard/inventory/stock' && actualSearch === '' &&
      ['in', 'low', 'out'].includes(new URLSearchParams(expectedSearch).get('status'));
    if (actualSearch !== expectedSearch && !consumedStatus) return false;
    if (document.querySelector('[role="progressbar"], [aria-busy="true"], .animate-spin')) return false;
    if (/\/products\/(new|[^/]+\/edit)$/.test(canonical)) {
      return Boolean(document.querySelector('#sku')) && (document.querySelector('#category_id')?.options.length ?? 0) > 1;
    }
    if (document.querySelector('[data-testid="route-access-denied"]')) return true;
    if (canonical === '/' || canonical === '/store') return Boolean(document.querySelector('main section, [data-testid="v2-home"]'));
    if (canonical === '/dashboard/inventory/stock') {
      const filter = document.querySelector('select[aria-label="Status"]');
      const wanted = new URLSearchParams(hash.split('?')[1] || '').get('status');
      return Boolean(filter) && (!wanted || filter.value === wanted);
    }
    if (canonical === '/dashboard') return Boolean(document.querySelector('[data-testid="dash-kpi-row"]'));
    if (canonical === '/dashboard/online/website') {
      const tab = new URLSearchParams(expectedSearch).get('tab') || 'general';
      const buttons = [...document.querySelectorAll('button[data-settings-tab]')];
      // The same settings page remains mounted for every tab. Check its actual
      // committed selection, not a header/old editor or only three known tabs.
      const selected = buttons.find((button) => button.getAttribute('data-settings-tab') === tab) ||
        buttons.find((button) => button.getAttribute('data-settings-tab') === 'general');
      return selected?.getAttribute('aria-pressed') === 'true' && Boolean(document.querySelector('main h1'));
    }
    if (canonical.startsWith('/dashboard')) return Boolean(document.querySelector('main h1'));
    if (/^\/store\/products\/[^/]+$/.test(canonical)) return Boolean(document.querySelector('[data-testid="product-add-to-cart"], [data-testid="v2-pdp-add"], .v2-not-found h1'));
    if (canonical === '/login') return Boolean(document.querySelector("input[autocomplete='username']"));
    return Boolean(document.querySelector('header, h1'));
  }, { label: `committed and ready route ${canonical}` });
}
