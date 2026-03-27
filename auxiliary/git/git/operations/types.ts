export interface Reference {
	name: string;
	oid: string;
}

export interface HeadInfo {
	target: string; // e.g., "refs/heads/main"
	oid?: string; // optional resolved OID if known
	unborn?: boolean; // true if the target ref is unborn
}
