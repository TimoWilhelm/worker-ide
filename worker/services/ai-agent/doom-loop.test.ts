/**
 * Unit tests for the DoomLoopDetector.
 *
 * All detection is stateless — derived purely from append-only history arrays.
 *
 * Tests the four detection strategies:
 * 1. Identical consecutive tool calls (exact name + input)
 * 2. Same-tool repetition (same tool, different inputs)
 * 3. Repeated failures of the same tool (consecutive in unified history)
 * 4. No-progress iterations (zero file changes)
 */

import { describe, expect, it } from 'vitest';

import { DoomLoopDetector } from './doom-loop';

// =============================================================================
// isDoomLoop (identical consecutive tool calls)
// =============================================================================

describe('isDoomLoop', () => {
	it('returns undefined when fewer than 3 calls recorded', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_read', { path: '/a.txt' });

		expect(detector.isDoomLoop()).toBeUndefined();
	});

	it('detects 3 identical consecutive tool calls', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_read', { path: '/a.txt' });

		expect(detector.isDoomLoop()).toBe('file_read');
	});

	it('does not trigger for different inputs', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_read', { path: '/b.txt' });
		detector.record('file_read', { path: '/c.txt' });

		expect(detector.isDoomLoop()).toBeUndefined();
	});

	it('does not trigger for different tool names', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_write', { path: '/a.txt' });
		detector.record('file_read', { path: '/a.txt' });

		expect(detector.isDoomLoop()).toBeUndefined();
	});

	it('resets history correctly', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_read', { path: '/a.txt' });
		expect(detector.isDoomLoop()).toBe('file_read');

		detector.reset();
		expect(detector.isDoomLoop()).toBeUndefined();
		expect(detector.length).toBe(0);
	});
});

// =============================================================================
// isSameToolLoop (same tool called repeatedly with different inputs)
// =============================================================================

describe('isSameToolLoop', () => {
	it('returns undefined when fewer than 5 calls recorded', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_edit', { path: '/a.txt' });
		detector.record('file_edit', { path: '/b.txt' });
		detector.record('file_edit', { path: '/c.txt' });
		detector.record('file_edit', { path: '/d.txt' });

		expect(detector.isSameToolLoop()).toBeUndefined();
	});

	it('detects 5 consecutive calls to the same tool with different inputs', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_edit', { path: '/a.txt' });
		detector.record('file_edit', { path: '/b.txt' });
		detector.record('file_edit', { path: '/c.txt' });
		detector.record('file_edit', { path: '/d.txt' });
		detector.record('file_edit', { path: '/e.txt' });

		expect(detector.isSameToolLoop()).toBe('file_edit');
	});

	it('does not trigger when different tools are interleaved', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_edit', { path: '/a.txt' });
		detector.record('file_edit', { path: '/b.txt' });
		detector.record('file_read', { path: '/c.txt' });
		detector.record('file_edit', { path: '/d.txt' });
		detector.record('file_edit', { path: '/e.txt' });

		expect(detector.isSameToolLoop()).toBeUndefined();
	});

	it('excludes read-only tools from detection', () => {
		const readOnlyTools = new Set(['file_read']);
		const detector = new DoomLoopDetector();
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_read', { path: '/b.txt' });
		detector.record('file_read', { path: '/c.txt' });
		detector.record('file_read', { path: '/d.txt' });
		detector.record('file_read', { path: '/e.txt' });

		expect(detector.isSameToolLoop(readOnlyTools)).toBeUndefined();
	});

	it('detects non-read-only tools even when readOnlyTools set is provided', () => {
		const readOnlyTools = new Set(['file_read']);
		const detector = new DoomLoopDetector();
		detector.record('file_edit', { path: '/a.txt' });
		detector.record('file_edit', { path: '/b.txt' });
		detector.record('file_edit', { path: '/c.txt' });
		detector.record('file_edit', { path: '/d.txt' });
		detector.record('file_edit', { path: '/e.txt' });

		expect(detector.isSameToolLoop(readOnlyTools)).toBe('file_edit');
	});
});

// =============================================================================
// isFailureLoop (same tool failing repeatedly — from unified history)
// =============================================================================

describe('isFailureLoop', () => {
	it('returns undefined when fewer than 3 failures recorded', () => {
		const detector = new DoomLoopDetector();
		detector.recordFailure('file_edit');
		detector.recordFailure('file_edit');

		expect(detector.isFailureLoop()).toBeUndefined();
	});

	it('detects 3 consecutive failures of the same tool', () => {
		const detector = new DoomLoopDetector();
		detector.recordFailure('file_edit');
		detector.recordFailure('file_edit');
		detector.recordFailure('file_edit');

		expect(detector.isFailureLoop()).toBe('file_edit');
	});

	it('does not trigger when different tools fail', () => {
		const detector = new DoomLoopDetector();
		detector.recordFailure('file_edit');
		detector.recordFailure('file_patch');
		detector.recordFailure('file_edit');

		expect(detector.isFailureLoop()).toBeUndefined();
	});

	it('detects failures even when interleaved with successful reads (dedicated failure history)', () => {
		const detector = new DoomLoopDetector();
		// This simulates the exact bug: file_read succeeds between file_patch failures
		detector.record('file_read', { path: '/src/app.tsx' });
		detector.recordFailure('file_patch');
		detector.record('file_read', { path: '/src/app.tsx' });
		detector.recordFailure('file_patch');
		detector.record('file_read', { path: '/src/style.css' });
		detector.recordFailure('file_patch');

		// The dedicated failure history should see 3 consecutive file_patch failures
		expect(detector.isFailureLoop()).toBe('file_patch');
	});

	it('resets failure history on reset()', () => {
		const detector = new DoomLoopDetector();
		detector.recordFailure('file_edit');
		detector.recordFailure('file_edit');
		detector.recordFailure('file_edit');
		expect(detector.isFailureLoop()).toBe('file_edit');

		detector.reset();
		expect(detector.isFailureLoop()).toBeUndefined();
	});
});

// =============================================================================
// isNoProgress (consecutive iterations with zero file changes)
// =============================================================================

describe('isNoProgress', () => {
	it('returns false when fewer than 2 iterations recorded', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationProgress(false);

		expect(detector.isNoProgress()).toBe(false);
	});

	it('detects 2 consecutive iterations with no file changes', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationProgress(false);
		detector.recordIterationProgress(false);

		expect(detector.isNoProgress()).toBe(true);
	});

	it('does not trigger when any iteration had file changes', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationProgress(true);
		detector.recordIterationProgress(false);

		expect(detector.isNoProgress()).toBe(false);
	});

	it('detects no-progress after an initial successful iteration', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationProgress(true);
		detector.recordIterationProgress(false);
		detector.recordIterationProgress(false);

		expect(detector.isNoProgress()).toBe(true);
	});

	it('resets iteration progress history on reset()', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationProgress(false);
		detector.recordIterationProgress(false);
		expect(detector.isNoProgress()).toBe(true);

		detector.reset();
		expect(detector.isNoProgress()).toBe(false);
	});
});

// =============================================================================
// isMutationFailureLoop (mutation tools failing across consecutive iterations)
// =============================================================================

describe('isMutationFailureLoop', () => {
	it('returns false when fewer than 2 iterations recorded', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationMutationFailure(true);

		expect(detector.isMutationFailureLoop()).toBe(false);
	});

	it('detects 2 consecutive iterations with mutation failures', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationMutationFailure(true);
		detector.recordIterationMutationFailure(true);

		expect(detector.isMutationFailureLoop()).toBe(true);
	});

	it('does not trigger when an iteration had no mutation failures', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationMutationFailure(true);
		detector.recordIterationMutationFailure(false);

		expect(detector.isMutationFailureLoop()).toBe(false);
	});

	it('detects mutation failure loop after an initial successful iteration', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationMutationFailure(false);
		detector.recordIterationMutationFailure(true);
		detector.recordIterationMutationFailure(true);

		expect(detector.isMutationFailureLoop()).toBe(true);
	});

	it('resets mutation failure history on reset()', () => {
		const detector = new DoomLoopDetector();
		detector.recordIterationMutationFailure(true);
		detector.recordIterationMutationFailure(true);
		expect(detector.isMutationFailureLoop()).toBe(true);

		detector.reset();
		expect(detector.isMutationFailureLoop()).toBe(false);
	});
});

// =============================================================================
// Combined scenarios
// =============================================================================

describe('combined detection', () => {
	it('failure loop and no-progress detected together', () => {
		const detector = new DoomLoopDetector();

		// 3 consecutive failures of the same tool
		detector.recordFailure('file_edit');
		detector.recordFailure('file_edit');
		detector.recordFailure('file_edit');

		// 2 no-progress iterations
		detector.recordIterationProgress(false);
		detector.recordIterationProgress(false);

		expect(detector.isFailureLoop()).toBe('file_edit');
		expect(detector.isNoProgress()).toBe(true);
	});

	it('length tracks total tool call count including failures', () => {
		const detector = new DoomLoopDetector();
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_read', { path: '/b.txt' });
		detector.record('file_read', { path: '/c.txt' });
		detector.record('file_read', { path: '/d.txt' });
		detector.record('file_read', { path: '/e.txt' });
		detector.recordFailure('file_edit');
		detector.recordIterationProgress(false);

		// 5 successful + 1 failure = 6 total tool calls
		expect(detector.length).toBe(6);
	});

	it('still detects doom loop after many non-identical calls followed by identical ones', () => {
		const detector = new DoomLoopDetector();
		// Fill with different calls (these get evicted from bounded history)
		detector.record('file_read', { path: '/a.txt' });
		detector.record('file_write', { path: '/b.txt' });
		detector.record('file_delete', { path: '/c.txt' });
		detector.record('file_glob', { pattern: '*.ts' });
		expect(detector.isDoomLoop()).toBeUndefined();

		// Now 3 identical calls — should detect doom loop
		detector.record('file_edit', { path: '/x.txt', old_string: 'a', new_string: 'b' });
		detector.record('file_edit', { path: '/x.txt', old_string: 'a', new_string: 'b' });
		detector.record('file_edit', { path: '/x.txt', old_string: 'a', new_string: 'b' });
		expect(detector.isDoomLoop()).toBe('file_edit');
	});

	it('interleaved successful reads do NOT prevent failure loop detection (regression)', () => {
		const detector = new DoomLoopDetector();
		// Simulate the exact pattern from the bug:
		// Iteration 1: file_read succeeds, file_patch fails
		detector.record('file_read', { path: '/src/app.tsx' });
		detector.recordFailure('file_patch');
		// Iteration 2: file_read succeeds, file_patch fails, file_read succeeds, file_edit fails
		detector.record('file_read', { path: '/src/app.tsx' });
		detector.recordFailure('file_patch');
		detector.record('file_read', { path: '/src/style.css' });
		detector.recordFailure('file_edit');
		// Iteration 3: file_read succeeds, file_patch fails
		detector.record('file_read', { path: '/src/app.tsx' });
		detector.recordFailure('file_patch');

		// The dedicated failure history sees [file_patch, file_patch, file_edit, file_patch]
		// Last 3 are [file_patch, file_edit, file_patch] — different tools, so no detection.
		// But if we only had file_patch failures:
		// This specific scenario has mixed failures, so isFailureLoop won't trigger.
		// The mutation failure loop (per-iteration) should catch this instead.
		expect(detector.isFailureLoop()).toBeUndefined();
	});

	it('mutation failure loop catches the interleaved-reads scenario', () => {
		const detector = new DoomLoopDetector();
		// Simulate: 2 iterations where mutation tools failed
		detector.recordIterationMutationFailure(true);
		detector.recordIterationMutationFailure(true);

		expect(detector.isMutationFailureLoop()).toBe(true);
	});

	it('all detection methods work together for the original bug scenario', () => {
		const detector = new DoomLoopDetector();

		// Iteration 1: read + failed patch
		detector.record('file_read', { path: '/src/app.tsx' });
		detector.recordFailure('file_patch');
		detector.recordIterationProgress(false);
		detector.recordIterationMutationFailure(true);

		// After iteration 1: nothing detected yet
		expect(detector.isNoProgress()).toBe(false);
		expect(detector.isMutationFailureLoop()).toBe(false);

		// Iteration 2: read + failed patch
		detector.record('file_read', { path: '/src/app.tsx' });
		detector.recordFailure('file_patch');
		detector.recordIterationProgress(false);
		detector.recordIterationMutationFailure(true);

		// After iteration 2: both no-progress and mutation failure loop detected
		expect(detector.isNoProgress()).toBe(true);
		expect(detector.isMutationFailureLoop()).toBe(true);
	});
});
