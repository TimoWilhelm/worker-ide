/**
 * Chobitsu CDP Init Script for Preview
 *
 * Initializes chobitsu (Chrome DevTools Protocol in JS) and sets up
 * the message relay between the preview iframe and the parent IDE frame.
 *
 * Runtime.enable is called immediately so that Runtime.consoleAPICalled
 * CDP events fire regardless of whether the DevTools panel is open.
 * The remaining CDP domains are enabled when the DevTools panel sends LOADED.
 *
 * Must be loaded after __chobitsu.js (which defines the global `chobitsu`).
 */
(function () {
	if (typeof chobitsu === 'undefined') {
		console.error('[devtools] chobitsu not available after script load');
		return;
	}
	var id = 0;

	function sendToDevtools(message) {
		window.parent.postMessage(message, '*');
	}

	function sendToChobitsu(message) {
		message.id = 'tmp' + ++id;
		chobitsu.sendRawMessage(JSON.stringify(message));
	}

	// Enable Runtime immediately so console logs are captured even
	// when the DevTools panel is not open.
	sendToChobitsu({ method: 'Runtime.enable' });

	function handleInit() {
		sendToDevtools(
			JSON.stringify({
				method: 'Page.frameNavigated',
				params: {
					frame: { id: '1', mimeType: 'text/html', securityOrigin: location.origin, url: location.href },
					type: 'Navigation',
				},
			}),
		);
		sendToChobitsu({ method: 'Network.enable' });
		sendToDevtools(JSON.stringify({ method: 'Runtime.executionContextsCleared' }));
		sendToChobitsu({ method: 'Runtime.enable' });
		sendToChobitsu({ method: 'Debugger.enable' });
		sendToChobitsu({ method: 'DOMStorage.enable' });
		sendToChobitsu({ method: 'DOM.enable' });
		sendToChobitsu({ method: 'CSS.enable' });
		sendToChobitsu({ method: 'Overlay.enable' });
		sendToDevtools(JSON.stringify({ method: 'DOM.documentUpdated' }));
	}

	chobitsu.setOnMessage(function (message) {
		if (message.includes('"id":"tmp')) return;
		// Intercept Runtime.consoleAPICalled to forward logs to the parent IDE
		try {
			if (message.includes('"Runtime.consoleAPICalled"')) {
				var parsed = JSON.parse(message);
				if (parsed.method === 'Runtime.consoleAPICalled' && parsed.params) {
					var args = parsed.params.args || [];
					var text = args
						.map(function (a) {
							if (a.type === 'string') return a.value;
							if (a.type === 'undefined') return 'undefined';
							if (a.value !== undefined) return String(a.value);
							if (a.description) return a.description;
							return a.type;
						})
						.join(' ');
					if (!text.startsWith('[hmr]')) {
						window.parent.postMessage(
							{
								type: '__console-log',
								level: parsed.params.type || 'log',
								message: text,
								timestamp: parsed.params.timestamp ? Math.floor(parsed.params.timestamp) : Date.now(),
							},
							location.origin,
						);
					}
				}
			}
		} catch (e) {
			/* ignore parse errors */
		}
		sendToDevtools(message);
	});

	window.addEventListener('message', function (event) {
		try {
			var data = event.data;
			if (!data || !data.event) return;
			if (data.event === 'DEV') {
				chobitsu.sendRawMessage(data.data);
			} else if (data.event === 'LOADED') {
				handleInit();
			}
		} catch (e) {
			console.error('[devtools]', e);
		}
	});

	// Notify parent that chobitsu is ready
	window.parent.postMessage({ type: '__chobitsu-ready' }, location.origin);
})();
