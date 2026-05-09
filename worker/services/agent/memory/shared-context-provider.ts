interface SqlRow {
	content?: string;
}

interface SqlTag {
	(strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>): SqlRow[];
}

interface SqlStorageAgent {
	sql: SqlTag;
}

/**
 * SQLite-backed context provider with a stable key shared across all sessions
 * in the project-scoped root agent.
 */
export class SharedContextProvider {
	private initialized = false;

	constructor(
		private readonly agent: SqlStorageAgent,
		private readonly label: string,
	) {}

	async get(): Promise<string | null> {
		this.ensureTable();
		/* eslint-disable unicorn/no-null -- Agents SDK context provider contract uses null for empty reads */
		return (
			this.agent.sql`
			SELECT content FROM cf_agents_context_blocks WHERE label = ${this.label}
		`[0]?.content ?? null
		);
		/* eslint-enable unicorn/no-null */
	}

	async set(content: string): Promise<void> {
		this.ensureTable();
		this.agent.sql`
			INSERT INTO cf_agents_context_blocks (label, content)
			VALUES (${this.label}, ${content})
			ON CONFLICT(label) DO UPDATE SET
				content = ${content},
				updated_at = CURRENT_TIMESTAMP
		`;
	}

	private ensureTable(): void {
		if (this.initialized) {
			return;
		}

		this.agent.sql`
			CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
				label TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)
		`;

		this.initialized = true;
	}
}
