import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNetwork, compareNetwork } from '../src/windows-network.mjs';

const route = {
  AddressFamily: 2,
  InterfaceIndex: 7,
  DestinationPrefix: '10.0.0.0/24',
  NextHop: '10.0.0.1',
  RouteMetric: 5,
};
const dns = { InterfaceIndex: 7, AddressFamily: 2, ServerAddresses: ['10.0.0.2'] };
const emptyNetwork = { routes: [route], dns: [dns], adapters: [] };

test('unchanged routes and DNS with no ArgoDesktop adapter are restored', () => {
  assert.deepEqual(compareNetwork(emptyNetwork, structuredClone(emptyNetwork)), {
    routesEqual: true,
    dnsEqual: true,
    adapterAbsent: true,
    verified: true,
    classification: 'restored',
  });
});

test('route, DNS, or ArgoDesktop adapter changes are unexplained', () => {
  const changedRoute = { ...emptyNetwork, routes: [{ ...route, RouteMetric: 6 }] };
  const changedDns = { ...emptyNetwork, dns: [{ ...dns, ServerAddresses: ['10.0.0.3'] }] };
  const remainingAdapter = { ...emptyNetwork, adapters: [{ Name: 'ArgoDesktop', InterfaceIndex: 9 }] };
  for (const after of [changedRoute, changedDns, remainingAdapter]) {
    const result = compareNetwork(emptyNetwork, after);
    assert.equal(result.verified, false);
    assert.equal(result.classification, 'unexplained-network-change');
  }
});

test('malformed snapshots cannot be reported as restored', () => {
  assert.notEqual(compareNetwork({}, {}).classification, 'restored');
  assert.notEqual(compareNetwork(emptyNetwork, { ...emptyNetwork, routes: null }).classification, 'restored');
  const invalidRoute = { ...emptyNetwork, routes: [{ ...route, AddressFamily: null }] };
  const invalidDns = { ...emptyNetwork, dns: [{ ...dns, ServerAddresses: '10.0.0.2' }] };
  assert.notEqual(compareNetwork(invalidRoute, invalidRoute).classification, 'restored');
  assert.notEqual(compareNetwork(invalidDns, invalidDns).classification, 'restored');
});

test('capture uses bounded hidden noninteractive PowerShell and parses BOM JSON', async () => {
  let invocation;
  const expected = { routes: [route], dns: [dns], adapters: [] };
  const actual = await captureNetwork({ async execFileImpl(file, args, options) {
    invocation = { file, args, options };
    return { stdout: `\uFEFF${JSON.stringify(expected)}`, stderr: '' };
  } });
  assert.deepEqual(actual, expected);
  assert.match(invocation.file, /powershell/i);
  assert.ok(invocation.args.includes('-NoProfile'));
  assert.ok(invocation.args.includes('-NonInteractive'));
  assert.ok(!invocation.args.includes('-ExecutionPolicy'));
  assert.equal(invocation.options.timeout, 2000);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.maxBuffer, 1024 * 1024);
  const script = invocation.args.at(-1);
  assert.match(script, /Get-CimInstance/);
  assert.match(script, /MSFT_NetRoute/);
  assert.match(script, /Store=1/);
  assert.match(script, /MSFT_DNSClientServerAddress/);
  assert.match(script, /MSFT_NetAdapter/);
  assert.match(script, /ArgoDesktop/);
  assert.match(script, /ErrorActionPreference/);
});

test('capture hides execution and parse failures behind NETWORK_SNAPSHOT_FAILED', async () => {
  for (const execFileImpl of [
    async () => { throw new Error('private command detail'); },
    async () => ({ stdout: '{bad json', stderr: '' }),
    async () => ({ stdout: '{"routes":[],"dns":[]}', stderr: '' }),
    async () => ({ stdout: '{"routes":null,"dns":[],"adapters":[]}', stderr: '' }),
    async () => ({ stdout: JSON.stringify({ ...emptyNetwork, routes: [{ ...route, RouteMetric: null }] }), stderr: '' }),
    async () => ({ stdout: JSON.stringify({ ...emptyNetwork, dns: [{ ...dns, ServerAddresses: [null] }] }), stderr: '' }),
  ]) {
    await assert.rejects(captureNetwork({ execFileImpl }), (error) => {
      assert.equal(error.code, 'NETWORK_SNAPSHOT_FAILED');
      assert.doesNotMatch(error.message, /private command detail|bad json/i);
      return true;
    });
  }
});
