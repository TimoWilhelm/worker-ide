// Handle incoming push notifications

globalThis.addEventListener('push', (event) => {
	if (!event.data) return;

	let payload;
	try {
		payload = event.data.json();
	} catch {
		payload = { title: 'Codemaxxing', body: event.data.text() };
	}

	const { title = 'Codemaxxing', body = '', tag, path } = payload;

	event.waitUntil(
		globalThis.registration.showNotification(title, {
			body,
			tag: tag || undefined,
			icon: '/favicon.svg',
			badge: '/favicon.svg',
			data: { path },
		}),
	);
});

// Handle notification click — navigate to the relevant project
globalThis.addEventListener('notificationclick', (event) => {
	event.notification.close();

	const path = event.notification.data?.path || '/';

	event.waitUntil(
		globalThis.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
			// If a window is already open, focus it and navigate
			for (const client of clientList) {
				if (client.url.includes(path) && 'focus' in client) {
					return client.focus();
				}
			}
			// Otherwise open a new window
			if (globalThis.clients.openWindow) {
				return globalThis.clients.openWindow(path);
			}
		}),
	);
});
