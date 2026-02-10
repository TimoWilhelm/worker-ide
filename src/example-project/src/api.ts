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
    const res = await fetch('/api/hello');
    return res.json();
  },

  async getTodos(): Promise<Todo[]> {
    const res = await fetch('/api/todos');
    return res.json();
  },

  async addTodo(text: string): Promise<Todo> {
    const res = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.json();
  },

  async toggleTodo(id: string): Promise<Todo> {
    const res = await fetch(`/api/todos/${id}/toggle`, { method: 'POST' });
    return res.json();
  },

  async deleteTodo(id: string): Promise<Todo> {
    const res = await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    return res.json();
  },
};
