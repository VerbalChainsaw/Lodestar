import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// Test children have one owner and one finite close deadline. Register fallback
// cleanup before launch; callers with directory after-hooks also stop in their
// lexical finally block so Node's FIFO hooks cannot remove a live child's files.
export function spawnOwnedProcess(t, command, argv, options,
  { timeoutMs = 15000, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
    throw new RangeError("Owned test process deadline must be a positive bounded integer.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 2147483647)
    throw new RangeError("Owned test process output budget must be a positive bounded integer.");
  let child, timer, closed = false, finished = false, error, timedOut = false, stopped = false, stopping;
  let outputBytes = 0, admittedBytes = 0;
  let stdout = "", stderr = "", resolveCompleted, resolveClosed;
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
  const details = () => ({ command, argv, pid: child?.pid, status: child?.exitCode ?? null,
    signal: child?.signalCode ?? null, stdout, stderr,
    ...(error ? { error: { message: error.message, code: error.code } } : {}),
    timedOut, stopped, outputBytes, admittedBytes, maxOutputBytes });
  const diagnostic = () => JSON.stringify({ pid: child?.pid, status: child?.exitCode ?? null,
    signal: child?.signalCode ?? null, outputBytes, admittedBytes, maxOutputBytes,
    stdoutSample: stdout.slice(0, 512), stderrSample: stderr.slice(0, 512) });
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    stdout += decoders.stdout.end(); stderr += decoders.stderr.end();
    resolveCompleted(details());
  };
  async function stop() {
    clearTimeout(timer);
    if (closed || !child) return completed;
    if (!stopping) {
      stopped = true;
      if (!error) {
        error = new Error(`Owned test child stopped before complete response close: ${diagnostic()}`);
        error.code = "TEST_CHILD_STOPPED";
      }
      stopping = (async () => {
        if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        // These are this invocation's handles, including pipes a fixture
        // descendant might inherit. Never search for or kill another process.
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        let closeTimer;
        try {
          await Promise.race([closedPromise, new Promise((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error(`Owned test child did not close: ${diagnostic()}`)), 5000);
          })]);
        } finally { clearTimeout(closeTimer); }
      })();
    }
    await stopping;
    return completed;
  }
  t.after(stop);
  try { child = spawn(command, argv, { windowsHide: true, ...options }); }
  catch (failure) { error = failure; closed = true; resolveClosed(); finish(); return { child, completed, stop }; }
  const collect = (channel, chunk) => {
    if (finished || stopped) return;
    outputBytes += chunk.length;
    const admitted = chunk.subarray(0, Math.max(0, maxOutputBytes - admittedBytes));
    admittedBytes += admitted.length;
    const decoded = decoders[channel].write(admitted);
    if (channel === "stdout") stdout += decoded;
    else stderr += decoded;
    if (outputBytes > maxOutputBytes) {
      error = new Error(`Owned test child exceeded its combined output budget: ${diagnostic()}`);
      error.code = "TEST_CHILD_OUTPUT_LIMIT";
      stop().catch((failure) => { error = failure; finish(); });
    }
  };
  child.stdout?.on("data", (chunk) => collect("stdout", chunk));
  child.stderr?.on("data", (chunk) => collect("stderr", chunk));
  child.stdin?.on("error", (failure) => { error ??= failure; });
  child.once("error", (failure) => { error ??= failure; });
  child.once("close", () => { closed = true; resolveClosed(); finish(); });
  timer = setTimeout(() => {
    timedOut = true;
    error = new Error(`Owned test process deadline exceeded after ${timeoutMs}ms: ${diagnostic()}`);
    error.code = "TEST_CHILD_TIMEOUT";
    stop().catch((failure) => { error = failure; finish(); });
  }, timeoutMs);
  return { child, completed, stop };
}

export async function writeOwnedFrame(owned, frame) {
  const input = owned.child.stdin;
  if (input.destroyed) throw new Error("Owned test stdin closed before frame delivery.");
  if (input.write(frame)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      input.removeListener("drain", drained);
      input.removeListener("error", failed);
      input.removeListener("close", closed);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    const closed = () => failed(new Error("Owned test stdin closed while awaiting drain."));
    input.once("drain", drained);
    input.once("error", failed);
    input.once("close", closed);
    if (input.destroyed) closed();
  });
}
