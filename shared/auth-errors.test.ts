/**
 * Auth Error Messages Tests
 *
 * Ensures the error code lookup returns correct messages for known
 * Better Auth error codes and a fallback for unknown codes.
 */

import { describe, expect, it } from 'vitest';

import { getAuthErrorInfo } from './auth-errors';

describe('getAuthErrorInfo', () => {
	it('returns undefined for undefined input', () => {
		expect(getAuthErrorInfo()).toBeUndefined();
	});

	it('returns undefined for empty string', () => {
		expect(getAuthErrorInfo('')).toBeUndefined();
	});

	it('returns a specific message for unable_to_link_account', () => {
		const info = getAuthErrorInfo('unable_to_link_account');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Unable to Link Account');
		expect(info?.message).toContain('could not be linked');
	});

	it('returns a specific message for account_already_linked_to_different_user', () => {
		const info = getAuthErrorInfo('account_already_linked_to_different_user');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Account Already Linked');
		expect(info?.message).toContain('already connected to a different user');
	});

	it('returns a specific message for state_mismatch', () => {
		const info = getAuthErrorInfo('state_mismatch');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Session Expired');
		expect(info?.message).toContain('cookies');
	});

	it('returns a specific message for no_code', () => {
		const info = getAuthErrorInfo('no_code');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Authorization Denied');
	});

	it('returns a specific message for email_not_found', () => {
		const info = getAuthErrorInfo('email_not_found');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Email Not Available');
		expect(info?.message).toContain('privacy settings');
	});

	it("returns a specific message for email_doesn't_match", () => {
		const info = getAuthErrorInfo("email_doesn't_match");
		expect(info).toBeDefined();
		expect(info?.title).toBe('Email Mismatch');
	});

	it('returns a specific message for signup_disabled', () => {
		const info = getAuthErrorInfo('signup_disabled');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Sign-Up Disabled');
	});

	it('returns a specific message for state_not_found', () => {
		const info = getAuthErrorInfo('state_not_found');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Sign-In Session Not Found');
	});

	it('returns a specific message for invalid_callback_request', () => {
		const info = getAuthErrorInfo('invalid_callback_request');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Invalid Sign-In Request');
	});

	it('returns a specific message for unable_to_get_user_info', () => {
		const info = getAuthErrorInfo('unable_to_get_user_info');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Could Not Retrieve Profile');
	});

	it('returns a specific message for oauth_provider_not_found', () => {
		const info = getAuthErrorInfo('oauth_provider_not_found');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Provider Not Available');
	});

	it('returns a specific message for no_callback_url', () => {
		const info = getAuthErrorInfo('no_callback_url');
		expect(info).toBeDefined();
		expect(info?.title).toBe('Sign-In Configuration Error');
	});

	it('returns undefined for an unknown error code', () => {
		expect(getAuthErrorInfo('some_random_unknown_error')).toBeUndefined();
	});
});
