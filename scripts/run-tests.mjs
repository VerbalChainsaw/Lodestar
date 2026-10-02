import { globSync } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { pathToFileURL } from "node:url";

export async function runOwnedTests({ files, deadlineMs = 120000 } = {}) {
  files ??= globSync("test/*.test.mjs", { exclude: (name) => name === "node_modules" }).sort();
  files = files.map((file) => path.resolve(file));
  if (files.length === 0) throw new Error("No owned test/*.test.mjs files selected.");
  const selected = new Set(files), active = new Map();
  const controller = new AbortController();
  let failed = false;
  const stream = run({ files, concurrency: true, signal: controller.signal });
  stream.on("test:fail", () => { failed = true; });
  stream.on("data", ({ type, data }) => {
    if (data.nesting !== 0 || !selected.has(data.name)) return;
    const file = data.name;
    if (type === "test:dequeue") {
      const started = Date.now();
      const timer = setTimeout(() => {
        const overdue = path.relative(process.cwd(), file);
        console.error(`[test-file] ${new Date().toISOString()} DEADLINE ${overdue} after ${deadlineMs}ms; active=${JSON.stringify([...active.keys()].map((name) => path.relative(process.cwd(), name)))}`);
        controller.abort(new Error(`Test file deadline exceeded: ${overdue} (${deadlineMs}ms).`));
      }, deadlineMs);
      active.set(file, { timer, started });
      console.log(`[test-file] ${new Date().toISOString()} START ${path.relative(process.cwd(), file)}`);
    } else if (type === "test:complete") {
      const current = active.get(file);
      if (current) clearTimeout(current.timer);
      active.delete(file);
      console.log(`[test-file] ${new Date().toISOString()} COMPLETE ${path.relative(process.cwd(), file)} passed=${data.details.passed} elapsedMs=${current ? Date.now() - current.started : "unknown"}`);
    }
  });
  const reported = stream.compose(new spec());
  reported.pipe(process.stdout, { end: false });
  try { await finished(reported); }
  finally { for (const { timer } of active.values()) clearTimeout(timer); }
  if (controller.signal.aborted) {
    // Aborted file workers may leave inherited pipes open in a fixture child.
    // Flush the report, then end this runner; do not sweep unrelated processes.
    await Promise.all([process.stdout, process.stderr].map((output) =>
      new Promise((resolve) => output.write("", resolve))));
    process.exit(1);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runOwnedTests(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
