interface Todo {
	id: string;
	text: string;
	done: boolean;
}

interface HelloResponse {
	message: string;
	timestamp: string;
}

export const api = {
	async hello(): Promise<HelloResponse> {
		const response = await fetch('/api/hello');
		return response.json();
	},

	async getTodos(): Promise<Todo[]> {
		const response = await fetch('/api/todos');
		return response.json();
	},

	async addTodo(text: string): Promise<Todo> {
		const response = await fetch('/api/todos', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text }),
		});
		return response.json();
	},

	async toggleTodo(id: string): Promise<Todo> {
		const response = await fetch(`/api/todos/${id}/toggle`, { method: 'POST' });
		return response.json();
	},

	async deleteTodo(id: string): Promise<Todo> {
		const response = await fetch(`/api/todos/${id}`, { method: 'DELETE' });
		return response.json();
	},
};
