/**
 * Shared building block for framework runtime adapters: a parameterized browser
 * HMR glue builder. The glue's transport (the coordinator `vinext:hmr` event,
 * the `/@vinext-client/` dev module ids, the CSS `<link>` swap) is identical
 * across frameworks; only the "soft refresh" fallback and any per-framework
 * client setup differ, so those are injected.
 *
 * This module is intentionally light (no esbuild/ViteHost import) so the preview
 * Durable Object can use {@link buildHmrGlue} without pulling the build engine
 * into its isolate.
 */

/** Source extensions treated as stylesheets for CSS HMR (mirrors Vite). */
const STYLE_EXTENSION_PATTERN = String.raw`\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)([?#].*)?$`;

export interface HmrGlueOptions {
	/** Per-framework client setup, run before any module (e.g. install `import.meta.hot`). */
	extraSetup?: string;
	/** Body of `softRefresh()` — how a non-Fast-Refresh change updates the page. */
	softRefreshBody: string;
}

/**
 * Build the injected browser HMR glue. It bridges the coordinator's `vinext:hmr`
 * events to the matching Vite-style boundary: a stylesheet swaps the live
 * `<link>` in place, a registered client module is re-imported (React Fast
 * Refresh), and anything else falls back to {@link HmrGlueOptions.softRefreshBody}.
 */
export function buildHmrGlue(options: HmrGlueOptions): string {
	return `(function () {
	var runtime = window.__PREVIEW_RUNTIME__;
	if (!runtime) return;
	var STYLE_RE = new RegExp(${JSON.stringify(STYLE_EXTENSION_PATTERN)});
	${options.extraSetup ?? ''}
	function softRefresh() {
		${options.softRefreshBody}
	}
	// A non-Fast-Refresh boundary bubbles to a "reload"; route it to softRefresh.
	window.__PREVIEW_RUNTIME_RELOAD__ = function () { softRefresh(); };
	// A stylesheet edit rebuilds the same stable (non-hashed) CSS asset, so
	// re-fetching each same-origin <link> with a fresh cache-busting query applies
	// the new styles without touching the DOM or React state.
	function updateStyles() {
		var timestamp = Date.now();
		var links = document.querySelectorAll('link[rel="stylesheet"][href]');
		for (var index = 0; index < links.length; index++) {
			var link = links[index];
			var resolved;
			try {
				resolved = new URL(link.getAttribute('href'), document.baseURI);
			} catch (error) {
				continue;
			}
			if (resolved.origin !== window.location.origin) continue;
			resolved.searchParams.set('t', String(timestamp));
			var replacement = link.cloneNode(false);
			replacement.setAttribute('href', resolved.pathname + resolved.search);
			(function (oldLink) {
				replacement.addEventListener('load', function () {
					if (oldLink.parentNode) oldLink.parentNode.removeChild(oldLink);
				});
			})(link);
			link.parentNode.insertBefore(replacement, link.nextSibling);
		}
	}
	var hot = runtime.createHotContext('/@vinext-hmr-glue');
	hot.on('vinext:hmr', function (data) {
		var path = data && data.path;
		if (!path) return;
		if (STYLE_RE.test(path)) {
			updateStyles();
			return;
		}
		// A registered client module is a self-accepting boundary → Fast Refresh.
		// An unregistered (server) module bubbles to softRefresh.
		var id = '/@vinext-client/' + encodeURIComponent(path);
		Promise.resolve(runtime.applyUpdate({ timestamp: Date.now(), targets: [{ id: id, kind: 'module' }] })).catch(softRefresh);
	});
})();`;
}
