import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const { version } = JSON.parse(read('package.json'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('desktop/package.json must contain a valid application version');
}

function update(name, change) {
  const source = read(name);
  let next = change(source.replace(/\r\n/g, '\n'));
  if (source.includes('\r\n')) next = next.replace(/\n/g, '\r\n');
  if (next !== source) writeFileSync(new URL(name, root), next);
}

for (const name of ['package-lock.json', 'ui/package.json', 'ui/package-lock.json']) {
  update(name, source => {
    const data = JSON.parse(source);
    data.version = version;
    if (name.endsWith('package-lock.json')) data.packages[''].version = version;
    return JSON.stringify(data, null, 2) + '\n';
  });
}
update('Cargo.toml', source => {
  if (!/^version = "[^"]+"$/m.test(source)) throw new Error('Missing Cargo package version');
  return source.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
});
update('Cargo.lock', source => {
  const pattern = /(^name = "openink-studio"\nversion = ")[^"]+("$)/m;
  if (!pattern.test(source)) throw new Error('Missing application package in Cargo.lock');
  return source.replace(pattern, (_, before, after) => before + version + after);
});
console.log(`Application version: ${version} (${fileURLToPath(new URL('package.json', root))})`);
