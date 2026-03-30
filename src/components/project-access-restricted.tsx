/**
 * Project Access Restricted Page
 *
 * Displayed when navigating to a project that has been restricted.
 * Shows a generic "contact support" message without revealing the
 * specific reason for the restriction.
 */

import { Home, ShieldAlert } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';

export function ProjectAccessRestricted() {
	const navigate = useNavigate();

	useEffect(() => {
		document.title = 'Access Restricted';
	}, []);

	return (
		<div className="flex h-dvh items-center justify-center bg-bg-primary p-4">
			<main
				className="
					max-w-lg rounded-xl border border-border bg-bg-secondary p-10 shadow-lg
				"
				aria-labelledby="access-restricted-heading"
			>
				<div className="mb-3 flex items-center gap-3">
					<ShieldAlert className="size-6 text-text-secondary" aria-hidden="true" />
					<h1 id="access-restricted-heading" className="text-xl font-semibold text-text-primary">
						Unable to access project
					</h1>
				</div>
				<p className="mb-8 text-sm text-text-secondary">
					Please{' '}
					<a href="mailto:support@codemaxxing.com" className="underline hover:text-text-primary">
						contact support
					</a>{' '}
					for assistance.
				</p>
				<Button type="button" autoFocus onClick={() => navigate('/')}>
					<Home className="size-4" />
					Back to Home
				</Button>
			</main>
		</div>
	);
}
