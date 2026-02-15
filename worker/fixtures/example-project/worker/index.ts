// Worker entry point - Hono API
import { Hono } from 'hono';

import { contacts, type Contact } from './database';

const app = new Hono();

// List all contacts
app.get('/api/contacts', (c) => {
	return c.json(contacts);
});

// Get a single contact
app.get('/api/contacts/:id', (c) => {
	const contact = contacts.find((item) => item.id === c.req.param('id'));
	if (!contact) return c.json({ error: 'Not found' }, 404);
	return c.json(contact);
});

// Create a new contact
app.post('/api/contacts', async (c) => {
	const body = await c.req.json<{ name: string; email: string; role?: string }>();
	const contact: Contact = {
		id: crypto.randomUUID(),
		name: body.name,
		email: body.email,
		role: body.role || 'Member',
	};
	contacts.push(contact);
	console.log(`Created contact: ${contact.name}`);
	return c.json(contact, 201);
});

// Update a contact
app.put('/api/contacts/:id', async (c) => {
	const id = c.req.param('id');
	const contact = contacts.find((item) => item.id === id);
	if (!contact) return c.json({ error: 'Not found' }, 404);
	const body = await c.req.json<{ name?: string; email?: string; role?: string }>();
	if (body.name) contact.name = body.name;
	if (body.email) contact.email = body.email;
	if (body.role) contact.role = body.role;
	console.log(`Updated contact: ${contact.name}`);
	return c.json(contact);
});

// Delete a contact
app.delete('/api/contacts/:id', (c) => {
	const id = c.req.param('id');
	const index = contacts.findIndex((item) => item.id === id);
	if (index === -1) return c.json({ error: 'Not found' }, 404);
	const [deleted] = contacts.splice(index, 1);
	console.log(`Deleted contact: ${deleted.name}`);
	return c.json(deleted);
});

// Catch-all
app.all('*', (c) => {
	return c.json({ error: 'Not found' }, 404);
});

export default app;
