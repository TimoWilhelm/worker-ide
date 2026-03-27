import { asBodyInit, createLogger } from '@git/common/index';
import { getDb, oidExistsInPacks, insertPackOids } from '@git/do/repo/db/index';
import { asTypedStorage, objKey } from '@git/do/repo/repo-state';
import { scheduleAlarmIfSooner } from '@git/do/repo/scheduler';
import { parsePktSection, pktLine, flushPkt, concatChunks } from '@git/git/core/pktline';
import { indexPackOnly, createMemPackFs, createLooseLoader } from '@git/git/pack/index';
import { r2PackKey, r2LooseKey, packIndexKey } from '@git/keys';
import * as git from 'isomorphic-git';

import type { Head, RepoStateSchema, TypedStorage } from '@git/do/repo/repo-state';

// Connectivity check for receive-pack commands.
// Ensures that each updated ref points to an object we can resolve immediately:
// - commits must have their root tree present
// - annotated tags are unwrapped (up to a few levels) and their targets are validated
// - direct tree/blob refs are accepted if present in the incoming pack or storage
async function runConnectivityCheck(arguments_: {
	pack: Uint8Array;
	packKey?: string;
	cmds: { oldOid: string; newOid: string; ref: string }[];
	statuses: { ref: string; ok: boolean; msg?: string }[];
	state: DurableObjectState;
	store: TypedStorage<RepoStateSchema>;
	env: GitWorkerEnvironment;
	prefix: string;
	log: ReturnType<typeof createLogger>;
}) {
	const { pack, packKey: _packKey, cmds, statuses, state, store, env, prefix, log } = arguments_;

	// Get database connection once for the entire connectivity check
	const database = getDb(state.storage);

	try {
		const lastPackOids = (await store.get('lastPackOids')) || [];
		const newOidsSet = new Set(lastPackOids.map((x) => x.toLowerCase()));
		// Build a small FS over the incoming pack + its idx to read objects
		const files = new Map<string, Uint8Array>();
		files.set(`/git/objects/pack/pack-input.pack`, new Uint8Array(pack));
		const looseLoader = createLooseLoader(store, env, prefix);
		const fs = createMemPackFs(files, { looseLoader });
		const dir = '/git';
		// Build an in-memory idx for the incoming pack to enable oid lookups reliably
		const currentPackOids = new Set<string>();
		try {
			const idxRes: any = await git.indexPack({
				fs,
				dir,
				filepath: `objects/pack/pack-input.pack`,
			});
			if (idxRes && Array.isArray(idxRes.oids)) {
				for (const oid of idxRes.oids) currentPackOids.add(String(oid).toLowerCase());
			}
		} catch {}

		// Per-run memo caches to avoid repeated reads
		const hasCache = new Map<string, boolean>();
		const treeCache = new Map<string, boolean>();
		const blobCache = new Map<string, boolean>();
		const kindCache = new Map<string, FinalKind>();

		const hasObject = async (oid: string): Promise<boolean> => {
			const lc = oid.toLowerCase();
			if (hasCache.has(lc)) return hasCache.get(lc)!;
			let ok = false;
			if (currentPackOids.has(lc))
				ok = true; // present in incoming pack index
			else if (newOidsSet && newOidsSet.has(lc)) ok = true;
			else if (await store.get(objKey(lc))) ok = true;
			else {
				try {
					if (await env.REPO_BUCKET.head(r2LooseKey(prefix, lc))) ok = true;
				} catch {}
				if (!ok) {
					// Check SQLite for pack membership - query by OID directly
					ok = await oidExistsInPacks(database, lc);
				}
			}
			hasCache.set(lc, ok);
			return ok;
		};

		const ensureTreePresent = async (treeOid: string): Promise<boolean> => {
			const tLc = treeOid.toLowerCase();
			const cached = treeCache.get(tLc);
			if (cached !== undefined) return cached;
			let ok = false;

			// First check if tree is in the incoming pack (required for thin packs)
			if (currentPackOids.has(tLc)) {
				ok = true;
			} else {
				// Try to read from the incoming pack via isomorphic-git
				try {
					await git.readObject({ fs, dir, oid: tLc, format: 'content' });
					ok = true;
				} catch {}

				if (!ok) {
					try {
						const object = (await git.readObject({ fs, dir, oid: tLc, format: 'parsed' })) || null;
						if (object && object.type === 'tree') ok = true;
					} catch {}
				}

				// Only fall back to checking existing storage if not in incoming pack
				if (!ok) ok = await hasObject(tLc);
			}

			treeCache.set(tLc, ok);
			return ok;
		};

		const ensureBlobPresent = async (oid: string): Promise<boolean> => {
			const lc = oid.toLowerCase();
			const cached = blobCache.get(lc);
			if (cached !== undefined) return cached;
			let ok = false;
			try {
				await git.readObject({ fs, dir, oid: lc, format: 'content' });
				ok = true; // present in incoming pack
			} catch {}
			if (!ok) ok = await hasObject(lc);
			blobCache.set(lc, ok);
			return ok;
		};

		const readKind = async (oid: string): Promise<FinalKind> => {
			const lc = oid.toLowerCase();
			const cached = kindCache.get(lc);
			if (cached) return cached;
			// Commit fast path (we need commit.tree)
			try {
				const info = await git.readCommit({ fs, dir, oid: lc });
				const tree = String(info.commit.tree);
				const k: FinalKind = { type: 'commit', oid: lc, tree };
				kindCache.set(lc, k);
				return k;
			} catch {}
			// Parsed object
			try {
				const object = (await git.readObject({ fs, dir, oid: lc, format: 'parsed' })) || null;
				if (object?.type === 'tree') {
					const k: FinalKind = { type: 'tree', oid: lc };
					kindCache.set(lc, k);
					return k;
				}
				if (object?.type === 'blob') {
					const k: FinalKind = { type: 'blob', oid: lc };
					kindCache.set(lc, k);
					return k;
				}
				if (object?.type === 'tag') {
					const tagObject = object.object as { object?: string; type?: string } | undefined;
					const targetOid = (tagObject?.object || '').toLowerCase();
					const targetType = (tagObject?.type || '') as 'commit' | 'tree' | 'blob' | 'tag' | '';
					if (targetOid && (targetType === 'commit' || targetType === 'tree' || targetType === 'blob' || targetType === 'tag')) {
						const k: FinalKind = { type: 'tag', oid: lc, targetOid, targetType };
						kindCache.set(lc, k);
						return k;
					}
				}
			} catch {}
			// Raw content fallback for tag
			try {
				const raw = (await git.readObject({ fs, dir, oid: lc, format: 'content' })) || null;
				if (raw?.type === 'tag' && raw.object instanceof Uint8Array) {
					const text = new TextDecoder().decode(raw.object);
					const mObject = text.match(/^object\s+([0-9a-f]{40})/m);
					const mType = text.match(/^type\s+(\w+)/m);
					const targetOid = (mObject ? mObject[1] : '').toLowerCase();
					const targetType = (mType ? mType[1] : '') as 'commit' | 'tree' | 'blob' | 'tag' | '';
					if (targetOid && (targetType === 'commit' || targetType === 'tree' || targetType === 'blob' || targetType === 'tag')) {
						const k: FinalKind = { type: 'tag', oid: lc, targetOid, targetType };
						kindCache.set(lc, k);
						return k;
					}
				}
			} catch {}
			const k: FinalKind = { type: 'unknown', oid: lc };
			kindCache.set(lc, k);
			return k;
		};

		const unwrapTagToFinal = async (oid: string, maxDepth = 3): Promise<FinalKind> => {
			let currentOid = oid.toLowerCase();
			let depth = 0;
			while (depth < maxDepth) {
				const k = await readKind(currentOid);
				if (k.type !== 'tag') return k; // already final
				currentOid = k.targetOid; // follow tag target
				depth++;
			}
			// Depth exceeded or unresolved
			return { type: 'unknown', oid: currentOid };
		};

		for (const [index, c] of cmds.entries()) {
			const st = statuses[index];
			const isZeroNew = /^0{40}$/i.test(c.newOid);
			if (!st?.ok || isZeroNew) continue; // skip deletes and already-invalid
			try {
				const newOidLc = c.newOid.toLowerCase();
				// Resolve to a final kind (unwrap tags as needed)
				let kind = await readKind(newOidLc);
				if (kind.type === 'tag') kind = await unwrapTagToFinal(newOidLc);

				switch (kind.type) {
					case 'commit': {
						const okTree = await ensureTreePresent(kind.tree);
						if (!okTree) {
							log.warn('connectivity:missing-tree', {
								ref: c.ref,
								tree: kind.tree,
								inPack: currentPackOids.has(kind.tree.toLowerCase()),
								inStorage: await hasObject(kind.tree.toLowerCase()),
							});
							statuses[index] = { ref: c.ref, ok: false, msg: 'missing-objects' };
							break;
						}
						// Phase 2: also ensure all parents exist (basic connectivity)
						try {
							const info = await git.readCommit({ fs, dir, oid: newOidLc });
							const parents: string[] = Array.isArray(info?.commit?.parent) ? info.commit.parent || [] : [];
							for (const p of parents) {
								const exists = await hasObject(String(p).toLowerCase());
								if (!exists) {
									log.warn('connectivity:missing-parent', { ref: c.ref, parent: String(p) });
									statuses[index] = { ref: c.ref, ok: false, msg: 'missing-objects' };
									break;
								}
							}
						} catch {}
						break;
					}
					case 'tree': {
						const ok = await ensureTreePresent(kind.oid);
						if (!ok) {
							log.warn('connectivity:missing-tree', { ref: c.ref, tree: kind.oid });
							statuses[index] = { ref: c.ref, ok: false, msg: 'missing-objects' };
						}
						break;
					}
					case 'blob': {
						const ok = await ensureBlobPresent(kind.oid);
						if (!ok) {
							log.warn('connectivity:missing-blob', { ref: c.ref, blob: kind.oid });
							statuses[index] = { ref: c.ref, ok: false, msg: 'missing-objects' };
						}
						break;
					}
					case 'unknown': {
						log.warn('connectivity:unknown-type-or-missing', { ref: c.ref, oid: newOidLc });
						statuses[index] = { ref: c.ref, ok: false, msg: 'missing-objects' };
						break;
					}
				}
			} catch {
				// Cannot read new object from pack+idx+loose bases -> reject
				log.warn('connectivity:cannot-read-new', { ref: c.ref, oid: c.newOid.toLowerCase() });
				statuses[index] = { ref: c.ref, ok: false, msg: 'missing-objects' };
			}
		}
	} catch (error) {
		log.warn('connectivity:check-failed', { error: String(error) });
	}
}

type FinalKind =
	| { type: 'commit'; oid: string; tree: string }
	| { type: 'tree'; oid: string }
	| { type: 'blob'; oid: string }
	| { type: 'tag'; oid: string; targetOid: string; targetType: 'commit' | 'tree' | 'blob' | 'tag' }
	| { type: 'unknown'; oid: string };

/**
 * Handle git-receive-pack POST inside the Durable Object.
 *
 * @param state Durable Object state
 * @param env Worker environment (R2 bucket, vars)
 * @param prefix DO prefix for R2 keys, e.g., `do/<id>`
 * @param request Request from the Worker containing push data
 * @returns Response with `application/x-git-receive-pack-result` body (pkt-line `report-status`)
 */
export async function receivePack(
	state: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	request: Request,
): Promise<Response> {
	const store = asTypedStorage<RepoStateSchema>(state.storage);
	const database = getDb(state.storage);
	const log = createLogger(environment.LOG_LEVEL, { service: 'ReceivePack', repoId: prefix });

	try {
		const body = new Uint8Array(await request.arrayBuffer());
		const section = parsePktSection(body);
		if (!section) {
			log.warn('parse:malformed', {});
			return new Response('malformed receive-pack\n', { status: 400 });
		}
		const { lines, offset } = section;

		// Parse commands: "<old> <new> <ref>" (first line may include NUL + capabilities)
		const cmds: { oldOid: string; newOid: string; ref: string }[] = [];
		for (let [index, line] of lines.entries()) {
			if (index === 0) {
				const nul = line.indexOf('\0');
				if (nul !== -1) line = line.slice(0, nul);
			}
			const parts = line.trim().split(/\s+/);
			if (parts.length >= 3) {
				cmds.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
			}
		}

		// Validate ref names and reject HEAD updates
		function isValidReferenceName(name: string): boolean {
			// Disallow direct HEAD and empty
			if (!name || name === 'HEAD') return false;
			// Must start with refs/
			if (!name.startsWith('refs/')) return false;
			// Disallow forbidden characters and sequences per Git rules
			// No control chars, no space, no tilde, caret, colon, question, asterisk, open bracket
			if (/[\u0000-\u0020~^:?*\[]/.test(name)) return false;
			// No consecutive slashes, no leading or trailing slash
			if (name.includes('//') || name.startsWith('/') || name.endsWith('/')) return false;
			// No components of "." or ".."
			if (name.split('/').some((c) => c === '.' || c === '..')) return false;
			// Cannot end with a dot or .lock
			if (name.endsWith('.') || name.endsWith('.lock')) return false;
			// No "@{" sequence
			if (name.includes('@{')) return false;
			// No backslash
			if (name.includes('\\')) return false;
			return true;
		}
		const invalids = cmds.filter((c) => !isValidReferenceName(c.ref));
		if (invalids.length > 0) {
			log.warn('receive:invalid-ref', { count: invalids.length, sample: invalids[0]?.ref });
			const chunks: Uint8Array[] = [];
			chunks.push(pktLine('unpack error invalid-ref\n'));
			for (const c of cmds) {
				const ok = !invalids.some((x) => x.ref === c.ref);
				chunks.push(pktLine(`ng ${c.ref} ${ok ? 'ok' : 'invalid'}\n`));
			}
			chunks.push(flushPkt());
			return new Response(asBodyInit(concatChunks(chunks)), {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-receive-pack-result',
					'Cache-Control': 'no-cache',
				},
			});
		}

		const pack = body.subarray(offset);
		log.debug('receive:parsed', { commands: cmds.length, packBytes: pack.byteLength });

		// Determine if this push contains any creates/updates (non-zero new OIDs)
		const hasNonDelete = cmds.some((c) => !/^0{40}$/i.test(c.newOid));

		// Handle pack storage/index only if there are non-delete updates
		let unpackOk = true;
		let unpackError = '';
		let packKey: string | undefined = undefined;
		let indexedOids: string[] | undefined = undefined;
		if (hasNonDelete) {
			// Store pack in R2 under per-DO prefix
			packKey = r2PackKey(prefix, `pack-${Date.now()}.pack`);
			try {
				await environment.REPO_BUCKET.put(packKey, pack);
				log.info('pack:stored', { packKey, bytes: pack.byteLength });
			} catch (error) {
				unpackOk = false;
				unpackError = `store-pack-failed`;
				log.error('pack:store-failed', { error: String(error) });
			}

			// Quick index-only (no unpacking yet)
			// Pass DO state and prefix to handle thin packs properly
			try {
				const oids = await indexPackOnly(new Uint8Array(pack), environment, packKey, state, prefix);
				indexedOids = oids;
				log.info('index:ok', { packKey, oids: oids.length });
			} catch (error: any) {
				unpackOk = false;
				unpackError = error?.message || String(error);
				log.error('index:error', { error: unpackError });
				// Best-effort cleanup of the stored pack to avoid orphan cost
				try {
					if (packKey) await environment.REPO_BUCKET.delete(packKey);
				} catch {}
			}
		} else {
			// Delete-only push: no pack is expected/required
			unpackOk = true;
		}

		// Load current refs state
		const references = (await store.get('refs')) || [];
		const referenceMap = new Map(references.map((r) => [r.name, r.oid] as const));

		// Validate commands against current refs
		const statuses: { ref: string; ok: boolean; msg?: string }[] = [];
		if (unpackOk) {
			for (const c of cmds) {
				const current = referenceMap.get(c.ref);
				const isZeroOld = /^0{40}$/i.test(c.oldOid);
				const isZeroNew = /^0{40}$/i.test(c.newOid);
				// Delete ref
				if (isZeroNew) {
					if (!current) {
						statuses.push({ ref: c.ref, ok: false, msg: `no such ref` });
						continue;
					}
					if (current.toLowerCase() !== c.oldOid.toLowerCase()) {
						statuses.push({ ref: c.ref, ok: false, msg: `stale old-oid` });
						continue;
					}
					statuses.push({ ref: c.ref, ok: true });
					continue;
				}
				// Create new ref
				if (!current) {
					if (!isZeroOld) {
						statuses.push({ ref: c.ref, ok: false, msg: `expected zero old-oid` });
						continue;
					}
					statuses.push({ ref: c.ref, ok: true });
					continue;
				}
				// Update existing ref: require old matches current; allow non-fast-forward (force)
				if (current.toLowerCase() !== c.oldOid.toLowerCase()) {
					statuses.push({ ref: c.ref, ok: false, msg: `stale old-oid` });
					continue;
				}
				statuses.push({ ref: c.ref, ok: true });
			}
		} else {
			for (const c of cmds) statuses.push({ ref: c.ref, ok: false, msg: `unpack-failed` });
		}

		// Connectivity check: ensure each new ref's target exists (commit->tree, tag, tree/blob)
		if (unpackOk && packKey) {
			await runConnectivityCheck({
				pack: new Uint8Array(pack),
				packKey,
				cmds,
				statuses,
				state,
				store,
				env: environment,
				prefix,
				log,
			});
		}

		// Apply updates atomically if all commands (including connectivity) are valid
		const allOk = statuses.length === cmds.length && statuses.every((s) => s.ok);
		log.debug('commands:validated', {
			total: cmds.length,
			ok: statuses.filter((s) => s.ok).length,
		});
		let newReferences: { name: string; oid: string }[] | undefined = undefined;
		if (allOk) {
			for (const c of cmds) {
				if (/^0{40}$/i.test(c.newOid)) referenceMap.delete(c.ref);
				else referenceMap.set(c.ref, c.newOid);
			}
			newReferences = Array.from(referenceMap, ([name, oid]) => ({ name, oid }));
			try {
				await store.put('refs', newReferences);
				log.info('refs:updated', { count: newReferences.length });
			} catch (error) {
				log.error('refs:update-failed', { error: String(error) });
			}
			// Refresh HEAD resolution based on updated refs
			try {
				const currentHead = (await store.get('head')) || null;
				const target = currentHead?.target || 'refs/heads/main';
				const match = newReferences.find((r) => r.name === target);
				const resolved: Head = match ? { target, oid: match.oid } : { target, unborn: true };
				await store.put('head', resolved);
				log.debug('head:resolved', { target, oid: resolved.oid, unborn: resolved.unborn === true });
			} catch (error) {
				log.warn('head:resolve-failed', { error: String(error) });
			}

			// KV metadata cache removed: no push markers or unpack status in KV

			// Persist pack metadata and schedule unpack only after successful ref updates
			try {
				if (packKey && indexedOids && indexedOids.length > 0) {
					await store.put('lastPackKey', packKey);
					// Clamp stored OIDs to avoid oversized DO state; consistent with reader-side cap
					const capped = indexedOids.slice(0, 10_000);
					await store.put('lastPackOids', capped);
					await insertPackOids(database, packKey, indexedOids);

					const list = ((await store.get('packList')) || []).filter((k: string) => k !== packKey);
					list.unshift(packKey);
					const packListMaxRaw = Number(environment.REPO_PACKLIST_MAX ?? 20);
					const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : min);
					const packListMax = clamp(packListMaxRaw, 1, 100);
					if (list.length > packListMax) list.length = packListMax;
					await store.put('packList', list);

					// If there is already unpack work in progress, stage this pack as next; otherwise schedule now
					const currentWork = await store.get('unpackWork');
					if (currentWork) {
						const existingNext = await store.get('unpackNext');
						if (existingNext) {
							// Defensive: this should be pre-blocked by RepoDO.handleReceive(); keep first next
							log.warn('queue:next-already-set', { existingNext, dropped: packKey });
						} else {
							await store.put('unpackNext', packKey);
							log.info('queue:next-set', { packKey, oids: indexedOids.length });
						}
					} else {
						await store.put('unpackWork', {
							packKey,
							totalCount: indexedOids.length,
							processedCount: 0,
							startedAt: Date.now(),
						});
						await scheduleAlarmIfSooner(state, environment, Date.now() + 100);
						log.debug('unpack:scheduled', { packKey });
					}
				}
			} catch (error) {
				log.warn('post-apply:metadata-or-unpack-schedule-failed', { error: String(error) });
			}
		}

		// If rejected but a pack was uploaded and indexed, clean up R2 objects
		if (!allOk && packKey) {
			try {
				await environment.REPO_BUCKET.delete(packKey);
			} catch {}
			try {
				await environment.REPO_BUCKET.delete(packIndexKey(packKey));
			} catch {}
		}

		// Assemble report-status response
		const chunks: Uint8Array[] = [];
		chunks.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack error ${unpackError || 'failed'}\n`));
		for (const [index, c] of cmds.entries()) {
			const st = statuses[index];
			if (st?.ok) chunks.push(pktLine(`ok ${c.ref}\n`));
			else chunks.push(pktLine(`ng ${c.ref} ${st?.msg || 'rejected'}\n`));
		}
		chunks.push(flushPkt());
		// Signal to the outer router if repository changed and whether it's now empty
		const changed = allOk && cmds.length > 0;
		const empty = !!newReferences && newReferences.length === 0;

		const resHeaders: Record<string, string> = {
			'Content-Type': 'application/x-git-receive-pack-result',
			'Cache-Control': 'no-cache',
			'X-Repo-Changed': changed ? '1' : '0',
			'X-Repo-Empty': empty ? '1' : '0',
		};

		const resp = new Response(asBodyInit(concatChunks(chunks)), {
			status: 200,
			headers: resHeaders,
		});
		log.info('receive:done', { changed, empty, allOk });
		return resp;
	} finally {
		// No-op: rely on Durable Object's single-concurrency to serialize pushes.
	}
}
