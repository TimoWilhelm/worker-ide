/**
 * Markdown Content Renderer
 *
 * Renders AI assistant markdown responses with proper formatting:
 * code blocks, inline code, lists, headings, bold, italic, links, tables.
 * Uses react-markdown with remark-gfm for GitHub-flavored markdown.
 */

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

const remarkPlugins = [remarkGfm];

/**
 * Renders a markdown string as properly styled React elements.
 */
export function MarkdownContent({ content, className }: { content: string; className?: string }) {
	return (
		<div className={cn('leading-relaxed wrap-break-word', className)}>
			<Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>
				{content}
			</Markdown>
		</div>
	);
}

/**
 * Custom component overrides for react-markdown.
 * Uses Tailwind utility classes for all styling.
 */
const markdownComponents = {
	// Code blocks and inline code
	pre({ children, ...properties }: React.ComponentProps<'pre'>) {
		return (
			<pre
				className="
					my-2 overflow-x-auto rounded-md bg-bg-primary p-2.5 font-mono
					text-xs/relaxed
				"
				{...properties}
			>
				{children}
			</pre>
		);
	},
	code({ children, className, ...properties }: React.ComponentProps<'code'>) {
		// If className contains "language-*", it's a fenced code block (inside <pre>)
		const isBlock = typeof className === 'string' && className.startsWith('language-');
		if (isBlock) {
			return (
				<code className="bg-transparent p-0 font-[inherit] text-inherit" {...properties}>
					{children}
				</code>
			);
		}
		// Inline code
		return (
			<code className="rounded-sm bg-bg-primary px-1.5 py-px font-mono text-xs" {...properties}>
				{children}
			</code>
		);
	},

	// Headings
	h1({ children, ...properties }: React.ComponentProps<'h1'>) {
		return (
			<h1
				className="
					mt-3 mb-1 text-sm font-bold text-text-primary
					first:mt-0
				"
				{...properties}
			>
				{children}
			</h1>
		);
	},
	h2({ children, ...properties }: React.ComponentProps<'h2'>) {
		return (
			<h2 className="mt-2.5 mb-1 text-sm font-semibold text-text-primary first:mt-0" {...properties}>
				{children}
			</h2>
		);
	},
	h3({ children, ...properties }: React.ComponentProps<'h3'>) {
		return (
			<h3 className="mt-2 mb-0.5 text-base font-semibold text-text-primary first:mt-0" {...properties}>
				{children}
			</h3>
		);
	},

	// Lists
	ul({ children, ...properties }: React.ComponentProps<'ul'>) {
		return (
			<ul className="my-1.5 list-disc pl-5" {...properties}>
				{children}
			</ul>
		);
	},
	ol({ children, ...properties }: React.ComponentProps<'ol'>) {
		return (
			<ol className="my-1.5 list-decimal pl-5" {...properties}>
				{children}
			</ol>
		);
	},
	li({ children, ...properties }: React.ComponentProps<'li'>) {
		return (
			<li className="my-0.5" {...properties}>
				{children}
			</li>
		);
	},

	// Links
	a({ children, href, ...properties }: React.ComponentProps<'a'>) {
		return (
			<a
				className="
					text-accent underline underline-offset-2
					hover:text-accent-hover
				"
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				{...properties}
			>
				{children}
			</a>
		);
	},

	// Block quotes
	blockquote({ children, ...properties }: React.ComponentProps<'blockquote'>) {
		return (
			<blockquote
				className="
					my-1.5 border-l-[3px] border-border-solid pl-3 text-text-secondary
				"
				{...properties}
			>
				{children}
			</blockquote>
		);
	},

	// Tables
	table({ children, ...properties }: React.ComponentProps<'table'>) {
		return (
			<div className="my-1.5 overflow-x-auto">
				<table className="w-full border-collapse text-xs" {...properties}>
					{children}
				</table>
			</div>
		);
	},
	th({ children, ...properties }: React.ComponentProps<'th'>) {
		return (
			<th
				className="
					border border-border-solid bg-bg-primary px-2 py-1 text-left font-semibold
				"
				{...properties}
			>
				{children}
			</th>
		);
	},
	td({ children, ...properties }: React.ComponentProps<'td'>) {
		return (
			<td className="border border-border-solid px-2 py-1" {...properties}>
				{children}
			</td>
		);
	},

	// Paragraphs
	p({ children, ...properties }: React.ComponentProps<'p'>) {
		return (
			<p
				className="
					my-0
					[&+&]:mt-2
				"
				{...properties}
			>
				{children}
			</p>
		);
	},

	// Horizontal rule
	hr(properties: React.ComponentProps<'hr'>) {
		return <hr className="my-2.5 border-t border-border-solid" {...properties} />;
	},

	// Strong / emphasis
	strong({ children, ...properties }: React.ComponentProps<'strong'>) {
		return (
			<strong className="font-semibold text-text-primary" {...properties}>
				{children}
			</strong>
		);
	},
	em({ children, ...properties }: React.ComponentProps<'em'>) {
		return (
			<em className="italic" {...properties}>
				{children}
			</em>
		);
	},
};
