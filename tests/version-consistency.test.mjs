import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const guiVersion = read('src/ArgoDesktop.cs').match(/public const string Version\s*=\s*"([^"]+)"/)?.[1];
const numericVersion = `${guiVersion}.0`;

test('GUI identifies the current release', () => {
  assert.equal(guiVersion, '0.3.0');
});

test('worker reports use the GUI release expected by self-test validation', () => {
  const workerVersion = read('src/worker.mjs').match(/const report=\{version:'([^']+)'/)?.[1];
  assert.equal(workerVersion, guiVersion);
});

test('manifest assembly identity matches the GUI release', () => {
  const manifestVersion = read('src/app.manifest').match(/<assemblyIdentity\b[^>]*\bversion="([^"]+)"/)?.[1];
  assert.equal(manifestVersion, numericVersion);
});

test('managed assembly and Windows file/product metadata match the GUI release', () => {
  const source = readdirSync(new URL('src/', root)).filter(name => name.endsWith('.cs')).map(name => read(`src/${name}`)).join('\n');
  for (const attribute of ['AssemblyVersion', 'AssemblyFileVersion', 'AssemblyInformationalVersion']) {
    const values = [...source.matchAll(new RegExp(`\\[assembly:\\s*${attribute}\\("([^"\\n]+)"\\)\\]`, 'g'))].map(match => match[1]);
    assert.deepEqual(values, [numericVersion], attribute);
  }
});

test('installer release and Windows metadata match the GUI release', () => {
  const setup = read('setup.nsi');
  assert.equal(setup.match(/^!define VERSION "([^"]+)"/m)?.[1], guiVersion);
  assert.equal(setup.match(/^VIProductVersion "([^"]+)"/m)?.[1], numericVersion);
  for (const key of ['FileVersion', 'ProductVersion']) {
    assert.equal(setup.match(new RegExp(`^VIAddVersionKey "${key}" "([^"]+)"`, 'm'))?.[1], numericVersion, key);
  }
  assert.equal(setup.match(/^OutFile "[^"\r\n]*ArgoDesktop-Setup-([^"\r\n]+)-x64\.exe"/m)?.[1], guiVersion);
});

test('application notices identify the GUI release', () => {
  const heading = read('assets/THIRD-PARTY-NOTICES.txt').split(/\r?\n/, 1)[0];
  assert.equal(heading, `Argo Desktop ${guiVersion} — unofficial interoperability client`);
});
