const dns = require('node:dns/promises');
const net = require('node:net');
const { RouterError } = require('./route-policy.cjs');

const IPV4_MAX = 0xffffffffn;

function ipv4ToBigInt(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
}

function ipv4FromBigInt(value) {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

function inCidr(value, bits, network, prefix) {
  const fullMask = (1n << BigInt(bits)) - 1n;
  const mask = prefix === 0 ? 0n : (fullMask << BigInt(bits - prefix)) & fullMask;
  return (value & mask) === (network & mask);
}

function ipv6ToBigInt(address) {
  if (address.includes('%')) return null;
  let source = address.toLowerCase();
  if (source.includes('.')) {
    const separator = source.lastIndexOf(':');
    const ipv4 = ipv4ToBigInt(source.slice(separator + 1));
    if (ipv4 === null) return null;
    source = `${source.slice(0, separator)}:${((ipv4 >> 16n) & 0xffffn).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }
  const pieces = source.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function isPublicIpv4(address) {
  const value = ipv4ToBigInt(address);
  if (value === null) return false;
  const blocked = [
    [0n, 8], [0x0a000000n, 8], [0x64400000n, 10], [0x7f000000n, 8], [0xa9fe0000n, 16],
    [0xac100000n, 12], [0xc0000000n, 24], [0xc0000200n, 24], [0xc0586300n, 24],
    [0xc0a80000n, 16], [0xc6120000n, 15], [0xc6336400n, 24], [0xcb007100n, 24],
    [0xe0000000n, 4], [0xf0000000n, 4],
  ];
  return !blocked.some(([network, prefix]) => inCidr(value, 32, network, prefix));
}

function isPublicIpv6(address) {
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  const mappedPrefix = 0xffffn << 32n;
  if (inCidr(value, 128, mappedPrefix, 96)) return isPublicIpv4(ipv4FromBigInt(value & IPV4_MAX));
  const blocked = [
    [0n, 128], [1n, 128], [0x64ff9b00010000000000000000000000n, 48], [0x1000000000000000000000000000000n, 64],
    [0x20010000000000000000000000000000n, 23], [0x20010db8000000000000000000000000n, 32],
    [0xfc000000000000000000000000000000n, 7], [0xfe800000000000000000000000000000n, 10],
    [0xff000000000000000000000000000000n, 8],
  ];
  return !blocked.some(([network, prefix]) => inCidr(value, 128, network, prefix));
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

function blockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
}

function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RouterError('NETWORK_DENIED', 'navigation requires an absolute public HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new RouterError('NETWORK_DENIED', 'navigation only permits credential-free public HTTP(S) URLs');
  }
  const defaultPort = url.protocol === 'http:' ? '80' : '443';
  if (url.port && url.port !== defaultPort) throw new RouterError('NETWORK_DENIED', 'navigation only permits standard web ports');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (blockedHostname(hostname) || (net.isIP(hostname) && !isPublicAddress(hostname))) {
    throw new RouterError('NETWORK_DENIED', 'navigation target is private, loopback, or special-use');
  }
  return url;
}

async function resolvePublicAddress(hostname, lookup = dns.lookup) {
  if (blockedHostname(hostname)) throw new RouterError('NETWORK_DENIED', 'hostname is private or loopback');
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new RouterError('NETWORK_DENIED', 'address is private, loopback, or special-use');
    return { address: hostname, family: net.isIP(hostname) };
  }
  let results;
  try {
    results = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new RouterError('NETWORK_DENIED', 'public DNS resolution failed');
  }
  const publicResult = results.find((result) => isPublicAddress(result.address));
  if (!publicResult) throw new RouterError('NETWORK_DENIED', 'hostname has no public address');
  return { address: publicResult.address, family: publicResult.family };
}

module.exports = { RouterError, assertPublicUrl, isPublicAddress, resolvePublicAddress, blockedHostname };
