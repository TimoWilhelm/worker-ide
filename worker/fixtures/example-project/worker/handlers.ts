// API request handlers
import { todos, type Todo } from './database';

export function hello(): Response {
	return Response.json({
		message: 'Connected to Workers API!',
		timestamp: new Date().toISOString(),
	});
}

export function listTodos(): Response {
	return Response.json(todos);
}

export async function addTodo(request: Request): Promise<Response> {
	const body: { text: string } = await request.json();
	const todo: Todo = { id: crypto.randomUUID(), text: body.text, done: false };
	todos.push(todo);
	return Response.json(todo);
}

export function toggleTodo(id: string): Response {
	const todo = todos.find((t) => t.id === id);
	if (todo) {
		todo.done = !todo.done;
		return Response.json(todo);
	}
	return Response.json({ error: 'Not found' }, { status: 404 });
}

export function deleteTodo(id: string): Response {
	const index = todos.findIndex((t) => t.id === id);
	if (index !== -1) {
		const [deleted] = todos.splice(index, 1);
		return Response.json(deleted);
	}
	return Response.json({ error: 'Not found' }, { status: 404 });
}
