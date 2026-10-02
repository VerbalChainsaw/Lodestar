// Fixture-only delayed transport. control.json is beside this file and names the exact packaged core.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const directory = import.meta.dirname;
const control = JSON.parse(await readFile(join(directory, 'control.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.includes(control.operation)) {
  try {
    await writeFile(join(directory, control.marker), JSON.stringify({ pid: process.pid,
      operation: control.operation, at: new Date().toISOString() }), { flag: 'wx' });
    await new Promise(resolve => setTimeout(resolve, control.delay_ms));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error; // Later exact replay runs without delay.
  }
}
const child = spawn(process.execPath, [control.packaged_cli, ...args], { stdio: 'inherit', windowsHide: true });
child.once('error', error => { process.stderr.write(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
