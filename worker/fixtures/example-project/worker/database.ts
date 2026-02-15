// In-memory database module

export interface Contact {
	id: string;
	name: string;
	email: string;
	role: string;
}

// In-memory storage (resets on worker restart)
export const contacts: Contact[] = [
	{ id: '1', name: 'Alice Johnson', email: 'alice@example.com', role: 'Engineer' },
	{ id: '2', name: 'Bob Smith', email: 'bob@example.com', role: 'Designer' },
	{ id: '3', name: 'Carol Williams', email: 'carol@example.com', role: 'Manager' },
];
