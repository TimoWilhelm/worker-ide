import { useState, useEffect, useCallback } from 'react';

interface Contact {
	id: string;
	name: string;
	email: string;
	role: string;
}

type View = 'list' | 'add' | 'edit';

export function App() {
	const [contacts, setContacts] = useState<Contact[]>([]);
	const [view, setView] = useState<View>('list');
	const [editingContact, setEditingContact] = useState<Contact | undefined>();
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('');
	const [status, setStatus] = useState('Loading...');
	const [busy, setBusy] = useState(false);

	const loadContacts = useCallback(async () => {
		try {
			const response = await fetch('/api/contacts');
			const data: Contact[] = await response.json();
			setContacts(data);
			setStatus(`${data.length} contact${data.length === 1 ? '' : 's'}`);
		} catch {
			setStatus('Error loading contacts');
		}
	}, []);

	useEffect(() => {
		void loadContacts();
	}, [loadContacts]);

	const resetForm = () => {
		setName('');
		setEmail('');
		setRole('');
		setEditingContact(undefined);
		setView('list');
	};

	const handleAdd = async () => {
		if (!name.trim() || !email.trim()) return;
		setBusy(true);
		try {
			await fetch('/api/contacts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), email: email.trim(), role: role.trim() || 'Member' }),
			});
			resetForm();
			await loadContacts();
		} finally {
			setBusy(false);
		}
	};

	const handleUpdate = async () => {
		if (!editingContact || !name.trim() || !email.trim()) return;
		setBusy(true);
		try {
			await fetch(`/api/contacts/${editingContact.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), email: email.trim(), role: role.trim() || 'Member' }),
			});
			resetForm();
			await loadContacts();
		} finally {
			setBusy(false);
		}
	};

	const handleDelete = async (id: string) => {
		setBusy(true);
		try {
			await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
			await loadContacts();
		} finally {
			setBusy(false);
		}
	};

	const startEdit = (contact: Contact) => {
		setEditingContact(contact);
		setName(contact.name);
		setEmail(contact.email);
		setRole(contact.role);
		setView('edit');
	};

	const startAdd = () => {
		resetForm();
		setView('add');
	};

	return (
		<div className="app">
			<h1>&#9889; Workers Full-Stack</h1>
			<p className="subtitle">React + Hono on Cloudflare Workers</p>

			<div className="card">
				<div className="card-header">
					<span className="status">{status}</span>
					{view === 'list' && (
						<button className="btn-primary" onClick={startAdd}>
							+ Add Contact
						</button>
					)}
					{view !== 'list' && (
						<button className="btn-secondary" onClick={resetForm}>
							&larr; Back
						</button>
					)}
				</div>

				{(view === 'add' || view === 'edit') && (
					<div className="form">
						<input type="text" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
						<input type="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} />
						<input
							type="text"
							placeholder="Role (optional)"
							value={role}
							onChange={(event) => setRole(event.target.value)}
							disabled={busy}
						/>
						<button
							className="btn-primary"
							onClick={view === 'add' ? handleAdd : handleUpdate}
							disabled={busy || !name.trim() || !email.trim()}
						>
							{busy ? 'Saving...' : view === 'add' ? 'Add Contact' : 'Save Changes'}
						</button>
					</div>
				)}

				{view === 'list' && (
					<ul className="contact-list">
						{contacts.map((contact) => (
							<li key={contact.id} className={busy ? 'busy' : ''}>
								<div className="contact-info">
									<strong>{contact.name}</strong>
									<span className="contact-email">{contact.email}</span>
									<span className="contact-role">{contact.role}</span>
								</div>
								<div className="contact-actions">
									<button className="btn-edit" onClick={() => startEdit(contact)} disabled={busy}>
										&#9998;
									</button>
									<button className="btn-delete" onClick={() => handleDelete(contact.id)} disabled={busy}>
										&times;
									</button>
								</div>
							</li>
						))}
						{contacts.length === 0 && <li className="empty">No contacts yet. Add one!</li>}
					</ul>
				)}
			</div>

			<p className="hint">
				Edit <code>src/app.tsx</code> for frontend, <code>worker/index.ts</code> for backend
			</p>
		</div>
	);
}
