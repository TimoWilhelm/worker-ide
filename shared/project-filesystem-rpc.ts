export interface ProjectFilesystemRpc {
	destroyStorage(): Promise<void>;
}

export interface ProjectFilesystemNamespace<Identifier> {
	idFromString(id: string): Identifier;
	get(id: Identifier): ProjectFilesystemRpc;
}
