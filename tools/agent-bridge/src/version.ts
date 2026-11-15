/** The bridge's version. The bundle build (install/build.mjs) replaces the variable; run from source it is "dev". */
export const BRIDGE_VERSION: string = process.env['MANYTHREADS_BRIDGE_VERSION'] ?? 'dev';
