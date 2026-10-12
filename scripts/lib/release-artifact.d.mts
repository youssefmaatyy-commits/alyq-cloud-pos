import type { Plugin } from 'vite';
import type { ApplicationConfig } from '../../src/lib/config/application-mode.mjs';
import type { ReleaseMetadata } from '../../src/lib/config/release';
export function releaseIdentity(root: string, config: Exclude<ApplicationConfig, {ok:false}>, env: Record<string, string | undefined>): ReleaseMetadata;
export function releaseBuildPlugin(root: string, identity: ReleaseMetadata, env: Record<string, string | undefined>): Plugin;
