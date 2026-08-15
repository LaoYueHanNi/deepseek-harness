# Agent Note: JSONL 跨进程 writer lock 与持久尾部校验

Status: implemented

[English](2026-08-15-jsonl-cross-process-writer-lock.md) | 中文

## 问题

持久化协调器用按 id 的 promise chain 串行化单会话操作，但该仲裁只在单个后端实例内部生效。两个挂载同一 JSONL 根目录的 dsh 进程各自持有独立的 chain 和独立的内存游标，没有任何机制仲裁它们的物理写入。一次真实事故正是这个交错：进程 A 加载日志后发现未闭合的工具调用，从 seq 95388–95391 提交了合成 interrupted closer；而进程 B——仍是该工具执行的存活所有者——从同一个 seq 95388 追加了真实结果，并一直写到 96324。持久日志因此分叉：两个分支各自完好，但拼接后的文件不满足任何连续顺序，之后每次加载都以 `seq gap in committed region` 拒绝。修复需要手工剔除其中一个分支的 zstd frame。

改动前的约定是"每会话一个存活 writer；在后端所有者完成 dispose 前，其他后端实例或进程不得写入同一会话"——这只是文档，不是强制。违反它的代价是静默且永久的分叉；买单的是日志的下一个读取者，而不是违规的写入者。

## 决策

物理 JSONL 变更现在获取跨进程 OS advisory lock，并在提交前校验持久尾部。

**锁原语**（`writer-lock.ts`）：`acquireSessionLogWriterLock(logPath)` 独占锁定 `<logPath>.lock` 同级文件——POSIX 经 koffi 调用 `flock(2)`，Windows 调用 `LockFileEx`。获取是非阻塞的：其他进程持锁时立即以 `SessionLogWriterLockHeldError` 失败。两个平台都由内核在持有进程退出时释放锁，因此崩溃的 writer 绝不会留下需要人工恢复的锁。Windows 句柄直接来自 `CreateFileW`：Node 文件描述符属于 UCRT fd 表，`msvcrt.dll` 的 `_get_osfhandle` 对它们返回 `-1`，因此 fd-to-HANDLE 转换路径不可用。长路径需要 `\\?\` 命名空间前缀，裸 Win32 API 不会自行添加。

**覆盖范围**：`appendBatch`（实体化与追加）和 `commitRepair`（截断与 closer）各自在完整的读取-校验-提交周期内持锁。只锁写调用会让两个 writer 并发通过校验并都提交——使"校验后写入"对其他进程原子的是锁，不是校验本身。

**持久尾部校验**：追加前，后端解析持久日志继续处的 seq，并要求 `events[0].seq === nextSeq`；不匹配时抛出 `JsonlTailDivergedError`（"日志在本 writer 之下已被推进……请重载后再写入"），文件保持不变。按 revision 键控的尾部缓存（`stat` 标识 → next-seq）避免每次追加都完整重读日志：观察到的 revision 与上次已提交写入一致时，缓存的 next-seq 即为权威；任何其他 revision 强制重新解码。torn-tail marker 现在携带读取它时的 revision；日志 revision 不再匹配的修复会中止，而不是截断并发 writer 已提交的事件。

物理磁盘格式不变：不提升 `SESSION_FORMAT_VERSION`，不新增日志记录，不重写现有产物。`.lock` 同级文件是发现逻辑从不读取的新目录项。

## 备选方案

**`wx` 创建的 lockfile 协议（如 `dsh-atomic-write.withFileLock`）。** 不采纳：进程在创建与删除之间死亡会留下一个 lockfile，其存在时长无法证明所有者已停止，孤儿恢复变成运维操作。内核持有的 advisory lock 在进程死亡时按构造释放。

**信任协调器的按 id chain。** 该 chain 是进程内状态；第二个进程的 chain 按构造不可见。事故中的两个 writer 内部各自完全一致——每个都在自己的进程里被完美串行化。

**无锁的尾部校验（乐观检查后写入）。** 不采纳：两个进程可以并发通过同一个尾部检查并都提交。校验只有在锁的关键区内才是可靠的。

**把锁移入 `PersistenceCoordinator`。** 不采纳：锁保护的是物理文件变更，归后端所有。SQLite 已在存储层由事务获得跨 writer 排他；JSONL 文件需要在同一层拥有自己的原语，而不是引入一个每个后端都必须携带的协调器级新概念。

## 后果

违反单存活 writer 拓扑现在会在违规 writer 处大声失败、日志原封未动，而不是静默损坏持久产物。在批次之间重载的第二个后端实例可以合法继续同一日志——锁按批次接力，不按进程生命周期保留会话。锁文件与日志一同累积，直到外部清理（与日志本身相同的生命周期，seam 从不删除它们）。每次追加多付出一次 `stat`（缓存命中）或一次完整解码（缓存未命中或外部 writer）；缓存的稳定态恢复改动前的成本轮廓。

本决策部分取代 [Bind JSONL session identity before mutation](../bug-fix/2026-07-20-jsonl-storage-identity.md)：其身份校验决策继续成立，但"协调多个存活 writer"的拒绝——当时是为身份修复避免发明部署拓扑——不再描述物理写入，后者现在自带强制。恢复时 UI 层的独占提示（"该会话已在其他进程打开"）仍然推迟；writer lock 在提交时检测争用，而不是在会话打开时。

## 测试

`writer-lock.spec.ts` 证明同进程重入拒绝、释放/重获、锁文件位置、真实子进程争用与 SIGKILL 崩溃释放。`writer-race.spec.ts` 通过后端 seam 固定事故形态：陈旧游标追加对抗已推进日志时以尾部分歧错误失败且文件仍可加载；真实结果先落地时合成 closer 拒绝；revision 已移动的 torn marker 不截断即拒绝；外部持锁时追加失败且字节不变；外部推进的日志使缓存失效并接受正确的延续；两个挂载的后端实例接力锁并继续同一日志。既有的完整 JSONL 套件（243 项测试）全部保持通过。
