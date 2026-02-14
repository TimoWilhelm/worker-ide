/**
 * Fetch Interceptor for Preview
 *
 * Rewrites /api/* requests to the preview-prefixed path so that
 * user code calling fetch('/api/...') hits the correct preview API route.
 *
 * Reads config from window.__PREVIEW_CONFIG.baseUrl (set by a tiny inline script).
 */
(function () {
	var previewBase = (window.__PREVIEW_CONFIG && window.__PREVIEW_CONFIG.baseUrl) || '';
	if (!previewBase) return;
	// Strip trailing slash
	previewBase = previewBase.replace(/\/$/, '');

	var originalFetch = window.fetch;
	window.fetch = function (input, init) {
		var isApiRequest = false;
		var url = input;
		if (typeof input === 'string') {
			if (input.startsWith('/api/') || input === '/api') {
				url = previewBase + input;
				isApiRequest = true;
			}
		} else if (input instanceof Request) {
			var reqUrl = new URL(input.url);
			if (reqUrl.pathname.startsWith('/api/') || reqUrl.pathname === '/api') {
				reqUrl.pathname = previewBase + reqUrl.pathname;
				input = new Request(reqUrl.toString(), input);
				isApiRequest = true;
			}
			url = input;
		}
		var result = originalFetch.call(this, url, init);
		if (isApiRequest) {
			result.then(function (response) {
				if (response.status >= 500) {
					response
						.clone()
						.json()
						.then(function (body) {
							if (body && body.serverError) {
								if (body.serverError.type === 'bundle' && typeof window.showErrorOverlay === 'function') {
									window.showErrorOverlay(body.serverError);
								}
								window.parent.postMessage({ type: '__server-error', error: body.serverError }, '*');
							}
						})
						.catch(function () {
							/* not JSON, ignore */
						});
				}
			});
		}
		return result;
	};

	var originalXHROpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url) {
		var newUrl = url;
		if (typeof url === 'string') {
			if (url.startsWith('/api/') || url === '/api') {
				newUrl = previewBase + url;
			}
		}
		var rest = Array.prototype.slice.call(arguments, 2);
		return originalXHROpen.apply(this, [method, newUrl].concat(rest));
	};
})();
