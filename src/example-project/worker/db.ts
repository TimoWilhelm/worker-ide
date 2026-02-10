// In-memory database module

export interface Todo {
  id: string;
  text: string;
  done: boolean;
}

// In-memory storage (resets on worker restart)
export const todos: Todo[] = [
  { id: '1', text: 'Learn Cloudflare Workers', done: true },
  { id: '2', text: 'Build a full-stack app', done: false },
  { id: '3', text: 'Deploy to the edge', done: false },
];
