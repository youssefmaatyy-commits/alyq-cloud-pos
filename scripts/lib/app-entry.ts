/** Test-only entry: exposes the SAME renderer's flushSync for native jsdom events.
 * Production still starts at src/main.tsx and has no test globals or exports. */
import '../../src/main';
export { flushSync } from 'react-dom';
export { canonicalConfiguredStorePath } from '../../src/modules/online/v2/storeRoutes';
