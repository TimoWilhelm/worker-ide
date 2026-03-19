/**
 * AG-UI Event Helpers.
 *
 * Pure utility functions for parsing and constructing AG-UI protocol
 * stream events. Used throughout the agent loop to safely extract
 * typed fields from unknown event objects and create CUSTOM events.
 */

import { isRecordObject } from './utilities';

import type { StreamChunk } from '@tanstack/ai';

/**
 * Safely extract a string field from an unknown AG-UI event object.
 */
export function getEventField(event: unknown, field: string): string | undefined {
	if (!isRecordObject(event)) return undefined;
	const value = event[field];
	return typeof value === 'string' ? value : undefined;
}

/**
 * Safely extract a record field from an unknown AG-UI event object.
 */
export function getEventRecord(event: unknown, field: string): Record<string, unknown> | undefined {
	if (!isRecordObject(event)) return undefined;
	const value = event[field];
	return isRecordObject(value) ? value : undefined;
}

/**
 * Safely extract a number from a record by key.
 */
export function getNumberField(record: Record<string, unknown>, field: string): number {
	const value = record[field];
	return typeof value === 'number' ? value : 0;
}

/**
 * Create a CUSTOM AG-UI event.
 */
export function customEvent(name: string, data: Record<string, unknown>): StreamChunk {
	return { type: 'CUSTOM', name, data, timestamp: Date.now() };
}
