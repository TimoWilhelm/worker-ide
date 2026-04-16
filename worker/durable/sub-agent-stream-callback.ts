import { RpcTarget } from 'cloudflare:workers';

import type { StreamEvent } from '@shared/agent-state';

export class SubAgentStreamCallback extends RpcTarget {
	constructor(private readonly onEvent: (event: StreamEvent) => void) {
		super();
	}

	async pushEvent(eventJson: string): Promise<void> {
		const event: StreamEvent = JSON.parse(eventJson);
		this.onEvent(event);
	}
}
