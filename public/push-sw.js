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
	const targetUrl = new globalThis.URL(path, globalThis.location.origin).toString();

	event.waitUntil(
		globalThis.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
			// If a window is already open, navigate it to the deep link and focus it.
			for (const client of clientList) {
				if ('navigate' in client && 'focus' in client) {
					return client.navigate(targetUrl).then(() => client.focus());
				}
			}
			// Otherwise open a new window
			if (globalThis.clients.openWindow) {
				return globalThis.clients.openWindow(targetUrl);
			}
		}),
	);
});
