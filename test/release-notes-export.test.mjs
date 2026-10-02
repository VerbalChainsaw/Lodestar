import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LODESTAR_RELEASE_TEST_SOURCE_ROOT
  ?? fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';

// Execute the maintained export operation, identified by PowerShell's parser.
// The full release entry point also compiles and creates archives; this boundary
// test invokes its real documentation command in a disposable packed-core layout.
// No export behavior is reproduced in the driver.
const driver = `param([string]$OwnerRoot,[string]$source,[string]$bundle,[string]$version)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $OwnerRoot 'desktop/scripts/BundleTools.psm1') -Force -DisableNameChecking
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $OwnerRoot 'desktop/scripts/Build-Release.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Release owner failed PowerShell parsing.' }
$commands=@($ast.FindAll({param($node)
  $node -is [Management.Automation.Language.CommandAst] -and (
    $node.GetCommandName() -eq 'Write-BundleReleaseNotes' -or
    ($node.GetCommandName() -eq 'Copy-Item' -and $node.Extent.Text.Contains("'RELEASE-NOTES.md'")))
},$true))
if ($commands.Count -ne 1) { throw 'Expected exactly one release notes export operation in Build-Release.' }
& ([scriptblock]::Create($commands[0].Extent.Text))
`;

async function fixture(t, version = '3.0.0') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lodestar-release-notes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const bundle = path.join(dir, 'café & portable app');
  await mkdir(source);
  await mkdir(path.join(bundle, 'core'), { recursive: true });
  await cp(path.join(ROOT, 'docs'), path.join(source, 'docs'), { recursive: true });
  if (version !== '3.0.0') {
    await writeFile(path.join(source, `docs/releases/v${version}.md`),
      `# Lodestar ${version}\n\nComplete future note, with new link contexts.\n`
      + '[Operator recipes](../operator-recipes.md)\n'
      + '[Version history](v3.0.0.md)\n'
      + '[Install](../installation.md#windows-loader-and-manager-per-user-installation)\n');
  }
  await cp(path.join(source, 'docs'), path.join(bundle, 'core/docs'), { recursive: true });
  const script = path.join(dir, 'invoke-export.ps1');
  await writeFile(script, driver);
  return { source, bundle, version, script };
}

function exportNotes(f) {
  return spawnSync('pwsh', ['-NoProfile', '-File', f.script, '-OwnerRoot', ROOT,
    '-source', f.source, '-bundle', f.bundle, '-version', f.version],
  { encoding: 'utf8', timeout: 20_000, windowsHide: true });
}

function localLinks(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/gu)]
    .map((match) => match[1])
    .filter((href) => !/^[a-z][a-z\d+.-]*:/iu.test(href));
}

// Bounded oracle for the included plain Markdown headings and explicit anchors.
// Navigation checks must reject an existing file with an absent local fragment.
function hasAnchor(text, fragment) {
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gmu)]
    .map((match) => match[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-'));
  const explicit = [...text.matchAll(/\b(?:id|name)=["']([^"']+)["']/gu)].map((match) => match[1]);
  return [...headings, ...explicit].includes(decodeURIComponent(fragment));
}

async function inspectLinks(file) {
  const text = await readFile(file, 'utf8');
  const links = localLinks(text);
  const broken = [];
  for (const href of links) {
    const [pathname, fragment] = href.split('#');
    const target = pathname ? path.resolve(path.dirname(file), decodeURIComponent(pathname)) : file;
    try {
      const targetText = await readFile(target, 'utf8');
      if (fragment && !hasAnchor(targetText, fragment)) broken.push(href);
    } catch { broken.push(href); }
  }
  return { text, links, broken };
}

for (const version of ['3.0.0', '4.1.2']) {
  test(`actual release export keeps complete ${version} notes and usable local links`, { skip: !windows }, async (t) => {
    const f = await fixture(t, version);
    const canonical = path.join(f.bundle, `core/docs/releases/v${version}.md`);
    const before = await readFile(canonical);
    const result = exportNotes(f);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `Release notes export failed: ${result.stderr}`);
    const index = await inspectLinks(path.join(f.bundle, 'RELEASE-NOTES.md'));
    assert.deepEqual(index.broken, [], `Broken exported local links: ${index.broken.join(', ')}`);
    assert.ok(index.links.includes(`core/docs/releases/v${version}.md`), 'Full canonical notes must be one click away');
    assert.ok(index.text.length < 500, 'Root index should point to the one authoritative full text');
    assert.match(index.text, new RegExp(`Lodestar ${version.replaceAll('.', '\\.')}`, 'u'));
    assert.deepEqual(await readFile(canonical), before, 'Export must preserve all canonical note bytes');
    const included = await inspectLinks(canonical);
    assert.deepEqual(included.broken, [], 'Canonical notes must retain their original link context');
  });
}

test('missing included canonical notes fails before creating a misleading root index', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.bundle, 'core/docs/releases/v3.0.0.md'));
  const result = exportNotes(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release_notes_missing:/u);
  assert.match(result.stderr, /Next action:/u);
  await assert.rejects(readFile(path.join(f.bundle, 'RELEASE-NOTES.md')), { code: 'ENOENT' });
});

test('link oracle rejects the original verbatim-copy mechanism independently', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  await cp(path.join(f.source, 'docs/releases/v3.0.0.md'), path.join(f.bundle, 'RELEASE-NOTES.md'));
  const wrong = await inspectLinks(path.join(f.bundle, 'RELEASE-NOTES.md'));
  const canonical = await inspectLinks(path.join(f.bundle, 'core/docs/releases/v3.0.0.md'));
  assert.deepEqual(wrong.broken, canonical.links,
    'Moving the full note breaks every original relative destination');
});

test('fragment oracle rejects a missing anchor even when its included target file exists', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  const note = path.join(f.bundle, 'core/docs/releases/v3.0.0.md');
  await writeFile(note, '# Fragment control\n\n[Install](../installation.md#missing-anchor-control)\n');
  const wrong = await inspectLinks(note);
  assert.deepEqual(wrong.broken, ['../installation.md#missing-anchor-control']);
});
