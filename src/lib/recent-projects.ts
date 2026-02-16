/**
 * Recent Projects (localStorage) utilities.
 */

const RECENT_PROJECTS_KEY = 'worker-ide-recent-projects';
const MAX_RECENT_PROJECTS = 100;

export interface RecentProject {
	id: string;
	timestamp: number;
	name?: string;
}

export function getRecentProjects(): RecentProject[] {
	try {
		const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
		if (raw) {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed;
		}
	} catch {
		// ignore
	}
	return [];
}

export function trackProject(projectId: string, name?: string): void {
	let projects = getRecentProjects();
	const existing = projects.find((project) => project.id === projectId);
	projects = projects.filter((project) => project.id !== projectId);
	projects.unshift({ id: projectId, timestamp: Date.now(), name: name ?? existing?.name });
	if (projects.length > MAX_RECENT_PROJECTS) {
		projects = projects.slice(0, MAX_RECENT_PROJECTS);
	}
	localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
}

export function removeProject(projectId: string): void {
	const projects = getRecentProjects().filter((project) => project.id !== projectId);
	localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
}
