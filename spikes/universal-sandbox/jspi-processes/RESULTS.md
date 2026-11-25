# Spike: wasm "processes" suspended with JSPI, no SharedArrayBuffer

Run: `npm run spike` (about 75 s; `npm run spike:quick` about 25 s). Prints one JSON document
and writes `results.json`. Needs `playwright` resolvable (it is, globally, in this repo's
environment). Guests are prebuilt in `web/wasm/`; rebuild with `npm run build:guest`
(needs `rustup target add wasm32-wasip1 wasm32-unknown-unknown`).

**Machine caveat.** Every number below comes from one run on 2026-11-25 in headless
Chromium 158.0.8127.36 (Playwright headless shell) inside a cloud container: 4 vCPU
Xeon @ 2.30 GHz, 15.7 GB RAM, Linux. It is not a phone and not a desktop browser. Nothing
here was tested in Safari/iOS or Firefox, and nothing below says anything about them.
`performance.now()` in the non-isolated worker had 0.1 ms granularity, so all per-call
figures are totals over 20 k to 3 M iterations divided by the count. Each measurement was
run 7 times; the median is reported, with min-max where the spread matters.

## What was built

| File | What |
|---|---|
| `web/kernel.js` | Kernel: process table, fd tables, pipes (ring buffer, default 4 KiB), in-memory files, null file, WASI preview1 subset (`args_*`, `environ_*`, `fd_read`, `fd_write`, `fd_close`, `fd_fdstat_get`, `clock_time_get`, `poll_oneoff` (clock only), `proc_exit`, `random_get`; every other import is stubbed to `ENOSYS`), custom `spike.spawn` / `spike.waitpid`, kill, placement (a) and (b) |
| `web/kernel-worker.js` | The single dedicated worker hosting the kernel, plus all tests/benchmarks |
| `web/proc-worker.js` | Placement (b): one wasm instance per worker, every syscall is a `MessagePort` round trip awaited through JSPI |
| `web/page.js`, `web/index.html` | Page: owns the kernel worker, ping latency probe, watchdog |
| `server.js` | Static server, sends no COOP/COEP headers |
| `run.js` | Playwright driver |
| `guest/` | Rust, `wasm32-wasip1`, std, unmodified WASI: `producer`, `upper`, `count`, `spin`, `pingpong`, `hog`, `crash`, `parent` (43-69 KB each) |
| `guest-reentrant/` | 248-byte freestanding module for the JS-frames test |

Placement (a) as built: `promising(instance.exports._start)` per process; `poll_oneoff`
and `waitpid` are `WebAssembly.Suspending` imports; `fd_read`/`fd_write` go through a
hand-assembled, memory-less wasm "fast-path shim" (see surprise 1) that calls a plain JS
import and only calls a `Suspending` import when the kernel would block.

## Results

### (i) Isolation

Response headers: no `Cross-Origin-Opener-Policy`, no `Cross-Origin-Embedder-Policy`.
In the page and in the kernel worker: `crossOriginIsolated === false`,
`typeof SharedArrayBuffer === "undefined"`. `WebAssembly.Suspending` and
`WebAssembly.promising` are functions. No flags were needed for JSPI.

### Correctness and interleaving (placement a)

`producer 200000 | upper | count`, three coroutine processes in one worker, 4 KiB pipes,
11.4 MB per stage, producer sleeping 2 ms every 20 000 lines: output
`lines=200000 bytes=11400000 fnv=c5d488f5` equals the value computed independently in JS;
exit codes 0,0,0. The kernel blocked a process 8 370 times (2 790 per process) and switched
process 8 370 times; 413 592 syscalls. When `producer` exited, `count` had already consumed
all but 0-2.5 KB of the data (so the stages really ran interleaved, never more than the
pipe capacity apart). A 2-stage run with the output captured in a memory file matched the
expected text byte for byte. `parent` (spawn child, block in `waitpid`) also works.

### (ii) Non-blocking syscall cost, placement (a), ns per call

| Call | median | min-max |
|---|---|---|
| loop body with no call (baseline) | 2.5 | 2.5-2.6 |
| plain JS import, trivial body (`nop`) | 17.9 | 17.5-22.2 |
| `fd_write` 1 byte to a null fd, via the fast-path shim (iovec decode, fd lookup) | 29.3 | 28.8-35.3 |
| `clock_time_get` (plain import; includes `performance.now()` and an i64 argument arriving as BigInt) | 161 | 149-177 |
| same `nop` wrapped in `WebAssembly.Suspending`, returning a plain number | 97.2 | 94.7-104 |
| same, returning an already resolved Promise | 102 | 95.4-105 |
| `fd_write` 1 byte to null with `fd_write` itself a `Suspending` import (no shim) | 110 | 100-114 |

### (iii) Suspend/resume context switch, placement (a)

Ping-pong, two processes, two pipes, one byte each way, 200 000 round trips = 400 001
kernel blocks and 400 001 process switches: **405 ns per process switch** (390-433),
which includes one 1-byte `fd_read` and one `fd_write` per switch, the kernel's Promise
and async-function bookkeeping, and the microtask hop. Without the shim: 454 ns (437-527).
The bare JSPI suspend+resume with nothing else to run is the ~80 ns difference between
rows 2 and 5 of the table above.

### (iv) Syscall cost, placement (b), microseconds per call

| Call | median | min-max |
|---|---|---|
| plain JS `MessageChannel` round trip to an echo worker, no wasm (baseline) | 55.6 | 34.1-61.9 |
| `nop` | 51.9 | 27.8-68.6 |
| `clock_time_get` | 37.6 | 15.4-55.3 |
| `fd_write` 1 byte to null | 45.2 | 36.0-58.6 |

Noisy, and indistinguishable from the plain-JS baseline: the cost is the two cross-thread
message deliveries, JSPI adds nothing visible. Roughly **1 500x** the cost of the same
syscall in placement (a). This container may well be worse than real hardware at
cross-thread wake-ups; I have no second machine to compare.

### (v) Spawn cost from an already compiled `WebAssembly.Module`

| | median | min-max |
|---|---|---|
| (a) build imports + `new WebAssembly.Instance` (+ shim instance) | 138 us | 116-451 us |
| (a) spawn + `_start` (Rust runtime init, one syscall, `println`) + exit | 154 us | 103-245 us |
| (b) `new Worker` + script load + post Module + instantiate | 11.6 ms | 8.8-12.7 ms |
| (b) same, through exit | 12.3 ms | 9.4-13.2 ms |
| (b) instantiate in an already running (pooled) worker | 0.2 ms | 0.1-0.3 ms |
| (b) pooled worker, through exit | 0.6 ms | 0.2-0.8 ms |

Compiling each ~60 KB module took 0.4-0.5 ms (V8 compiles lazily, so this is not the
whole cost).

### (vi) Pipeline throughput, 200 000 lines, 11.4 MB per stage, MB/s

| Configuration | median | min-max | syscalls | kernel blocks |
|---|---|---|---|---|
| (a) 4 KiB pipes, Rust default line-buffered stdout (one `fd_write` per line), shim | 158 | 129-168 | 413 567 | 8 346 |
| (a) same, no shim (`fd_read`/`fd_write` are `Suspending`) | 73.4 | 70.5-74.9 | 604 217 | 4 214 |
| (a) 4 KiB pipes, guests use 64 KiB `BufWriter` | 292 | 257-308 | 18 431 | 8 920 |
| (a) 64 KiB pipes, line-buffered | 156 | 106-176 | 402 053 | 519 |
| (a) 4 KiB pipes, kernel yields to the event loop every 8 ms | 145 | 133-154 | 413 567 | 8 346 |
| (b) three worker processes, 20 000 lines | 0.6 | 0.4-0.6 | 58 991 | - |

### Kill

Tested: killing a process suspended in `fd_read`, one whose wake-up promise was already
resolved but which had not resumed yet, one suspended in a sleep, and the middle process
of a running pipeline. In all four the fds were closed, the process left the table, and
the guest produced no further output. In the pipeline case `count` saw EOF and exited 0
with a partial count; `producer` got `EPIPE`, which Rust's `println!` turns into a panic,
so it ended as a trap (exit 134) with the panic text on stderr.

**"Drop its promise" does not reclaim memory.** With the first implementation (remove the
waiter, drop every kernel reference, never settle the promise), killed processes were
never collected: browser Pss grew by ~320 MB per round of 20 x 16 MiB processes and never
came back, and after 6 rounds no process could be spawned at all
(`RangeError: WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new
instance`). A kernel-independent repro (`stackLeakRepro`, 50 instances of the 248-byte
module, separate browser with `--js-flags=--expose-gc`) shows it is engine behaviour:

| Suspended on a promise that is then... | instances finalized after `gc()` |
|---|---|
| dropped (never settled, all references released) | 0 / 50 |
| rejected | 50 / 50 |
| resolved | 50 / 50 |

So `kill()` now **rejects** the pending promise with a `ProcKilled` error. The exception
unwinds the wasm stack to the `promising()` wrapper. With that, in the `--expose-gc`
browser: 20 hogs live = 431 MB Pss; after kill + `gc()` = 110 MB (baseline 104 MB) and
all 20 instances and 20 memories finalized. Killing 20 more with the old drop mode left
Pss at 431 MB, finalized nothing, and permanently lowered the process limit by 20.

With default flags (no `gc()`), unwind-kill memory is reclaimed only when V8 decides to
collect: over 8 rounds Pss climbed 445, 763, 1083 MB, dropped to 440, then climbed again
to 1722 MB and was still 1722 MB after 3 s idle. Exhausting the instance limit did trigger
collection (125 processes could be spawned immediately afterwards).

### Traps (process suspended at least once before trapping)

| Guest does | Result |
|---|---|
| `unreachable` | `_start` promise rejects with `RuntimeError: unreachable`; kernel marks it trapped (134), closes fds |
| Rust `panic!` | message on the guest's stderr, then `RuntimeError: unreachable` |
| unbounded recursion | `RangeError: Maximum call stack size exceeded`, caught the same way |
| out-of-bounds store | **renderer crash in this environment** - see below |

A bystander process blocked on another pipe was unaffected and finished normally, and a
fresh pipeline ran correctly afterwards.

Out-of-bounds: with default flags the page crashes ("Target crashed", SIGSEGV in the
renderer). This is **not** caused by JSPI or by this code: a 40-byte module doing one
out-of-bounds `i32.load` on `about:blank`, on the main thread or in a worker, crashes the
same way in this container's headless shell. In a separate browser launched with
`--js-flags=--wasm-enforce-bounds-checks`, the out-of-bounds store produces
`RuntimeError: memory access out of bounds` in all three variants (no JSPI, promising
without suspension, promising after a suspension) and the kernel handles it like any trap.
So the out-of-bounds case could only be verified with that flag; it should be rechecked in
a normal desktop Chrome.

### CPU-bound guest

Placement (a): `spin burn` (infinite loop, no syscalls) freezes the kernel worker entirely.
The page's watchdog (ping every 100 ms, 1 000 ms timeout) detected it after 1 000 ms,
`worker.terminate()` returned immediately, a new worker booted in 11.8 ms, refetching and
compiling the 9 programs took 26.2 ms, and a pipeline then ran correctly. Everything in
the old kernel (pipes, files, all other processes, the in-flight command) was lost.

A milder version of the same problem: a pipeline that never truly blocks on I/O outside
the worker runs entirely on microtasks, so the worker handles no messages. During a
1 M-line pipeline (389 ms) the page's pings were answered up to **384 ms** late. With the
kernel hopping through a macrotask every 8 ms (`sliceMs`), max ping latency was **8.2 ms**
at a throughput cost within noise (145 vs 158 MB/s on the 200 k run).

Placement (b): the same burner in its own worker left the kernel responsive (max ping
latency 4 ms, kernel timer 0.3 ms late); the kernel terminated that worker and carried on.

### JS frames between wasm frames

| Stack shape | Observed |
|---|---|
| `promising(export)` -> wasm -> `Suspending` import (pending promise) | works |
| `promising(export)` -> wasm -> **sync JS import** -> raw wasm export -> `Suspending` import | `SuspendError: trying to suspend JS frames`, catchable inside the JS frame; instance usable afterwards |
| same, but the `Suspending` import returns a plain value | same `SuspendError` |
| `promising(export)` -> wasm -> **`Suspending` async JS** -> `await promising(export)()` -> `Suspending` import | works (two nested suspendable stacks) |
| plain JS -> raw export (no `promising`) -> `Suspending` import | `SuspendError: trying to suspend without WebAssembly.promising`, even if the import returns a plain value |
| two concurrent `promising` activations of the same instance | both complete |
| wasm -> wasm import (the shim) -> `Suspending` import | works; the whole pipeline runs this way |
| guest import (plain JS) starts another process with `promising(child._start)()` | works (`parent`): the child runs inside the parent's syscall until it first suspends |

The restriction is real and as documented: a suspension cannot cross a synchronous JS
frame.

## Surprises

1. **A `Suspending` import suspends on every call**, even when the JS function returns a
   plain number: a microtask queued inside the import ran before the next call
   (`import,microtask,import,microtask`). The design assumption "non-blocking syscalls are
   direct synchronous JS calls, blocking ones suspend" therefore cannot be met by one
   import that returns either a number or a Promise. Each such call costs ~100 ns instead
   of ~20-30 ns, and, more importantly, every `fd_write` becomes a scheduling point where
   any other ready process runs first. Without the shim the pipeline did 604 217 stack
   switches instead of 8 346 and ran at 73 instead of 158 MB/s. The shim (a ~150-byte
   wasm module with no memory, one instance per process, linked wasm-to-wasm) restores the
   intended behaviour for unmodified wasip1 binaries.
2. **Dropping a suspended stack leaks it** (above). Kill must unwind.
3. **About 125 live wasm memories per renderer, then instantiation fails.** Spawning
   `count` processes that each block on an empty pipe succeeded 124-125 times and then
   threw `RangeError: ... Cannot allocate Wasm memory for new instance` (same with
   enforced bounds checks). Each leaked or not-yet-collected memory counts against it. My
   first shim, built with Rust, carried its own 1 MiB memory and halved the limit, hence
   the hand-assembled one. I did not test whether workers get separate budgets.
4. Placement (b) costs 40-60 us per syscall here, all of it message passing.
5. Any wasm out-of-bounds access crashes the renderer in this container (environment
   issue, above).
6. An automated process in this checkout committed in-progress files of this directory
   ("Update in-progress sandbox prototypes") while I worked. I did not commit or push.

## Limitations of this spike

- One browser, one machine, one run of 7 repetitions. No Safari, no Firefox, no phone.
  Whether those engines have JSPI, the every-call suspension, the leak, or the ~125 limit
  is unknown from this work.
- The kernel is a test fixture: no real filesystem, no `path_open`, no signals, no
  `poll_oneoff` on fds, no non-blocking fds, no `fork`/`exec`. `waitpid` and `spawn` are
  custom imports, not WASI. Pipe writes are partial (POSIX atomicity for writes <=
  `PIPE_BUF` is not implemented).
- Kill by unwinding throws a JS exception through the guest. Rust `panic=abort` guests
  have nothing to catch it. A guest compiled with wasm exception handling could intercept
  it with `catch_all`; not tested.
- The stack-overflow test recursed on the wasm value stack only; the guest's own
  linear-memory shadow stack overflowing is a different failure and was not tested.
- Deep or large suspended stacks, many thousands of suspended processes (blocked by the
  ~125 limit), and memory growth while suspended were not measured.
- Placement (b) was measured unoptimised: one message per syscall, no batching, bytes
  copied in each direction. The kernel worker creates the process workers itself (nested
  workers), which worked here.
- Time slicing only happens when a process blocks; a guest that loops without blocking
  syscalls is not preempted (hence the watchdog).
- Spawn cost excludes fetch and compile, and V8's lazy/tiered compilation means early
  iterations of every benchmark ran in baseline-compiled code.
