# Agent Note: JSONL cross-process writer lock and durable-tail verification

Status: implemented

English | [中文](2026-08-15-jsonl-cross-process-writer-lock.zh.md)

## Problem

The persistence coordinator serializes per-session operations with a per-id promise chain, which arbitrates writers inside one backend instance only. Two dsh processes mounting the same JSONL root each hold an independent chain and an independent in-memory cursor, so nothing arbitrates their physical writes. A real incident produced exactly this interleaving on one session: process A loaded the log, found an open tool call, and committed synthetic interrupted closers at seq 95388–95391 while process B — still the live owner of the tool execution — appended the real result and continued from the same seq 95388 through 96324. The durable log forked: both branches were individually well-formed, but the concatenated file satisfied no contiguity order and every later load rejected with `seq gap in committed region`. Repair required manually dropping one branch's zstd frames.

The pre-change contract said "one live writer per session; another backend instance or process must not write the same session" — documentation, not enforcement. Violating it cost a silent, permanent fork; the log's next reader paid, not the violating writer.

## Decision

Physical JSONL mutations now take a cross-process OS advisory lock and verify the durable tail before committing.

**Lock primitive** (`writer-lock.ts`): `acquireSessionLogWriterLock(logPath)` exclusively locks a `<logPath>.lock` sibling — `flock(2)` through koffi on POSIX, `LockFileEx` on Windows. Acquisition is non-blocking and fails immediately with `SessionLogWriterLockHeldError` while another process holds the lock. Both platforms release through the kernel when the owning process exits, so a crashed writer never leaves a lock needing manual recovery. The Windows handle comes from `CreateFileW` directly: Node file descriptors belong to the UCRT fd table, and an `msvcrt.dll` `_get_osfhandle` returns `-1` for them, so the fd-to-HANDLE conversion path is unusable. Long paths need the `\\?\` namespace prefix the raw Win32 API will not add itself.

**Coverage**: `appendBatch` (materialization and append) and `commitRepair` (truncate and closers) each hold the lock across their complete read-validate-commit cycle. Locking only the write call would let two writers pass validation concurrently and both commit — the lock is what makes validate-then-write atomic against other processes.

**Durable-tail verification**: before appending, the backend resolves the seq the durable log continues from and requires `events[0].seq === nextSeq`; a mismatch throws `JsonlTailDivergedError` ("advanced under this writer … reload before writing") without touching the file. A revision-keyed tail cache (`stat` identity → next-seq) avoids a full-log re-read per append: when the observed revision matches the last committed write's, the cached next-seq is authoritative; any other revision forces a decode. A torn-tail marker now carries the revision it was read at, and a repair whose log revision no longer matches aborts instead of truncating events a concurrent writer committed.

The physical on-disk format is unchanged: no `SESSION_FORMAT_VERSION` bump, no new log record, no rewrite of existing artifacts. The `.lock` sibling is a new directory entry discovery never reads.

## Alternatives considered

**An `wx`-created lockfile protocol (as `dsh-atomic-write.withFileLock`).** Rejected: a process that dies between creation and removal leaves a lockfile whose age cannot prove its owner stopped, so orphan recovery becomes an operator action. Kernel-held advisory locks release on process death by construction.

**Trust the coordinator's per-id chain.** The chain is process-local state; a second process's chain is invisible by construction. The incident's writers were both internally consistent — each serialized perfectly inside its own process.

**Tail verification without a lock (optimistic check-then-write).** Rejected: two processes can pass the same tail check concurrently and both commit. The check is only sound inside the lock's critical section.

**Move the lock into `PersistenceCoordinator`.** Rejected: the lock guards physical file mutation, which is backend-owned. SQLite already gets cross-writer exclusion from its transaction layer at the storage seam; a JSONL file needs its own primitive at the same layer, not a new coordinator-wide concept every backend must carry.

## Consequences

Violating the one-live-writer topology now fails loudly at the violating writer with an untouched log, instead of silently corrupting the durable artifact. A second backend instance that reloads between batches continues the same log legitimately — the lock relays per batch; it does not reserve the session for a process lifetime. Lock files accumulate beside logs until external cleanup (the same lifecycle as the logs themselves, which the seam never deletes). Every append pays one extra `stat` (cache hit) or one full decode (cache miss or external writer); the cached steady state restores the pre-change cost profile.

This decision partially supersedes [Bind JSONL session identity before mutation](../bug-fix/2026-07-20-jsonl-storage-identity.md): its identity-validation decision stands, but its "coordinate multiple live writers" rejection — made to avoid inventing a deployment topology for an identity fix — no longer describes physical writes, which now carry their own enforcement. Resume-time UI exclusion ("this session is open in another process") remains deferred; the writer lock detects contention at commit time, not at session open.

## Testing

`writer-lock.spec.ts` proves same-process re-entry rejection, release/re-acquire, lock-file placement, real-child-process contention, and SIGKILL crash release. `writer-race.spec.ts` pins the incident shapes through the backend seam: a stale-cursor append against an advanced log fails with the tail-divergence error and leaves the file loadable; synthetic closers whose real outcome landed first refuse; a torn marker whose revision moved refuses without truncating; an externally held lock fails the append with bytes unchanged; an externally advanced log invalidates the cache and accepts the correct continuation; and two mounted backend instances relay the lock and continue one log. The full pre-existing JSONL suite (243 tests) passes unchanged.
