// Worker entry point - routes requests to handlers
import { hello, listTodos, addTodo, toggleTodo, deleteTodo } from './handlers';

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		console.log(`${method} ${path}`);

		if (path === '/api/hello' && method === 'GET') {
			return hello();
		}

		if (path === '/api/todos' && method === 'GET') {
			return listTodos();
		}

		if (path === '/api/todos' && method === 'POST') {
			return addTodo(request);
		}

		const toggleMatch = path.match(/^\/api\/todos\/([^/]+)\/toggle$/);
		if (toggleMatch && method === 'POST') {
			return toggleTodo(toggleMatch[1]);
		}

		const deleteMatch = path.match(/^\/api\/todos\/([^/]+)$/);
		if (deleteMatch && method === 'DELETE') {
			return deleteTodo(deleteMatch[1]);
		}

		return Response.json({ error: 'Not found' }, { status: 404 });
	},
};
