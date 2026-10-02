import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
let root = import.meta.dirname;
while (!existsSync(join(root, 'lodestar.mjs')) && dirname(root) !== root) root = dirname(root);
const { loadInterfaceConfig } = await import(pathToFileURL(join(root, 'src/interface-config.mjs')).href);
console.log(JSON.stringify(await loadInterfaceConfig(process.argv[2], { requireLoader: false })));
