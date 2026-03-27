/**
 * Collaboration constants for the Worker IDE application.
 */

/**
 * Maximum number of concurrent collaborators per project.
 * Limited by the number of available cursor colors.
 */
export const MAX_CONCURRENT_COLLABORATORS = 10;

/**
 * Colors for collaboration cursors
 */
export const COLLAB_COLORS = [
	'#f97316', // orange
	'#22d3ee', // cyan
	'#a78bfa', // purple
	'#f472b6', // pink
	'#4ade80', // green
	'#facc15', // yellow
	'#fb923c', // orange-400
	'#38bdf8', // sky
	'#c084fc', // violet
	'#34d399', // emerald
	'#e879f9', // fuchsia
] as const;
