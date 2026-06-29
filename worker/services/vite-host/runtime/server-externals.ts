/**
 * Bare specifiers left external when building the server (rsc/ssr) environments.
 *
 * These are the React + RSC runtime packages and the framework runtime entry
 * points (`next/*`, `vinext`). They are provided to the server LOADER isolate at
 * run time rather than bundled, matching how a Cloudflare Workers vinext build
 * externalises the React server runtime.
 */
export const SERVER_RUNTIME_EXTERNALS: readonly string[] = ['react', 'react-dom', 'react-server-dom-webpack', '@vitejs/plugin-rsc'];
