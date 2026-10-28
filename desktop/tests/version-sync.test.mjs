import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

test('one version updates all generated manifests without changing dependency versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'openink-version-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'ui'));
    copyFileSync(new URL('../scripts/sync-version.mjs', import.meta.url), join(root, 'scripts/sync-version.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3-beta.1' }));
    const manifest = { version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/example': { version: '0.1.0' } } };
    for (const name of ['package-lock.json', 'ui/package.json', 'ui/package-lock.json']) {
      writeFileSync(join(root, name), JSON.stringify(manifest));
    }
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "openink-studio"\nversion = "0.1.0"\n');
    writeFileSync(join(root, 'Cargo.lock'), '[[package]]\nname = "openink-studio"\nversion = "0.1.0"\n\n[[package]]\nname = "example"\nversion = "0.1.0"\n');
    const run = () => execFileSync(process.execPath, [join(root, 'scripts/sync-version.mjs')]);
    run();
    for (const name of ['package-lock.json', 'ui/package.json', 'ui/package-lock.json']) {
      const data = JSON.parse(readFileSync(join(root, name)));
      assert.equal(data.version, '1.2.3-beta.1');
      assert.equal(data.packages['node_modules/example'].version, '0.1.0');
      if (name.endsWith('package-lock.json')) assert.equal(data.packages[''].version, '1.2.3-beta.1');
    }
    assert.match(readFileSync(join(root, 'Cargo.toml'), 'utf8'), /version = "1.2.3-beta.1"/);
    const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
    assert.match(lock, /name = "openink-studio"\nversion = "1.2.3-beta.1"/);
    assert.match(lock, /name = "example"\nversion = "0.1.0"/);
    run();
    assert.equal(readFileSync(join(root, 'Cargo.lock'), 'utf8'), lock);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: 'invalid' }));
    assert.notEqual(spawnSync(process.execPath, [join(root, 'scripts/sync-version.mjs')]).status, 0);
    assert.equal(readFileSync(join(root, 'Cargo.lock'), 'utf8'), lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
