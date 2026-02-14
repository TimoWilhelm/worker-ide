/**
 * Unit tests for content type utilities.
 */

import { describe, expect, it } from 'vitest';

import { getContentType } from './content-type';

describe('getContentType', () => {
	it('returns text/html for .html files', () => {
		expect(getContentType('/index.html')).toBe('text/html');
	});

	it('returns application/javascript for .js files', () => {
		expect(getContentType('/main.js')).toBe('application/javascript');
	});

	it('returns application/javascript for .mjs files', () => {
		expect(getContentType('/module.mjs')).toBe('application/javascript');
	});

	it('returns text/css for .css files', () => {
		expect(getContentType('/styles.css')).toBe('text/css');
	});

	it('returns application/json for .json files', () => {
		expect(getContentType('/data.json')).toBe('application/json');
	});

	it('returns image types for image files', () => {
		expect(getContentType('/image.png')).toBe('image/png');
		expect(getContentType('/photo.jpg')).toBe('image/jpeg');
		expect(getContentType('/photo.jpeg')).toBe('image/jpeg');
		expect(getContentType('/anim.gif')).toBe('image/gif');
		expect(getContentType('/image.webp')).toBe('image/webp');
		expect(getContentType('/icon.svg')).toBe('image/svg+xml');
		expect(getContentType('/favicon.ico')).toBe('image/x-icon');
	});

	it('returns font types for font files', () => {
		expect(getContentType('/font.woff')).toBe('font/woff');
		expect(getContentType('/font.woff2')).toBe('font/woff2');
		expect(getContentType('/font.ttf')).toBe('font/ttf');
	});

	it('returns text/plain for .txt files', () => {
		expect(getContentType('/readme.txt')).toBe('text/plain');
	});

	it('returns text/markdown for .md files', () => {
		expect(getContentType('/README.md')).toBe('text/markdown');
	});

	it('returns application/octet-stream for unknown extensions', () => {
		expect(getContentType('/file.xyz')).toBe('application/octet-stream');
	});

	it('returns application/octet-stream for files without extension', () => {
		expect(getContentType('/Makefile')).toBe('application/octet-stream');
	});
});
