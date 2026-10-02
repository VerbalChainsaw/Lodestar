import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

const guides = ['README.md', 'Q&A.md', 'HEADACHES.md', 'docs/README.md',
  'docs/installation.md', 'docs/operator-recipes.md', 'docs/intent-evidence.md',
  'docs/limitations.md', 'docs/schema.md', 'docs/publishing.md', 'docs/releases/v3.0.0.md'];

function decode(text) {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

async function build(t, owner = root) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lodestar-guide-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [path.join(owner, 'scripts/build-site.mjs'), directory],
    { encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.stack);
  return directory;
}

async function sourceFixture(t) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'lodestar-guide-source-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const directory of ['scripts', 'site', 'docs', 'managed-assets', '.codex-plugin']) {
    await cp(path.join(root, directory), path.join(fixture, directory), { recursive: true });
  }
  await mkdir(path.join(fixture, 'desktop'));
  await cp(path.join(root, 'desktop/README.md'), path.join(fixture, 'desktop/README.md'));
  await cp(path.join(root, 'desktop/Lodestar.Loader/Assets'),
    path.join(fixture, 'desktop/Lodestar.Loader/Assets'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE', 'Q&A.md', 'HEADACHES.md']) {
    await cp(path.join(root, file), path.join(fixture, file));
  }
  return fixture;
}

async function refusedBuild(t, fixture, output) {
  const directory = output ?? await mkdtemp(path.join(tmpdir(), 'lodestar-guide-refusal-'));
  if (!output) t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [path.join(fixture, 'scripts/build-site.mjs'), directory],
    { encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(child.status, 0, 'Unsafe or broken reference build must refuse');
  assert.match(child.stderr, /guide_(?:link|path)_invalid:/u);
  assert.match(child.stderr, /Next action:/u);
  return child;
}

test('actual builder refuses a missing local heading with the source and corrective action', async (t) => {
  const fixture = await sourceFixture(t);
  await writeFile(path.join(fixture, 'docs/operator-recipes.md'),
    (await readFile(path.join(fixture, 'docs/operator-recipes.md'), 'utf8'))
    + '\n[Missing heading](installation.md#absent-local-heading)\n');
  const child = await refusedBuild(t, fixture);
  assert.match(child.stderr, /operator-recipes\.md/u);
  assert.match(child.stderr, /installation\.md#absent-local-heading/u);
});

test('actual builder preserves encoded external URL query and path bytes', async (t) => {
  const fixture = await sourceFixture(t);
  const href = 'https://example.org/a%2Fb?q=a%26b&next=%23section';
  await writeFile(path.join(fixture, 'docs/operator-recipes.md'),
    (await readFile(path.join(fixture, 'docs/operator-recipes.md'), 'utf8')) + `\n[External](${href})\n`);
  const directory = await build(t, fixture);
  const html = await readFile(path.join(directory, 'guides/docs/operator-recipes.html'), 'utf8');
  assert.ok([...html.matchAll(/href="([^"]+)"/gu)].some(match => decode(match[1]) === href),
    'External encoded delimiters must retain their original URL meaning');
});

test('actual builder retains the whole local fragment when reporting an absent heading', async (t) => {
  const fixture = await sourceFixture(t);
  const href = 'installation.md#windows-loader-and-manager-per-user-installation#extra';
  await writeFile(path.join(fixture, 'docs/operator-recipes.md'),
    (await readFile(path.join(fixture, 'docs/operator-recipes.md'), 'utf8')) + `\n[Invalid fragment](${href})\n`);
  const child = await refusedBuild(t, fixture);
  assert.ok(child.stderr.includes(href));
});

for (const leaf of ['outside.md', 'outside.txt']) {
  test(`actual builder refuses an outside-root junction for ${leaf}`, async (t) => {
    const fixture = await sourceFixture(t);
    const outside = await mkdtemp(path.join(tmpdir(), 'lodestar-guide-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, leaf), '# Outside source\n');
    await symlink(outside, path.join(fixture, 'docs/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(fixture, 'docs/operator-recipes.md'),
      (await readFile(path.join(fixture, 'docs/operator-recipes.md'), 'utf8')) + `\n[Outside](linked/${leaf})\n`);
    const child = await refusedBuild(t, fixture);
    assert.match(child.stderr, /linked/u);
    assert.equal(await readFile(path.join(outside, leaf), 'utf8'), '# Outside source\n');
  });
}

test('actual builder refuses Windows alternate-stream local paths', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await sourceFixture(t);
  await mkdir(path.join(fixture, 'docs/nested'));
  await writeFile(path.join(fixture, 'docs/nested/stream.md'), '# Regular file\n');
  await writeFile(path.join(fixture, 'docs/nested/stream.md:extra.md'), '# Alternate stream\n');
  await writeFile(path.join(fixture, 'docs/operator-recipes.md'),
    (await readFile(path.join(fixture, 'docs/operator-recipes.md'), 'utf8')) + '\n[Stream](nested/stream.md:extra.md)\n');
  const child = await refusedBuild(t, fixture);
  assert.match(child.stderr, /stream\.md:extra\.md/u);
});

test('actual builder refuses an existing output junction before writing through it', async (t) => {
  const fixture = await sourceFixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'lodestar-guide-output-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const output = path.join(fixture, 'output');
  await mkdir(output);
  await symlink(outside, path.join(output, 'guides'), process.platform === 'win32' ? 'junction' : 'dir');
  const child = await refusedBuild(t, fixture, output);
  assert.match(child.stderr, /guides/u);
  await assert.rejects(readFile(path.join(outside, 'README.html')), { code: 'ENOENT' });
});

test('selected regular output roots may have platform directory aliases above the root', async (t) => {
  const fixture = await sourceFixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'lodestar-guide-selected-root-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(outside, 'output'));
  await symlink(outside, path.join(fixture, 'selected-parent'), process.platform === 'win32' ? 'junction' : 'dir');
  const output = path.join(fixture, 'selected-parent/output');
  const child = spawnSync(process.execPath, [path.join(fixture, 'scripts/build-site.mjs'), output],
    { encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  const html = await readFile(path.join(outside, 'output/guides/docs/operator-recipes.html'), 'utf8');
  assert.match(html, /guide-source/u);
});

async function checkNavigation(directory, file) {
  const html = await readFile(path.join(directory, file), 'utf8');
  for (const [, raw] of html.matchAll(/(?:href|src)="([^"]+)"/gu)) {
    const href = decode(raw);
    if (/^[a-z][a-z\d+.-]*:/iu.test(href)) continue;
    const [pathname, fragment] = href.split('#');
    const target = pathname ? path.resolve(directory, path.dirname(file), decodeURIComponent(pathname))
      : path.join(directory, file);
    if (href.endsWith('/')) continue;
    const text = await readFile(target, 'utf8');
    if (fragment) assert.ok(text.includes(`id="${decodeURIComponent(fragment)}"`), `${file}: missing ${href}`);
  }
  return html;
}

test('current splash actions and guide fragments resolve to the exact canonical guide export', async (t) => {
  const directory = await build(t);
  const splash = await checkNavigation(directory, 'index.html');
  assert.match(splash, /href="guides\/docs\/operator-recipes\.html"/u);
  assert.match(splash, /href="guides\/docs\/installation\.html#windows-loader-and-manager-per-user-installation"/u);
  assert.doesNotMatch(splash, /href="https:\/\/github\.com\/VerbalChainsaw\/Lodestar\/blob\/main\/(?:docs\/|README\.md)/u);
  const icon = await readFile(path.join(root, 'desktop/Lodestar.Loader/Assets/Lodestar.ico'));
  const pages = (await readdir(path.join(directory, 'guides'), { recursive: true }))
    .filter(file => file.endsWith('.html'));
  for (const file of pages) {
    const page = path.join('guides', file);
    const html = await readFile(path.join(directory, page), 'utf8');
    const head = /<head>([\s\S]*?)<\/head>/u.exec(html)?.[1];
    const links = [...(head ?? '').matchAll(/<link rel="icon" type="image\/x-icon" href="([^"]+)"\s*\/>/gu)];
    assert.equal(links.length, 1, `${page}: guide HEAD must have one shared Lodestar favicon`);
    const target = path.resolve(directory, path.dirname(page), decode(links[0][1]));
    assert.equal(target, path.join(directory, 'assets/lodestar.ico'), `${page}: favicon must resolve to the exported shared asset`);
    assert.deepEqual(await readFile(target), icon, `${page}: favicon bytes differ from the canonical Windows icon`);
  }
  t.diagnostic(`Checked shared favicon HEAD, output path and canonical bytes in all ${pages.length} generated guides`);
  for (const file of guides) {
    const page = `guides/${file.replace(/\.md$/u, '.html')}`;
    const html = await checkNavigation(directory, page);
    const note = /<p class="guide-note">([^<]+)<\/p>/u.exec(html)?.[1];
    assert.match(note ?? '', /Lodestar 3\.0\.0 reference/u);
    assert.match(note ?? '', /See the installation guide for prerequisites and upgrade steps\./u);
    assert.doesNotMatch(note ?? '', /Generated|formatting remains visible/u);
    const source = await readFile(path.join(root, file));
    assert.deepEqual(await readFile(path.join(directory, `sources/${file}`)), source,
      `Source download changed bytes: ${file}`);
    const body = /<pre class="guide-source">([\s\S]*?)<\/pre>/u.exec(html);
    assert.ok(body, `Missing complete visible reference: ${file}`);
    assert.equal(decode(body[1].replace(/<[^>]+>/gu, '')), source.toString('utf8').replaceAll('\r\n', '\n'),
      `Guide omitted or changed content/code: ${file}`);
  }
});

test('real builder escapes raw HTML and unsafe links while keeping unknown formatting visible', async (t) => {
  const fixture = await sourceFixture(t);
  const malicious = '\n## Repeated heading\n## Repeated heading\n'
    + '<script>alert("unsafe")</script>\n<img src=x onerror=alert(1)>\n'
    + '[unsafe](javascript:alert) [encoded](javascript%3Aalert) [data](data:text/html,unsafe)\n'
    + '[outside](../../../../outside.md)\n'
    + '| Unknown | table |\n```html\n<a href="javascript:alert">literal code</a>\n```\n';
  await writeFile(path.join(fixture, 'docs/operator-recipes.md'),
    (await readFile(path.join(root, 'docs/operator-recipes.md'), 'utf8')) + malicious);
  const directory = await build(t, fixture);
  const html = await readFile(path.join(directory, 'guides/docs/operator-recipes.html'), 'utf8');
  assert.doesNotMatch(html, /<script|<img src=x|href="(?:javascript|data|javascript%3a):?/iu);
  assert.match(html, /&lt;script&gt;/u);
  assert.match(html, /\| Unknown \| table \|/u);
  assert.match(html, /id="repeated-heading"/u);
  assert.match(html, /id="repeated-heading-1"/u);
  assert.doesNotMatch(html, /href="[^"\n]*outside\.md/u);
});

test('site export advertises current versioned release actions behind the publication gate', async (t) => {
  const directory = await build(t);
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  const note = /<aside class="publication-note"[\s\S]*?<\/aside>/u.exec(html)?.[0];
  assert.ok(note?.includes(`Lodestar ${version}`));
  assert.match(note, /Verify the release checksums/u);
  assert.ok(html.includes(`https://github.com/VerbalChainsaw/Lodestar/releases/download/v${version}/Lodestar-${version}-win-x64.zip`));
  assert.ok(html.includes(`https://github.com/VerbalChainsaw/Lodestar/releases/tag/v${version}`));
  assert.ok(html.includes(`npm install --global lodestar-agent-context@${version}`));
  assert.match(html, /Download Windows archive/u);
  assert.doesNotMatch(html, /local release candidate|publication targets|After release publication|Windows archive target/u);
  const pages = await readFile(path.join(root, '.github/workflows/pages.yml'), 'utf8');
  assert.match(pages, /workflows: \[release\]/u);
  assert.match(pages, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(pages, /published="\$\(npm view "lodestar-agent-context@\$\{version\}" version\)"/u);
  assert.match(pages, /test "\$\{published\}" = "\$\{version\}"/u);
  assert.ok(pages.indexOf('Verify the advertised package is published') < pages.indexOf('node scripts/build-site.mjs'));
  assert.match(pages, /deploy:\s+needs: build/u);
});

test('site export ships the actual product image unchanged and resolves local resources', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lodestar-site-export-'));
  try {
    const child = spawnSync(process.execPath, [path.join(root, 'scripts/build-site.mjs'), directory], {
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const html = await readFile(path.join(directory, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /\{\{[^}]+\}\}/u);
    assert.match(html, /Demonstration data/u);
    const local = new Set([...html.matchAll(/(?:src|href)="([^"#]+)"/gu)].map(match => match[1])
      .filter(value => !/^(?:https?:|\.\/)/u.test(value)));
    assert.ok(local.has('assets/lodestar3-loader.png'));
    assert.ok(local.has('assets/lodestar.ico'), 'Splash must ship the shared Lodestar favicon');
    assert.match(html, /<link rel="icon" type="image\/x-icon" href="assets\/lodestar\.ico"\s*\/>/u);
    for (const file of local) await readFile(path.join(directory, file));
    assert.deepEqual(await readFile(path.join(directory, 'assets/lodestar3-loader.png')),
      await readFile(path.join(root, 'site/assets/lodestar3-loader.png')));
    assert.deepEqual(await readFile(path.join(directory, 'assets/lodestar.ico')),
      await readFile(path.join(root, 'desktop/Lodestar.Loader/Assets/Lodestar.ico')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
