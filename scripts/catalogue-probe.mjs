#!/usr/bin/env node
import { loadEnv } from 'vite';
import { probeCatalogue } from './lib/catalogue-probe.mjs';
try {
  const result = await probeCatalogue({ ...loadEnv('production', process.cwd(), ''), ...process.env });
  console.log(`Catalogue probe: ${result.sellableCount} sellable of ${result.productCount} public products.${result.allowedEmpty ? ' Explicit empty-store exception active.' : ''}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
