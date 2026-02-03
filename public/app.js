(function() {
	let editor = null;
	let currentFile = null;
	let openFiles = new Map();
	let files = [];
	let saveTimeout = null;

	const fileTreeEl = document.getElementById('fileTree');
	const tabsEl = document.getElementById('tabs');
	const editorEl = document.getElementById('editor');
	const fileStatusEl = document.getElementById('fileStatus');
	const saveStatusEl = document.getElementById('saveStatus');
	const previewFrame = document.getElementById('previewFrame');
	const refreshBtn = document.getElementById('refreshBtn');
	const bundleBtn = document.getElementById('bundleBtn');
	const newFileBtn = document.getElementById('newFileBtn');
	const modal = document.getElementById('modal');
	const modalInput = document.getElementById('modalInput');
	const modalConfirm = document.getElementById('modalConfirm');
	const modalCancel = document.getElementById('modalCancel');
	const modalClose = document.getElementById('modalClose');

	function getModeForFile(path) {
		if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.jsx')) {
			return 'javascript';
		}
		if (path.endsWith('.css')) return 'css';
		if (path.endsWith('.html')) return 'htmlmixed';
		if (path.endsWith('.json')) return 'javascript';
		return 'javascript';
	}

	function getFileIcon(path) {
		if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.ts')) {
			return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#f7df1e" stroke-width="2"><path d="M12 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
		}
		if (path.endsWith('.css')) {
			return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#264de4" stroke-width="2"><path d="M12 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
		}
		if (path.endsWith('.html')) {
			return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#e34c26" stroke-width="2"><path d="M12 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
		}
		return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
	}

	async function loadFiles() {
		try {
			const res = await fetch('/api/files');
			const data = await res.json();
			files = data.files || [];
			renderFileTree();
		} catch (err) {
			console.error('Failed to load files:', err);
		}
	}

	function renderFileTree() {
		const sorted = [...files].sort((a, b) => {
			const aDir = a.includes('/src/') || a.startsWith('/src');
			const bDir = b.includes('/src/') || b.startsWith('/src');
			if (aDir !== bDir) return bDir ? 1 : -1;
			return a.localeCompare(b);
		});

		const tree = {};
		sorted.forEach(path => {
			const parts = path.split('/').filter(Boolean);
			let current = tree;
			parts.forEach((part, i) => {
				if (i === parts.length - 1) {
					current[part] = path;
				} else {
					current[part] = current[part] || {};
					current = current[part];
				}
			});
		});

		function renderNode(node, indent = 0) {
			let html = '';
			const entries = Object.entries(node).sort(([a, va], [b, vb]) => {
				const aIsDir = typeof va === 'object';
				const bIsDir = typeof vb === 'object';
				if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
				return a.localeCompare(b);
			});

			entries.forEach(([name, value]) => {
				if (typeof value === 'object') {
					html += `<div class="file-item folder indent-${indent}">
						<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
						</svg>
						${name}
					</div>`;
					html += renderNode(value, indent + 1);
				} else {
					const active = currentFile === value ? 'active' : '';
					const escapedName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
					const escapedValue = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
					html += `<div class="file-item indent-${indent} ${active}" data-path="${escapedValue}">
						${getFileIcon(value)}
						${escapedName}
					</div>`;
				}
			});
			return html;
		}

		fileTreeEl.innerHTML = renderNode(tree);

		fileTreeEl.querySelectorAll('.file-item:not(.folder)').forEach(el => {
			el.addEventListener('click', () => openFile(el.dataset.path));
		});
	}

	async function openFile(path) {
		if (openFiles.has(path)) {
			switchToFile(path);
			return;
		}

		try {
			const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
			if (!res.ok) {
				const errorData = await res.json().catch(() => ({}));
				console.error('Failed to open file:', errorData.error || res.statusText);
				return;
			}
			const data = await res.json();
			if (data.content === undefined) {
				console.error('Failed to open file: no content returned');
				return;
			}
			openFiles.set(path, { content: data.content, modified: false });
			renderTabs();
			switchToFile(path);
		} catch (err) {
			console.error('Failed to open file:', err);
		}
	}

	function switchToFile(path) {
		currentFile = path;
		const fileData = openFiles.get(path);
		if (fileData && editor) {
			editor.setValue(fileData.content);
			editor.setOption('mode', getModeForFile(path));
			editor.clearHistory();
		}
		fileStatusEl.textContent = path;
		renderTabs();
		renderFileTree();
	}

	function renderTabs() {
		tabsEl.innerHTML = '';
		openFiles.forEach((data, path) => {
			const name = path.split('/').pop();
			const active = currentFile === path ? 'active' : '';
			const modified = data.modified ? 'modified' : '';
			const tab = document.createElement('div');
			tab.className = `tab ${active} ${modified}`;
			tab.innerHTML = `
				<span>${name}</span>
				<span class="tab-close" data-path="${path}">×</span>
			`;
			tab.addEventListener('click', (e) => {
				if (!e.target.classList.contains('tab-close')) {
					switchToFile(path);
				}
			});
			tab.querySelector('.tab-close').addEventListener('click', (e) => {
				e.stopPropagation();
				closeFile(path);
			});
			tabsEl.appendChild(tab);
		});
	}

	function closeFile(path) {
		openFiles.delete(path);
		if (currentFile === path) {
			const remaining = Array.from(openFiles.keys());
			if (remaining.length > 0) {
				switchToFile(remaining[0]);
			} else {
				currentFile = null;
				editor.setValue('');
				fileStatusEl.textContent = 'No file selected';
			}
		}
		renderTabs();
	}

	async function saveFile(path, content) {
		try {
			saveStatusEl.textContent = 'Saving...';
			saveStatusEl.className = '';

			const res = await fetch('/api/file', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, content })
			});

			if (res.ok) {
				const fileData = openFiles.get(path);
				if (fileData) {
					fileData.content = content;
					fileData.modified = false;
				}
				saveStatusEl.textContent = 'Saved';
				renderTabs();
				setTimeout(() => { saveStatusEl.textContent = ''; }, 2000);
			} else {
				throw new Error('Save failed');
			}
		} catch (err) {
			saveStatusEl.textContent = 'Save failed';
			saveStatusEl.className = 'error';
			console.error('Failed to save:', err);
		}
	}

	function initEditor() {
		editor = CodeMirror.fromTextArea(editorEl, {
			theme: 'dracula',
			lineNumbers: true,
			indentUnit: 2,
			tabSize: 2,
			indentWithTabs: true,
			electricChars: true,
			autoCloseBrackets: true,
			matchBrackets: true,
			lineWrapping: false,
			extraKeys: {
				'Cmd-S': () => {
					if (currentFile) {
						saveFile(currentFile, editor.getValue());
					}
				},
				'Ctrl-S': () => {
					if (currentFile) {
						saveFile(currentFile, editor.getValue());
					}
				}
			}
		});

		editor.on('change', () => {
			if (!currentFile) return;

			const fileToSave = currentFile;
			const fileData = openFiles.get(fileToSave);
			if (fileData) {
				const currentContent = editor.getValue();
				fileData.modified = currentContent !== fileData.content;
				renderTabs();

				clearTimeout(saveTimeout);
				saveTimeout = setTimeout(() => {
					const latestFileData = openFiles.get(fileToSave);
					if (latestFileData && latestFileData.modified) {
						saveFile(fileToSave, currentContent);
					}
				}, 1500);
			}
		});
	}

	function refreshPreview() {
		previewFrame.src = '/preview?t=' + Date.now();
	}

	async function bundle() {
		bundleBtn.disabled = true;
		bundleBtn.textContent = 'Bundling...';

		try {
			const res = await fetch('/api/bundle', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ minify: false })
			});
			const data = await res.json();

			if (data.success) {
				console.log('Bundle output:', data.code);
				alert('Bundle complete! Check console for output.');
			} else {
				alert('Bundle failed: ' + (data.error || 'Unknown error'));
			}
		} catch (err) {
			alert('Bundle failed: ' + err.message);
		} finally {
			bundleBtn.disabled = false;
			bundleBtn.textContent = 'Bundle';
		}
	}

	function showModal() {
		modal.classList.remove('hidden');
		modalInput.value = '/src/';
		modalInput.focus();
		modalInput.setSelectionRange(5, 5);
	}

	function hideModal() {
		modal.classList.add('hidden');
		modalInput.value = '';
	}

	async function createFile(path) {
		if (!path || !path.startsWith('/')) {
			alert('Path must start with /');
			return;
		}

		try {
			await fetch('/api/file', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, content: '' })
			});

			await loadFiles();
			openFile(path);
			hideModal();
		} catch (err) {
			alert('Failed to create file: ' + err.message);
		}
	}

	refreshBtn.addEventListener('click', refreshPreview);
	bundleBtn.addEventListener('click', bundle);
	newFileBtn.addEventListener('click', showModal);
	modalCancel.addEventListener('click', hideModal);
	modalClose.addEventListener('click', hideModal);
	modalConfirm.addEventListener('click', () => createFile(modalInput.value));
	modalInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') createFile(modalInput.value);
		if (e.key === 'Escape') hideModal();
	});
	modal.addEventListener('click', (e) => {
		if (e.target === modal) hideModal();
	});

	initEditor();
	loadFiles().then(() => {
		const defaultFile = files.find(f => f.endsWith('main.js') || f.endsWith('index.js')) || files[0];
		if (defaultFile) {
			openFile(defaultFile);
		}
	});
})();
