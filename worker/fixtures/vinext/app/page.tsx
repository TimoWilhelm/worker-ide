import { Counter } from './counter';

export default function Page() {
	return (
		<main className="container">
			<h1>Hello vinext</h1>
			<p>
				This page is a React Server Component. The button below is a Client Component (<code>&quot;use client&quot;</code>) hydrated in the
				browser.
			</p>
			<Counter />
		</main>
	);
}
