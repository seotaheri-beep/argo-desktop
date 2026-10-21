import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

const snapshotScript = `$ErrorActionPreference = 'Stop'
$routes = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetRoute -Filter 'Store=1' | Sort-Object AddressFamily, InterfaceIndex, DestinationPrefix, NextHop, RouteMetric | Select-Object AddressFamily, InterfaceIndex, DestinationPrefix, NextHop, RouteMetric)
$dns = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_DNSClientServerAddress | Sort-Object InterfaceIndex, AddressFamily | Select-Object InterfaceIndex, AddressFamily, ServerAddresses)
$adapters = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter -Filter "Name='ArgoDesktop'" | Select-Object Name, InterfaceIndex)
ConvertTo-Json -InputObject @{ routes = $routes; dns = $dns; adapters = $adapters } -Depth 8 -Compress`;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSnapshot(value) {
  if (!isRecord(value) || !Array.isArray(value.routes) || !Array.isArray(value.dns) || !Array.isArray(value.adapters)) {
    return false;
  }
  return value.routes.every((item) => isRecord(item)
      && isNonnegativeInteger(item.AddressFamily)
      && isNonnegativeInteger(item.InterfaceIndex)
      && isNonemptyString(item.DestinationPrefix)
      && isNonemptyString(item.NextHop)
      && isNonnegativeInteger(item.RouteMetric))
    && value.dns.every((item) => isRecord(item)
      && isNonnegativeInteger(item.InterfaceIndex)
      && isNonnegativeInteger(item.AddressFamily)
      && Array.isArray(item.ServerAddresses)
      && item.ServerAddresses.every((address) => typeof address === 'string'))
    && value.adapters.every((item) => isRecord(item)
      && isNonemptyString(item.Name)
      && isNonnegativeInteger(item.InterfaceIndex));
}

function failure() {
  const error = new Error('Network snapshot failed');
  error.code = 'NETWORK_SNAPSHOT_FAILED';
  return error;
}

export async function captureNetwork({ execFileImpl = execFile } = {}) {
  try {
    const { stdout } = await execFileImpl('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      snapshotScript,
    ], {
      timeout: 2000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const text = String(stdout).replace(/^\uFEFF/, '').trim();
    const snapshot = JSON.parse(text);
    if (!isSnapshot(snapshot)) throw failure();
    return snapshot;
  } catch {
    throw failure();
  }
}

export function compareNetwork(before, after) {
  const valid = isSnapshot(before) && isSnapshot(after);
  const routesEqual = valid && JSON.stringify(before.routes) === JSON.stringify(after.routes);
  const dnsEqual = valid && JSON.stringify(before.dns) === JSON.stringify(after.dns);
  const adapterAbsent = valid && after.adapters.length === 0;
  const verified = routesEqual && dnsEqual && adapterAbsent;
  return {
    routesEqual,
    dnsEqual,
    adapterAbsent,
    verified,
    classification: verified ? 'restored' : 'unexplained-network-change',
  };
}
