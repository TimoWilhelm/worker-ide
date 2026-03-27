/**
 * Author/committer signature extracted from a Git commit object.
 *
 * Format reference
 * - `Name <email> <unix-seconds> <tz>`
 *   Example: `John Doe <john@example.com> 1694025600 +0000`
 */
export interface Signature {
	name: string;
	email: string;
	when: number;
	tz: string;
}

export interface CommitParsed {
	tree: string;
	parents: string[];
	author?: Signature;
	committer?: Signature;
	message: string;
}

/**
 * Parse a Git signature line (author or committer).
 *
 * @param sig - A single line like `Name <email> 1694025600 +0000`
 * @returns A normalized `Signature` or `undefined` if the format does not match
 */
function parseSignature(sig: string): Signature | undefined {
	// Format: Name <email> 1694025600 +0000
	const m = sig.match(/^(.*) <([^>]+)>\s+(\d+)\s+([+-]\d{4})$/);
	if (!m) return undefined;
	const name = m[1];
	const email = m[2];
	const when = Number.parseInt(m[3], 10);
	const tz = m[4];
	return { name, email, when, tz };
}

/**
 * Parse a commit payload string (without the Git object header).
 *
 * Expected input
 * - The raw text after inflating a `commit` Git object and removing the
 *   `<type> <len>\0` header. Contains RFC-2822-ish lines and a blank line before
 *   the message body.
 *
 * Extracted fields
 * - `tree`: the root tree OID the commit points to
 * - `parents`: zero or more parent OIDs (first entry is the first-parent)
 * - `author`, `committer`: parsed signatures if present
 * - `message`: text after the first blank line (may be empty)
 */
export function parseCommitText(text: string): CommitParsed {
	const mTree = text.match(/^tree ([0-9a-f]{40})/m);
	const tree = mTree ? mTree[1] : '';
	const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map((x) => x[1]);
	const authorLine = (text.match(/^author (.+)$/m) || [])[1];
	const committerLine = (text.match(/^committer (.+)$/m) || [])[1];
	const author = authorLine ? parseSignature(authorLine) : undefined;
	const committer = committerLine ? parseSignature(committerLine) : undefined;
	const messageIndex = text.indexOf('\n\n');
	const message = messageIndex === -1 ? '' : text.slice(messageIndex + 2);
	return { tree, parents, author, committer, message };
}
