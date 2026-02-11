(function () {
	const PROJECT_STORAGE_KEY = 'worker-ide-project-id';
	const RECENT_PROJECTS_KEY = 'worker-ide-recent-projects';
	const MAX_RECENT_PROJECTS = 10;

	// Parse project ID from URL: /p/:projectId
	function getProjectIdFromUrl() {
		const match = location.pathname.match(/^\/p\/([a-f0-9]{64})/i);
		return match ? match[1].toLowerCase() : null;
	}

	// Get the base path for API calls based on current project
	function getBasePath() {
		const projectId = getProjectIdFromUrl();
		return projectId ? `/p/${projectId}` : '';
	}

	function getRecentProjects() {
		try {
			const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
			if (raw) return JSON.parse(raw);
		} catch {}
		return [];
	}

	function saveRecentProjects(projects) {
		localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
	}

	function trackProject(projectId) {
		let projects = getRecentProjects();
		projects = projects.filter(function (p) {
			return p.id !== projectId;
		});
		projects.unshift({ id: projectId, timestamp: Date.now() });
		if (projects.length > MAX_RECENT_PROJECTS) {
			projects = projects.slice(0, MAX_RECENT_PROJECTS);
		}
		saveRecentProjects(projects);
	}

	function formatRelativeTime(timestamp) {
		const seconds = Math.floor((Date.now() - timestamp) / 1000);
		if (seconds < 60) return 'just now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return minutes + 'm ago';
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return hours + 'h ago';
		const days = Math.floor(hours / 24);
		if (days < 30) return days + 'd ago';
		return new Date(timestamp).toLocaleDateString();
	}

	// Initialize project: check URL, localStorage, or create new
	async function initProject() {
		const urlProjectId = getProjectIdFromUrl();

		if (urlProjectId) {
			localStorage.setItem(PROJECT_STORAGE_KEY, urlProjectId);
			trackProject(urlProjectId);
			return urlProjectId;
		}

		// Check localStorage for a saved project
		const savedProjectId = localStorage.getItem(PROJECT_STORAGE_KEY);
		if (savedProjectId) {
			location.href = `/p/${savedProjectId}`;
			return null; // Will redirect
		}

		// No project found, create a new one
		const res = await fetch('/api/new-project', { method: 'POST' });
		const data = await res.json();
		if (data.projectId) {
			localStorage.setItem(PROJECT_STORAGE_KEY, data.projectId);
			trackProject(data.projectId);
			location.href = `/p/${data.projectId}`;
			return null; // Will redirect
		}
		throw new Error('Failed to create project');
	}

	let editor = null;
	let currentFile = null;
	let openFiles = new Map();
	let files = [];
	let saveTimeout = null;
	let basePath = '';

	// Collaboration state
	let collabSelfId = null;
	let collabSelfColor = null;
	let collabParticipants = new Map();
	let remoteCursors = new Map();
	let remoteSelections = new Map();
	let suppressRemoteEdit = false;
	let collabEditTimeout = null;

	const mobileToggle = document.getElementById('mobileToggle');
	const fileTreeEl = document.getElementById('fileTree');
	const tabsEl = document.getElementById('tabs');
	const editorEl = document.getElementById('editor');
	const fileStatusEl = document.getElementById('fileStatus');
	const saveStatusEl = document.getElementById('saveStatus');
	const previewFrame = document.getElementById('previewFrame');
	const refreshBtn = document.getElementById('refreshBtn');
	const newFileBtn = document.getElementById('newFileBtn');
	const shareBtn = document.getElementById('shareBtn');
	const downloadBtn = document.getElementById('downloadBtn');
	const newProjectBtn = document.getElementById('newProjectBtn');
	const modal = document.getElementById('modal');
	const modalInput = document.getElementById('modalInput');
	const modalConfirm = document.getElementById('modalConfirm');
	const modalCancel = document.getElementById('modalCancel');
	const modalClose = document.getElementById('modalClose');
	const terminalPanel = document.getElementById('terminalPanel');
	const terminalBody = document.getElementById('terminalBody');
	const terminalOutput = document.getElementById('terminalOutput');
	const clearTerminalBtn = document.getElementById('clearTerminalBtn');
	const toggleTerminalBtn = document.getElementById('toggleTerminalBtn');
	const errorBadge = document.getElementById('errorBadge');
	const warnBadge = document.getElementById('warnBadge');
	const logBadge = document.getElementById('logBadge');

	let terminalErrors = [];
	let errorSocket = null;
	let errorSocketReconnectDelay = 2000;

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
			const res = await fetch(`${basePath}/api/files`);
			const data = await res.json();
			files = data.files || [];
			renderFileTree();
		} catch (err) {
			console.error('Failed to load files:', err);
		}
	}

	function renderFileTree() {
		const sorted = [...files]
			.filter((path) => !path.endsWith('/.initialized'))
			.sort((a, b) => {
				const aDir = a.includes('/src/') || a.startsWith('/src');
				const bDir = b.includes('/src/') || b.startsWith('/src');
				if (aDir !== bDir) return bDir ? 1 : -1;
				return a.localeCompare(b);
			});

		const tree = {};
		sorted.forEach((path) => {
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
					var fileDots = '';
					collabParticipants.forEach(function (p) {
						if (p.id !== collabSelfId && p.file === value) {
							fileDots += '<span class="file-collab-dot" style="background:' + p.color + '"></span>';
						}
					});
					html += `<div class="file-item indent-${indent} ${active}" data-path="${escapedValue}">
						${getFileIcon(value)}
						${escapedName}
						${fileDots}
					</div>`;
				}
			});
			return html;
		}

		fileTreeEl.innerHTML = renderNode(tree);

		fileTreeEl.querySelectorAll('.file-item:not(.folder)').forEach((el) => {
			el.addEventListener('click', () => openFile(el.dataset.path));
		});
	}

	async function openFile(path) {
		if (openFiles.has(path)) {
			switchToFile(path);
			return;
		}

		try {
			const res = await fetch(`${basePath}/api/file?path=${encodeURIComponent(path)}`);
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
			suppressRemoteEdit = true;
			editor.setValue(fileData.content);
			suppressRemoteEdit = false;
			editor.setOption('mode', getModeForFile(path));
			editor.clearHistory();
		}
		fileStatusEl.textContent = path;
		renderTabs();
		renderFileTree();
		renderAllRemoteCursors();
		sendCursorUpdate();
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

			const res = await fetch(`${basePath}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, content }),
			});

			if (res.ok) {
				const fileData = openFiles.get(path);
				if (fileData) {
					fileData.content = content;
					fileData.modified = false;
				}
				saveStatusEl.textContent = 'Saved';
				renderTabs();
				setTimeout(() => {
					saveStatusEl.textContent = '';
				}, 2000);
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
				},
			},
		});

		editor.on('change', () => {
			if (!currentFile) return;
			if (suppressRemoteEdit) return;

			const fileToSave = currentFile;
			const fileData = openFiles.get(fileToSave);
			if (fileData) {
				const currentContent = editor.getValue();
				fileData.modified = currentContent !== fileData.content;
				renderTabs();

				clearTimeout(collabEditTimeout);
				collabEditTimeout = setTimeout(() => {
					sendFileEdit(fileToSave, editor.getValue());
				}, 150);

				clearTimeout(saveTimeout);
				saveTimeout = setTimeout(() => {
					const latestFileData = openFiles.get(fileToSave);
					if (latestFileData && latestFileData.modified) {
						saveFile(fileToSave, currentContent);
					}
				}, 1500);
			}
		});

		editor.on('cursorActivity', () => {
			sendCursorUpdate();
		});
	}

	function refreshPreview() {
		refreshBtn.disabled = true;
		previewFrame.src = `${basePath}/preview?t=` + Date.now();
		previewFrame.addEventListener(
			'load',
			() => {
				refreshBtn.disabled = false;
			},
			{ once: true },
		);
		setTimeout(() => {
			refreshBtn.disabled = false;
		}, 5000);
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

		modalConfirm.disabled = true;
		modalConfirm.textContent = 'Creating...';
		try {
			await fetch(`${basePath}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, content: '' }),
			});

			await loadFiles();
			openFile(path);
			hideModal();
		} catch (err) {
			alert('Failed to create file: ' + err.message);
		} finally {
			modalConfirm.disabled = false;
			modalConfirm.textContent = 'Create';
		}
	}

	refreshBtn.addEventListener('click', refreshPreview);
	newFileBtn.addEventListener('click', showModal);

	shareBtn.addEventListener('click', async () => {
		const url = location.href;
		try {
			await navigator.clipboard.writeText(url);
		} catch (err) {
			prompt('Copy this link to share your project:', url);
			return;
		}
		const existing = document.querySelector('.toast');
		if (existing) existing.remove();
		const toast = document.createElement('div');
		toast.className = 'toast';
		toast.textContent = 'Link copied to clipboard';
		document.body.appendChild(toast);
		setTimeout(() => toast.remove(), 1500);
	});

	downloadBtn.addEventListener('click', async () => {
		downloadBtn.disabled = true;
		try {
			const res = await fetch(`${basePath}/api/download`);
			if (!res.ok) throw new Error('Download failed');
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			const match = (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/);
			a.download = match ? match[1] : 'project.zip';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (err) {
			alert('Failed to download project: ' + err.message);
		} finally {
			downloadBtn.disabled = false;
		}
	});

	newProjectBtn.addEventListener('click', async () => {
		if (!confirm('Create a new project? Your current project will remain accessible via its URL.')) {
			return;
		}
		newProjectBtn.disabled = true;
		try {
			const res = await fetch('/api/new-project', { method: 'POST' });
			const data = await res.json();
			if (data.projectId) {
				localStorage.setItem(PROJECT_STORAGE_KEY, data.projectId);
				trackProject(data.projectId);
				location.href = `/p/${data.projectId}`;
			}
		} catch (err) {
			alert('Failed to create new project: ' + err.message);
		} finally {
			newProjectBtn.disabled = false;
		}
	});
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

	// Terminal panel functions
	function toggleTerminal() {
		terminalPanel.classList.toggle('expanded');
	}

	function formatTime(ts) {
		const d = new Date(ts);
		return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function escapeHtml(str) {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function updateBadges() {
		var errorCount = 0,
			warnCount = 0,
			logCount = 0;
		for (var i = 0; i < terminalErrors.length; i++) {
			var t = terminalErrors[i].type;
			if (t === 'error' || t === 'runtime' || t === 'bundle') errorCount++;
			else if (t === 'warn') warnCount++;
			else logCount++;
		}
		if (errorCount > 0) {
			errorBadge.textContent = errorCount;
			errorBadge.classList.remove('hidden');
		} else {
			errorBadge.classList.add('hidden');
		}
		if (warnCount > 0) {
			warnBadge.textContent = warnCount;
			warnBadge.classList.remove('hidden');
		} else {
			warnBadge.classList.add('hidden');
		}
		if (logCount > 0) {
			logBadge.textContent = logCount;
			logBadge.classList.remove('hidden');
		} else {
			logBadge.classList.add('hidden');
		}
	}

	function renderTerminalErrors() {
		if (terminalErrors.length === 0) {
			terminalOutput.innerHTML = '';
			errorBadge.classList.add('hidden');
			warnBadge.classList.add('hidden');
			logBadge.classList.add('hidden');
			return;
		}

		updateBadges();

		terminalOutput.innerHTML = terminalErrors
			.map((err) => {
				const safeType = escapeHtml(err.type || 'error');
				const safeFile = err.file ? escapeHtml(err.file) : '';
				const location = safeFile
					? `<span class="terminal-entry-location" data-file="/${safeFile}" data-line="${parseInt(err.line, 10) || 1}" data-column="${parseInt(err.column, 10) || 0}">${safeFile}${err.line ? ':' + err.line : ''}${err.column ? ':' + err.column : ''}</span>`
					: '';
				const shortMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
				return (
					'<div class="terminal-entry">' +
					'<div class="terminal-entry-header">' +
					'<span class="terminal-entry-type ' +
					safeType +
					'">' +
					safeType +
					'</span>' +
					'<span class="terminal-entry-time">' +
					formatTime(err.timestamp) +
					'</span>' +
					location +
					'</div>' +
					'<div class="terminal-entry-message">' +
					escapeHtml(shortMsg) +
					'</div>' +
					'</div>'
				);
			})
			.join('');

		terminalBody.scrollTop = terminalBody.scrollHeight;
	}

	function addServerError(err) {
		terminalErrors.push(err);
		if (terminalErrors.length > 50) {
			terminalErrors = terminalErrors.slice(-50);
		}
		renderTerminalErrors();
		if (!terminalPanel.classList.contains('expanded')) {
			toggleTerminal();
		}
	}

	function addServerLog(log) {
		terminalErrors.push({
			timestamp: log.timestamp,
			type: log.level || 'log',
			message: log.message,
		});
		if (terminalErrors.length > 100) {
			terminalErrors = terminalErrors.slice(-100);
		}
		renderTerminalErrors();
	}

	// --- Collaboration functions ---

	function collabSend(msg) {
		if (errorSocket && errorSocket.readyState === WebSocket.OPEN) {
			errorSocket.send(JSON.stringify(msg));
		}
	}

	function sendCursorUpdate() {
		if (!editor || !currentFile) return;
		var cursor = editor.getCursor();
		var anchor = editor.getCursor('anchor');
		var head = editor.getCursor('head');
		var hasSelection = anchor.line !== head.line || anchor.ch !== head.ch;
		collabSend({
			type: 'cursor-update',
			file: currentFile,
			cursor: { line: cursor.line, ch: cursor.ch },
			selection: hasSelection ? { anchor: { line: anchor.line, ch: anchor.ch }, head: { line: head.line, ch: head.ch } } : null,
		});
	}

	function sendFileEdit(path, content) {
		collabSend({ type: 'file-edit', path: path, content: content });
	}

	function clearRemoteCursors() {
		remoteCursors.forEach(function (bookmark) {
			if (bookmark) bookmark.clear();
		});
		remoteCursors.clear();
		remoteSelections.forEach(function (mark) {
			if (mark) mark.clear();
		});
		remoteSelections.clear();
	}

	function renderRemoteCursor(id, color, cursor, selection) {
		var old = remoteCursors.get(id);
		if (old) old.clear();
		var oldSel = remoteSelections.get(id);
		if (oldSel) oldSel.clear();

		if (!editor || !cursor) {
			remoteCursors.delete(id);
			remoteSelections.delete(id);
			return;
		}

		var el = document.createElement('span');
		el.className = 'remote-cursor';
		el.style.borderLeftColor = color;

		var flag = document.createElement('span');
		flag.className = 'remote-cursor-flag';
		flag.style.background = color;
		el.appendChild(flag);

		var bookmark = editor.setBookmark({ line: cursor.line, ch: cursor.ch }, { widget: el, insertLeft: true });
		remoteCursors.set(id, bookmark);

		if (selection && selection.anchor && selection.head) {
			var from = selection.anchor;
			var to = selection.head;
			if (from.line > to.line || (from.line === to.line && from.ch > to.ch)) {
				var tmp = from;
				from = to;
				to = tmp;
			}
			var r = parseInt(color.slice(1, 3), 16);
			var g = parseInt(color.slice(3, 5), 16);
			var b = parseInt(color.slice(5, 7), 16);
			var mark = editor.markText(
				{ line: from.line, ch: from.ch },
				{ line: to.line, ch: to.ch },
				{ css: 'background: rgba(' + r + ',' + g + ',' + b + ',0.25)' },
			);
			remoteSelections.set(id, mark);
		} else {
			remoteSelections.delete(id);
		}
	}

	function renderAllRemoteCursors() {
		clearRemoteCursors();
		collabParticipants.forEach(function (p) {
			if (p.id === collabSelfId) return;
			if (p.file === currentFile && p.cursor) {
				renderRemoteCursor(p.id, p.color, p.cursor, p.selection);
			}
		});
	}

	function renderParticipantsIndicator() {
		var container = document.getElementById('collabIndicator');
		if (!container) return;
		var dots = '';
		var count = 0;
		collabParticipants.forEach(function (p) {
			count++;
			var activeFile = p.file ? p.file.split('/').pop() : '';
			var isSelf = p.id === collabSelfId;
			var title = (isSelf ? 'You' : 'Participant') + (activeFile ? ' — ' + activeFile : '');
			dots +=
				'<span class="collab-dot' +
				(isSelf ? ' collab-dot-self' : '') +
				'" style="background:' +
				p.color +
				'" title="' +
				title +
				'"></span>';
		});
		if (count > 1) {
			dots += '<span class="collab-count">' + count + ' online</span>';
		}
		container.innerHTML = dots;
		container.style.display = count >= 1 ? 'flex' : 'none';
	}

	function handleCollabState(data) {
		collabSelfId = data.selfId;
		collabSelfColor = data.selfColor;
		collabParticipants.clear();
		(data.participants || []).forEach(function (p) {
			collabParticipants.set(p.id, p);
		});
		renderAllRemoteCursors();
		renderParticipantsIndicator();
		renderFileTree();
	}

	function handleParticipantJoined(data) {
		collabParticipants.set(data.participant.id, data.participant);
		renderAllRemoteCursors();
		renderParticipantsIndicator();
		renderFileTree();
	}

	function handleParticipantLeft(data) {
		collabParticipants.delete(data.id);
		var old = remoteCursors.get(data.id);
		if (old) old.clear();
		remoteCursors.delete(data.id);
		var oldSel = remoteSelections.get(data.id);
		if (oldSel) oldSel.clear();
		remoteSelections.delete(data.id);
		renderParticipantsIndicator();
		renderFileTree();
	}

	function handleCursorUpdated(data) {
		var p = collabParticipants.get(data.id);
		if (p) {
			p.file = data.file;
			p.cursor = data.cursor;
			p.color = data.color;
			p.selection = data.selection || null;
		} else {
			collabParticipants.set(data.id, {
				id: data.id,
				color: data.color,
				file: data.file,
				cursor: data.cursor,
				selection: data.selection || null,
			});
		}
		if (data.file === currentFile && data.cursor) {
			renderRemoteCursor(data.id, data.color, data.cursor, data.selection);
		} else {
			var old = remoteCursors.get(data.id);
			if (old) old.clear();
			remoteCursors.delete(data.id);
		}
		renderParticipantsIndicator();
		renderFileTree();
	}

	function handleFileEdited(data) {
		var fileData = openFiles.get(data.path);
		if (fileData) {
			fileData.content = data.content;
			fileData.modified = false;
			if (data.path === currentFile && editor) {
				var scrollInfo = editor.getScrollInfo();
				var cursor = editor.getCursor();
				suppressRemoteEdit = true;
				editor.setValue(data.content);
				editor.setCursor(cursor);
				editor.scrollTo(scrollInfo.left, scrollInfo.top);
				suppressRemoteEdit = false;
				renderAllRemoteCursors();
			}
			renderTabs();
		}
	}

	function connectErrorSocket() {
		if (errorSocket) {
			errorSocket.onclose = null;
			errorSocket.onerror = null;
			errorSocket.onmessage = null;
			if (errorSocket.readyState === WebSocket.OPEN || errorSocket.readyState === WebSocket.CONNECTING) {
				errorSocket.close();
			}
			errorSocket = null;
		}
		collabParticipants.clear();
		clearRemoteCursors();

		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const ws = new WebSocket(`${protocol}//${location.host}${basePath}/__hmr`);
		errorSocket = ws;
		ws.addEventListener('open', () => {
			errorSocketReconnectDelay = 2000;
			collabSend({ type: 'collab-join' });
		});
		ws.addEventListener('message', (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.type === 'server-error' && data.error) {
					addServerError(data.error);
				} else if (data.type === 'server-logs' && data.logs) {
					data.logs.forEach(function (log) {
						addServerLog(log);
					});
				} else if (data.type === 'server-ok') {
					var before = terminalErrors.length;
					terminalErrors = terminalErrors.filter(function (e) {
						return e.type !== 'runtime' && e.type !== 'bundle' && e.type !== 'error';
					});
					if (terminalErrors.length !== before) {
						renderTerminalErrors();
					}
				} else if (data.type === 'collab-state') {
					handleCollabState(data);
				} else if (data.type === 'participant-joined') {
					handleParticipantJoined(data);
				} else if (data.type === 'participant-left') {
					handleParticipantLeft(data);
				} else if (data.type === 'cursor-updated') {
					handleCursorUpdated(data);
				} else if (data.type === 'file-edited') {
					handleFileEdited(data);
				}
			} catch (e) {
				// ignore non-JSON messages
			}
		});
		ws.addEventListener('close', () => {
			if (errorSocket !== ws) return;
			errorSocket = null;
			collabParticipants.clear();
			clearRemoteCursors();
			renderParticipantsIndicator();
			const delay = errorSocketReconnectDelay;
			errorSocketReconnectDelay = Math.min(errorSocketReconnectDelay * 1.5, 30000);
			setTimeout(connectErrorSocket, delay);
		});
	}

	window.addEventListener('beforeunload', function () {
		if (errorSocket && errorSocket.readyState === WebSocket.OPEN) {
			errorSocket.close(1000, 'page unload');
		}
	});

	function clearTerminal() {
		terminalErrors = [];
		renderTerminalErrors();
	}

	terminalOutput.addEventListener('click', (e) => {
		const loc = e.target.closest('.terminal-entry-location');
		if (loc) {
			const filePath = loc.dataset.file;
			const line = parseInt(loc.dataset.line, 10) || 1;
			const col = parseInt(loc.dataset.column, 10) || 0;
			if (filePath) {
				openFile(filePath).then(() => {
					if (editor) {
						editor.setCursor({ line: line - 1, ch: col });
						editor.focus();
					}
				});
			}
		}
	});

	window.addEventListener('message', (event) => {
		if (event.data && event.data.type === '__open-file') {
			var filePath = event.data.file;
			var line = event.data.line || 1;
			var col = event.data.column || 0;
			if (filePath) {
				openFile(filePath).then(function () {
					if (editor) {
						editor.setCursor({ line: line - 1, ch: col });
						editor.focus();
					}
				});
			}
		}
	});

	toggleTerminalBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		toggleTerminal();
	});
	clearTerminalBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		clearTerminal();
	});
	document.querySelector('.terminal-header').addEventListener('click', toggleTerminal);

	mobileToggle.addEventListener('click', (e) => {
		const btn = e.target.closest('.mobile-toggle-btn');
		if (!btn) return;
		const panel = btn.dataset.panel;
		const mainEl = document.querySelector('.main');
		mobileToggle.querySelectorAll('.mobile-toggle-btn').forEach((b) => b.classList.remove('active'));
		btn.classList.add('active');
		mainEl.classList.remove('show-editor', 'show-preview', 'show-ai');
		mainEl.classList.add('show-' + panel);
		if (panel === 'editor' && editor) {
			editor.refresh();
		}
		if (panel === 'ai') {
			aiSidebar.classList.remove('hidden');
			aiPrompt.focus();
		}
	});

	// Recent projects dropdown
	const recentProjectsBtn = document.getElementById('recentProjectsBtn');
	const recentProjectsDropdown = document.getElementById('recentProjectsDropdown');

	function renderRecentProjects() {
		const projects = getRecentProjects();
		const currentId = getProjectIdFromUrl();

		if (projects.length <= 1) {
			recentProjectsDropdown.innerHTML = '<div class="recent-empty">No other projects yet</div>';
			return;
		}

		recentProjectsDropdown.innerHTML = projects
			.map(function (p) {
				const shortId = p.id.substring(0, 8);
				const isCurrent = p.id === currentId;
				const activeClass = isCurrent ? ' recent-item-active' : '';
				return (
					'<a href="/p/' +
					p.id +
					'" class="recent-item' +
					activeClass +
					'">' +
					'<span class="recent-item-id">' +
					shortId +
					(isCurrent ? ' (current)' : '') +
					'</span>' +
					'<span class="recent-item-time">' +
					formatRelativeTime(p.timestamp) +
					'</span>' +
					'</a>'
				);
			})
			.join('');
	}

	if (recentProjectsBtn) {
		recentProjectsBtn.addEventListener('click', function (e) {
			e.stopPropagation();
			renderRecentProjects();
			recentProjectsDropdown.classList.toggle('hidden');
		});
	}

	document.addEventListener('click', function (e) {
		if (recentProjectsDropdown && !recentProjectsDropdown.contains(e.target) && e.target !== recentProjectsBtn) {
			recentProjectsDropdown.classList.add('hidden');
		}
	});

	// =====================
	// AI Sidebar Functions
	// =====================

	const aiSidebar = document.getElementById('aiSidebar');
	const aiToggleBtn = document.getElementById('aiToggleBtn');
	const aiSidebarClose = document.getElementById('aiSidebarClose');
	const aiMessages = document.getElementById('aiMessages');
	const aiStatus = document.getElementById('aiStatus');
	const aiPrompt = document.getElementById('aiPrompt');
	const aiSend = document.getElementById('aiSend');
	const aiStopBtn = document.getElementById('aiStopBtn');
	const aiNewSessionBtn = document.getElementById('aiNewSessionBtn');
	const aiSessionListBtn = document.getElementById('aiSessionListBtn');
	const aiSessionDropdown = document.getElementById('aiSessionDropdown');

	let aiIsProcessing = false;
	let currentAbortController = null;

	// Session management
	let aiSessions = [];
	let activeSessionId = null;

	function createSession() {
		var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		var session = {
			id: id,
			label: 'New chat',
			history: [],
			messagesHtml: '',
			createdAt: Date.now(),
		};
		aiSessions.unshift(session);
		return session;
	}

	function getActiveSession() {
		if (!activeSessionId && aiSessions.length === 0) {
			var s = createSession();
			activeSessionId = s.id;
		}
		return (
			aiSessions.find(function (s) {
				return s.id === activeSessionId;
			}) || aiSessions[0]
		);
	}

	function switchToSession(sessionId) {
		// Save current session's messages HTML
		var current = aiSessions.find(function (s) {
			return s.id === activeSessionId;
		});
		if (current) {
			current.messagesHtml = aiMessages.innerHTML;
		}
		activeSessionId = sessionId;
		var target = getActiveSession();
		aiMessages.innerHTML = target.messagesHtml || '';
		if (!target.messagesHtml) {
			renderWelcomeMessage();
		}
		aiSessionDropdown.classList.add('hidden');
	}

	function startNewSession() {
		if (aiIsProcessing) {
			stopAgent();
		}
		// Save current session
		var current = aiSessions.find(function (s) {
			return s.id === activeSessionId;
		});
		if (current) {
			current.messagesHtml = aiMessages.innerHTML;
		}
		var session = createSession();
		activeSessionId = session.id;
		aiMessages.innerHTML = '';
		renderWelcomeMessage();
		aiPrompt.focus();
	}

	function renderWelcomeMessage() {
		aiMessages.innerHTML =
			'<div class="ai-welcome">' +
			'<div class="ai-welcome-icon">' +
			'<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
			'<path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path>' +
			'<circle cx="7.5" cy="14.5" r="1.5"></circle>' +
			'<circle cx="16.5" cy="14.5" r="1.5"></circle>' +
			'</svg>' +
			'</div>' +
			'<p>Ask me to help with your code. I can read, create, edit, and delete files in your project.</p>' +
			'<div class="ai-suggestions">' +
			'<button class="ai-suggestion" data-prompt="Add a dark mode toggle to the app">Add dark mode</button>' +
			'<button class="ai-suggestion" data-prompt="Explain what this project does">Explain project</button>' +
			'<button class="ai-suggestion" data-prompt="Add form validation to the input fields">Add validation</button>' +
			'</div>' +
			'</div>';
	}

	function renderSessionDropdown() {
		if (aiSessions.length === 0) {
			aiSessionDropdown.innerHTML = '<div class="ai-session-empty">No sessions yet</div>';
			return;
		}
		aiSessionDropdown.innerHTML = aiSessions
			.map(function (s) {
				var activeClass = s.id === activeSessionId ? ' active' : '';
				var label = escapeHtml(s.label);
				var time = formatRelativeTime(s.createdAt);
				return (
					'<button class="ai-session-item' +
					activeClass +
					'" data-session-id="' +
					s.id +
					'">' +
					'<span class="ai-session-item-label">' +
					label +
					'</span>' +
					'<span class="ai-session-item-time">' +
					time +
					'</span>' +
					'</button>'
				);
			})
			.join('');
	}

	function stopAgent() {
		if (currentAbortController) {
			currentAbortController.abort();
			currentAbortController = null;
		}
	}

	function setProcessingState(processing) {
		aiIsProcessing = processing;
		if (processing) {
			aiSend.classList.add('hidden');
			aiStopBtn.classList.remove('hidden');
		} else {
			aiSend.classList.remove('hidden');
			aiStopBtn.classList.add('hidden');
			aiSend.disabled = false;
		}
	}

	function toggleAiSidebar() {
		const isHidden = aiSidebar.classList.contains('hidden');
		if (isHidden) {
			aiSidebar.classList.remove('hidden');
			aiToggleBtn.classList.add('active');
			aiPrompt.focus();
		} else {
			aiSidebar.classList.add('hidden');
			aiToggleBtn.classList.remove('active');
		}
	}

	function showAiStatus(message) {
		aiStatus.classList.remove('hidden');
		aiStatus.querySelector('.ai-status-text').textContent = message;
	}

	function hideAiStatus() {
		aiStatus.classList.add('hidden');
	}

	function escapeHtmlForAi(str) {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function formatAiMessage(content) {
		// Simple markdown-like formatting
		let html = escapeHtmlForAi(content);

		// Code blocks
		html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
			return '<pre><code>' + code.trim() + '</code></pre>';
		});

		// Inline code
		html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

		// Bold
		html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

		// Italic
		html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

		// Line breaks
		html = html.replace(/\n/g, '<br>');

		return html;
	}

	function addAiMessage(role, content, isStreaming) {
		// Remove welcome message if present
		const welcome = aiMessages.querySelector('.ai-welcome');
		if (welcome) {
			welcome.remove();
		}

		// Check if we're updating an existing streaming message
		let existingMsg = null;
		if (isStreaming) {
			existingMsg = aiMessages.querySelector('.ai-message.streaming');
		}

		if (existingMsg) {
			existingMsg.querySelector('.ai-message-content').innerHTML = formatAiMessage(content);
		} else {
			const msgEl = document.createElement('div');
			msgEl.className = 'ai-message ' + role + (isStreaming ? ' streaming' : '');
			msgEl.innerHTML =
				'<div class="ai-message-role ' +
				role +
				'">' +
				(role === 'user' ? 'You' : 'AI') +
				'</div>' +
				'<div class="ai-message-content">' +
				formatAiMessage(content) +
				'</div>';
			aiMessages.appendChild(msgEl);
		}

		// Scroll to bottom
		aiMessages.scrollTop = aiMessages.scrollHeight;
	}

	function finalizeAiMessage() {
		const streaming = aiMessages.querySelector('.ai-message.streaming');
		if (streaming) {
			streaming.classList.remove('streaming');
		}
	}

	function addAiToolCall(toolName, args) {
		var details = '';
		if (args.path) {
			details = args.path;
		} else if (toolName === 'move_file' && args.from_path && args.to_path) {
			details = args.from_path + ' → ' + args.to_path;
		}

		var pill = document.createElement('span');
		pill.className = 'ai-tool-pill';
		pill.innerHTML =
			'<span class="ai-tool-name">' +
			escapeHtmlForAi(toolName) +
			'</span>' +
			(details ? '<span class="ai-tool-details">' + escapeHtmlForAi(details) + '</span>' : '');

		// Group consecutive tool calls into a single container
		var lastChild = aiMessages.lastElementChild;
		var group;
		if (lastChild && lastChild.classList.contains('ai-tool-group')) {
			group = lastChild;
		} else {
			group = document.createElement('div');
			group.className = 'ai-tool-group';
			group.innerHTML =
				'<svg class="ai-tool-group-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>';
			aiMessages.appendChild(group);
		}
		group.appendChild(pill);
		aiMessages.scrollTop = aiMessages.scrollHeight;
	}

	function addAiFileChange(path, action) {
		const changeEl = document.createElement('div');
		changeEl.className = 'ai-file-change' + (action === 'delete' ? ' delete' : '');

		let icon;
		let label;

		if (action === 'create') {
			icon =
				'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>';
			label = 'Created ' + path;
		} else if (action === 'edit') {
			icon =
				'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
			label = 'Modified ' + path;
		} else if (action === 'delete') {
			icon =
				'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
			label = 'Deleted ' + path;
		} else {
			icon =
				'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg>';
			label = action + ' ' + path;
		}

		changeEl.innerHTML = icon + '<span>' + escapeHtmlForAi(label) + '</span>';
		aiMessages.appendChild(changeEl);
		aiMessages.scrollTop = aiMessages.scrollHeight;
	}

	function addAiError(errorInfo) {
		// Remove welcome message if present
		const welcome = aiMessages.querySelector('.ai-welcome');
		if (welcome) {
			welcome.remove();
		}

		var errorEl = document.createElement('div');
		var isRateLimit = errorInfo.code === 'RATE_LIMIT_EXCEEDED';
		errorEl.className = 'ai-error' + (isRateLimit ? ' rate-limit' : '');

		var icon = isRateLimit
			? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>'
			: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

		var title = isRateLimit ? 'Rate Limit Exceeded' : 'Error';
		var message = errorInfo.message || 'An unexpected error occurred.';

		// Add helpful context for rate limits
		if (isRateLimit) {
			message += ' Please wait a moment before trying again.';
		}

		errorEl.innerHTML =
			'<div class="ai-error-header">' +
			icon +
			'<span>' +
			escapeHtmlForAi(title) +
			'</span></div>' +
			'<div class="ai-error-message">' +
			escapeHtmlForAi(message) +
			'</div>' +
			'<div class="ai-error-actions">' +
			'<button class="ai-error-btn primary" data-action="retry">' +
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>' +
			'Retry' +
			'</button>' +
			'<button class="ai-error-btn secondary" data-action="dismiss">Dismiss</button>' +
			'</div>';

		// Store the prompt for retry
		errorEl.dataset.prompt = errorInfo.prompt || '';

		// Add event listeners
		errorEl.querySelector('[data-action="retry"]').addEventListener('click', function () {
			var prompt = errorEl.dataset.prompt;
			errorEl.remove();
			if (prompt) {
				aiPrompt.value = prompt;
				sendAiPrompt();
			}
		});

		errorEl.querySelector('[data-action="dismiss"]').addEventListener('click', function () {
			errorEl.remove();
		});

		aiMessages.appendChild(errorEl);
		aiMessages.scrollTop = aiMessages.scrollHeight;
	}

	async function sendAiPrompt() {
		const prompt = aiPrompt.value.trim();
		if (!prompt || aiIsProcessing) return;

		var session = getActiveSession();

		setProcessingState(true);
		aiPrompt.value = '';
		aiPrompt.style.height = 'auto';

		// Update session label from first prompt
		if (session.history.length === 0) {
			session.label = prompt.length > 40 ? prompt.substring(0, 40) + '...' : prompt;
		}

		// Add user message
		addAiMessage('user', prompt);
		session.history.push({ role: 'user', content: prompt });

		let assistantMessage = '';
		showAiStatus('Starting...');

		// Track current turn reconstruction
		let currentAssistantContent = [];
		let currentToolResults = [];
		let tempHistory = [];

		try {
			currentAbortController = new AbortController();
			const response = await fetch(basePath + '/api/agent/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt: prompt,
					history: session.history.slice(0, -1),
				}),
				signal: currentAbortController.signal,
			});

			if (!response.ok) {
				const err = await response.json().catch(function () {
					return {};
				});
				// Create structured error with code for special handling
				var error = new Error(err.error || 'Request failed');
				error.code = err.code || null;
				error.status = response.status;
				throw error;
			}

			// Process SSE stream
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			const processEvent = (data) => {
				handleAiEvent(data, function (text) {
					assistantMessage += text;
					addAiMessage('assistant', assistantMessage, true);
				});

				// Reconstruct history
				if (data.type === 'message' && data.content) {
					// Append text block
					if (currentAssistantContent.length > 0 && currentAssistantContent[currentAssistantContent.length - 1].type === 'text') {
						currentAssistantContent[currentAssistantContent.length - 1].text += data.content;
					} else {
						currentAssistantContent.push({ type: 'text', text: data.content });
					}
				} else if (data.type === 'tool_call') {
					currentAssistantContent.push({
						type: 'tool_use',
						id: data.id,
						name: data.tool,
						input: data.args,
					});
				} else if (data.type === 'tool_result') {
					currentToolResults.push({
						type: 'tool_result',
						tool_use_id: data.tool_use_id,
						content: data.result,
					});
				} else if (data.type === 'turn_complete') {
					// Commit current turn
					if (currentAssistantContent.length > 0) {
						tempHistory.push({ role: 'assistant', content: [...currentAssistantContent] });
						currentAssistantContent = [];
					}
					if (currentToolResults.length > 0) {
						tempHistory.push({ role: 'user', content: [...currentToolResults] });
						currentToolResults = [];
					}
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						try {
							const data = JSON.parse(line.slice(6));
							processEvent(data);
						} catch (e) {
							console.error('Failed to parse SSE data:', e);
						}
					}
				}
			}

			// Process any remaining buffer
			if (buffer.startsWith('data: ')) {
				try {
					const data = JSON.parse(buffer.slice(6));
					processEvent(data);
				} catch (e) {
					// Ignore incomplete data
				}
			}
		} catch (err) {
			if (err.name === 'AbortError') {
				if (assistantMessage) {
					addAiMessage('assistant', assistantMessage + '\n\n*[Interrupted]*', true);
				} else {
					addAiMessage('assistant', '*[Interrupted]*');
				}
			} else {
				console.error('AI request failed:', err);
				// Remove the user message from history and UI since the request failed before assistant responded
				if (session.history.length > 0 && session.history[session.history.length - 1].role === 'user') {
					session.history.pop();
				}
				// Remove the last user message from UI if no assistant response yet
				if (!assistantMessage) {
					var lastUserMsg = aiMessages.querySelector('.ai-message.user:last-of-type');
					if (lastUserMsg && !lastUserMsg.nextElementSibling) {
						lastUserMsg.remove();
					}
				}
				// Show error with retry option
				addAiError({
					message: err.message,
					code: err.code || (err.status === 429 ? 'RATE_LIMIT_EXCEEDED' : null),
					prompt: prompt,
				});
			}
		} finally {
			currentAbortController = null;
			finalizeAiMessage();
			hideAiStatus();
			setProcessingState(false);

			// Commit any remaining accumulation (e.g. if turn_complete was missing or stream ended early)
			if (currentAssistantContent.length > 0) {
				tempHistory.push({ role: 'assistant', content: [...currentAssistantContent] });
			}
			if (currentToolResults.length > 0) {
				tempHistory.push({ role: 'user', content: [...currentToolResults] });
			}

			// Append accumulated history to session
			if (tempHistory.length > 0) {
				session.history.push(...tempHistory);
			} else if (assistantMessage && session.history[session.history.length - 1].role === 'user') {
				// Fallback for simple text-only responses if something went wrong with reconstruction
				session.history.push({ role: 'assistant', content: assistantMessage });
			}

			// Keep history manageable, ensure it starts on a user message
			// Note: structured history can be large, so limit by number of turns (messages)
			if (session.history.length > 20) {
				session.history = session.history.slice(-20);
				while (session.history.length > 0 && session.history[0].role !== 'user') {
					session.history.shift();
				}
			}

			// Save messages HTML to session
			session.messagesHtml = aiMessages.innerHTML;
		}
	}

	function handleAiEvent(data, appendMessage) {
		switch (data.type) {
			case 'status':
				showAiStatus(data.message);
				break;

			case 'message':
				if (data.content) {
					appendMessage(data.content);
				}
				break;

			case 'tool_call':
				addAiToolCall(data.tool, data.args || {});
				break;

			case 'tool_result':
				// Tool results are processed internally, no need to show
				break;

			case 'file_changed':
				addAiFileChange(data.path, data.action);
				// Refresh file tree and potentially update editor
				loadFiles();
				if (data.path === currentFile) {
					// Reload the current file if it was modified
					reloadCurrentFile();
				}
				break;

			case 'error':
				appendMessage('\n\nError: ' + data.message);
				break;

			case 'done':
				hideAiStatus();
				break;
		}
	}

	async function reloadCurrentFile() {
		if (!currentFile) return;
		try {
			const res = await fetch(basePath + '/api/file?path=' + encodeURIComponent(currentFile));
			if (res.ok) {
				const data = await res.json();
				if (data.content !== undefined) {
					const fileData = openFiles.get(currentFile);
					if (fileData) {
						fileData.content = data.content;
						fileData.modified = false;
						if (editor) {
							suppressRemoteEdit = true;
							var scrollInfo = editor.getScrollInfo();
							var cursor = editor.getCursor();
							editor.setValue(data.content);
							editor.setCursor(cursor);
							editor.scrollTo(scrollInfo.left, scrollInfo.top);
							suppressRemoteEdit = false;
						}
						renderTabs();
					}
				}
			}
		} catch (e) {
			console.error('Failed to reload file:', e);
		}
	}

	// AI sidebar event listeners
	if (aiToggleBtn) {
		aiToggleBtn.addEventListener('click', toggleAiSidebar);
	}

	if (aiSidebarClose) {
		aiSidebarClose.addEventListener('click', function () {
			aiSidebar.classList.add('hidden');
			aiToggleBtn.classList.remove('active');
		});
	}

	if (aiStopBtn) {
		aiStopBtn.addEventListener('click', function () {
			stopAgent();
		});
	}

	if (aiNewSessionBtn) {
		aiNewSessionBtn.addEventListener('click', function () {
			startNewSession();
		});
	}

	if (aiSessionListBtn) {
		aiSessionListBtn.addEventListener('click', function (e) {
			e.stopPropagation();
			renderSessionDropdown();
			aiSessionDropdown.classList.toggle('hidden');
		});
	}

	if (aiSessionDropdown) {
		aiSessionDropdown.addEventListener('click', function (e) {
			var item = e.target.closest('.ai-session-item');
			if (item && item.dataset.sessionId) {
				switchToSession(item.dataset.sessionId);
			}
		});
	}

	document.addEventListener('click', function (e) {
		if (aiSessionDropdown && !aiSessionDropdown.contains(e.target) && e.target !== aiSessionListBtn) {
			aiSessionDropdown.classList.add('hidden');
		}
	});

	if (aiSend) {
		aiSend.addEventListener('click', sendAiPrompt);
	}

	if (aiPrompt) {
		aiPrompt.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendAiPrompt();
			}
		});

		// Auto-resize textarea
		aiPrompt.addEventListener('input', function () {
			this.style.height = 'auto';
			this.style.height = Math.min(this.scrollHeight, 120) + 'px';
		});
	}

	// Handle suggestion buttons
	aiMessages.addEventListener('click', function (e) {
		const suggestion = e.target.closest('.ai-suggestion');
		if (suggestion && suggestion.dataset.prompt) {
			aiPrompt.value = suggestion.dataset.prompt;
			sendAiPrompt();
		}
	});

	// Initialize the app
	async function init() {
		let projectId;
		try {
			projectId = await initProject();
		} catch (err) {
			console.error('Failed to initialize project:', err);
			const safeMsg = String(err.message || err)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
			document.body.innerHTML =
				'<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#fff;font-family:system-ui;"><div style="text-align:center;"><h2>Failed to initialize project</h2><p>' +
				safeMsg +
				'</p><button onclick="location.reload()" style="padding:8px 16px;cursor:pointer;">Retry</button></div></div>';
			return;
		}
		if (!projectId) {
			// Redirecting, don't continue
			return;
		}

		basePath = getBasePath();

		// Update preview iframe src and URL display
		previewFrame.src = `${basePath}/preview`;
		document.getElementById('previewUrl').textContent = `${basePath}/preview`;

		initEditor();
		await loadFiles();
		const defaultFile = files.find((f) => f.endsWith('main.ts') || f.endsWith('main.js') || f.endsWith('index.js')) || files[0];
		if (defaultFile) {
			openFile(defaultFile);
		}

		var mainEl = document.querySelector('.main');
		mainEl.classList.add('ready');
		mainEl.classList.add('show-editor');

		// Connect WebSocket for server error notifications
		connectErrorSocket();
	}

	init();
})();
