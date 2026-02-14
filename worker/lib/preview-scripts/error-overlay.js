/**
 * Error Overlay for Preview
 *
 * Renders a styled error overlay inside the preview iframe when a
 * build or runtime error occurs. Exposes window.showErrorOverlay()
 * and window.hideErrorOverlay() for the HMR client to call.
 *
 * Clicking the file location sends an __open-file postMessage to the
 * parent IDE frame so it can open the file at the error position.
 */
(function () {
	function esc(s) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function linkifyFiles(escaped) {
		return escaped.replace(
			/(?:^|\s)((?:[\w.@\-]+\/)*[\w.\-]+\.(?:ts|tsx|js|jsx|css|html|json|mjs|cjs|vue|svelte)):(\d+):(\d+)/gm,
			function (match, file, line, col) {
				var leading = match.charAt(0) !== file.charAt(0) ? match.charAt(0) : '';
				return (
					leading +
					'<span class="__eo-file-link" data-file="/' +
					file +
					'" data-line="' +
					line +
					'" data-column="' +
					col +
					'">' +
					file +
					':' +
					line +
					':' +
					col +
					'</span>'
				);
			},
		);
	}

	function showErrorOverlay(err) {
		hideErrorOverlay();
		var overlay = document.createElement('div');
		overlay.id = '__error-overlay';
		var loc = err.file ? esc(err.file + (err.line ? ':' + err.line : '') + (err.column ? ':' + err.column : '')) : '';
		overlay.innerHTML =
			'<style>' +
			'#__error-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace}' +
			'.__eo-card{background:#1a1a2e;color:#e0e0e0;border-radius:12px;max-width:640px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid rgba(248,81,73,0.4)}' +
			'.__eo-header{padding:16px 20px;border-bottom:1px solid rgba(248,81,73,0.3);display:flex;align-items:center;gap:10px}' +
			'.__eo-badge{background:rgba(248,81,73,0.2);color:#f85149;font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:4px}' +
			'.__eo-title{color:#f85149;font-size:14px;font-weight:600;flex:1}' +
			'.__eo-close{background:none;border:none;color:#8b949e;cursor:pointer;font-size:18px;padding:4px 8px;border-radius:4px}' +
			'.__eo-close:hover{background:rgba(255,255,255,0.1);color:#e0e0e0}' +
			'.__eo-body{padding:16px 20px}' +
			'.__eo-file{color:#58a6ff;font-size:13px;margin-bottom:12px;cursor:pointer;text-decoration:underline}' +
			'.__eo-file:hover{color:#79b8ff}' +
			'.__eo-msg{background:#0d1117;border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:#f0f0f0;border:1px solid rgba(48,54,61,0.8)}' +
			'.__eo-file-link{color:#58a6ff;cursor:pointer;text-decoration:underline}' +
			'.__eo-file-link:hover{color:#79b8ff}' +
			'</style>' +
			'<div class="__eo-card">' +
			'<div class="__eo-header">' +
			'<span class="__eo-badge">' +
			esc(err.type || 'error') +
			'</span>' +
			'<span class="__eo-title">Build Error</span>' +
			'<button class="__eo-close" onclick="document.getElementById(\'__error-overlay\')?.remove()">&times;</button>' +
			'</div>' +
			'<div class="__eo-body">' +
			(loc
				? '<div class="__eo-file" data-file="/' +
					esc(err.file || '') +
					'" data-line="' +
					(err.line || 1) +
					'" data-column="' +
					(err.column || 1) +
					'">' +
					loc +
					'</div>'
				: '') +
			'<div class="__eo-msg">' +
			linkifyFiles(esc(err.message || 'Unknown error')) +
			'</div>' +
			'</div>' +
			'</div>';
		document.body.appendChild(overlay);
		overlay.addEventListener('click', function (e) {
			if (e.target === overlay) overlay.remove();
		});
		function handleFileClick(el) {
			window.parent.postMessage(
				{
					type: '__open-file',
					file: el.dataset.file,
					line: parseInt(el.dataset.line, 10) || 1,
					column: parseInt(el.dataset.column, 10) || 1,
				},
				location.origin,
			);
		}
		var fileEl = overlay.querySelector('.__eo-file');
		if (fileEl) {
			fileEl.addEventListener('click', function () {
				handleFileClick(fileEl);
			});
		}
		overlay.querySelectorAll('.__eo-file-link').forEach(function (link) {
			link.addEventListener('click', function () {
				handleFileClick(link);
			});
		});
	}

	function hideErrorOverlay() {
		var el = document.getElementById('__error-overlay');
		if (el) el.remove();
	}

	window.showErrorOverlay = showErrorOverlay;
	window.hideErrorOverlay = hideErrorOverlay;

	// Listen for __show-error-overlay messages from the parent IDE frame
	window.addEventListener('message', function (event) {
		if (event.data && event.data.type === '__show-error-overlay' && event.data.error) {
			showErrorOverlay(event.data.error);
		}
	});
})();
