import { api } from './api';
import './style.css';

async function init() {
	const app = document.querySelector<HTMLDivElement>('#app')!;

	app.innerHTML = `
    <h1>&#9889; Workers Full-Stack</h1>
    <div class="card">
      <p class="status">Loading...</p>
      <div class="todos">
        <input type="text" id="todo-input" placeholder="Add a todo..." />
        <button id="add-btn">Add</button>
      </div>
      <ul id="todo-list"></ul>
    </div>
    <p class="hint">Edit <code>src/main.ts</code> for frontend, <code>worker/index.ts</code> for backend</p>
  `;

	const status = app.querySelector<HTMLParagraphElement>('.status')!;
	const input = document.querySelector<HTMLInputElement>('#todo-input')!;
	const addButton = document.querySelector<HTMLButtonElement>('#add-btn')!;
	const list = document.querySelector<HTMLUListElement>('#todo-list')!;

	try {
		const data = await api.hello();
		status.textContent = data.message;
	} catch {
		status.textContent = 'Error connecting to API';
	}

	let addingBusy = false;
	const busyIds = new Set<string>();

	async function loadTodos() {
		const todos = await api.getTodos();
		list.innerHTML = todos
			.map(
				(t) => `
      <li class="${busyIds.has(t.id) ? 'busy' : ''}">
        <span class="${t.done ? 'done' : ''}">${t.text}</span>
        <button data-id="${t.id}" class="toggle" ${busyIds.has(t.id) ? 'disabled' : ''}>${t.done ? '\u21A9' : '\u2713'}</button>
        <button data-id="${t.id}" class="delete" ${busyIds.has(t.id) ? 'disabled' : ''}>\u00D7</button>
      </li>
    `,
			)
			.join('');
	}

	await loadTodos();

	addButton.addEventListener('click', async () => {
		if (input.value.trim() && !addingBusy) {
			addingBusy = true;
			addButton.disabled = true;
			input.disabled = true;
			addButton.textContent = 'Adding...';
			try {
				await api.addTodo(input.value.trim());
				input.value = '';
			} finally {
				addingBusy = false;
				addButton.disabled = false;
				input.disabled = false;
				addButton.textContent = 'Add';
				await loadTodos();
			}
		}
	});

	input.addEventListener('keypress', (event) => {
		if (event.key === 'Enter') addButton.click();
	});

	list.addEventListener('click', async (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const id = target.dataset.id;
		if (!id || busyIds.has(id)) return;
		busyIds.add(id);
		await loadTodos();
		try {
			if (target.classList.contains('toggle')) {
				await api.toggleTodo(id);
			} else if (target.classList.contains('delete')) {
				await api.deleteTodo(id);
			}
		} finally {
			busyIds.delete(id);
			await loadTodos();
		}
	});
}

await init();
console.log('Init complete');
