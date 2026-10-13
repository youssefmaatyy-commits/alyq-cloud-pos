/** Deliberately allowlisted, non-secret identity of the built client. */
export interface ReleaseMetadata {
  readonly gitSha: string;
  readonly builtAt: string;
  readonly environment: 'production' | 'staging' | 'preview' | 'demo';
  readonly appMode: 'production' | 'demo';
}
declare const __ALYQ_RELEASE__: ReleaseMetadata;
export const releaseMetadata: ReleaseMetadata = Object.freeze({
  gitSha: __ALYQ_RELEASE__.gitSha,
  builtAt: __ALYQ_RELEASE__.builtAt,
  environment: __ALYQ_RELEASE__.environment,
  appMode: __ALYQ_RELEASE__.appMode,
});
