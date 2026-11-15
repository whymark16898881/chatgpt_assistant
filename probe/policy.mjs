import { BlockList, isIP } from 'node:net';
import { ProbeError, policyError } from './errors.mjs';

const v4 = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
]) v4.addSubnet(address,bits,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
const v6 = new BlockList();
for (const [address,bits] of [
  ['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['64:ff9b::',96],
  ['64:ff9b:1::',48],['100::',64],['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]
]) v6.addSubnet(address,bits,'ipv6');
const mapped = new BlockList(); mapped.addSubnet('::ffff:0:0',96,'ipv6');

function unmap(address) {
  if (address.includes('.')) return address.slice(address.lastIndexOf(':')+1);
  const [left,right=''] = address.toLowerCase().split('::');
  const a=left?left.split(':'):[], b=right?right.split(':'):[];
  const words=[...a,...Array(8-a.length-b.length).fill('0'),...b].map(x=>parseInt(x,16));
  const x=words[6],y=words[7]; return `${x>>8}.${x&255}.${y>>8}.${y&255}`;
}
export function classifyIP(address) {
  let family=isIP(address);
  if (family===6 && mapped.check(address,'ipv6')) { address=unmap(address);family=isIP(address); }
  const publicAddress=family===4 ? !v4.check(address,'ipv4') : family===6 && global6.check(address,'ipv6') && !v6.check(address,'ipv6');
  return { address, family, public: Boolean(publicAddress), category: publicAddress?'public_unicast':'non_public' };
}
export const knownHosts = new Set(['files.oaiusercontent.com','oaisdmntprindiasocentral.blob.core.windows.net','oaisdmntprseasia.blob.core.windows.net']);
export function hostClass(hostname) { return hostname.endsWith('.oaiusercontent.com') || knownHosts.has(hostname) ? 'openai_known' : 'other'; }
export function parseURL(raw, { policy='public_https', legacyHosts=['files.oaiusercontent.com'], legacySubdomains=false }={}) {
  let url;
  try { url=new URL(raw); } catch { throw policyError(); }
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if (url.protocol!=='https:' || (url.port && url.port!=='443') || !hostname || isIP(hostname) || url.username || url.password || raw.includes('#')) throw policyError();
  if (!['public_https','allowlist'].includes(policy)) throw policyError();
  if (policy==='allowlist' && !legacyHosts.includes(hostname) && !(legacySubdomains && hostname.endsWith('.oaiusercontent.com'))) throw policyError();
  return url;
}
export function validateAddresses(records) {
  if (!Array.isArray(records) || !records.length) throw new ProbeError('DNS_FAILED','No usable DNS address.',{retryable:true,retryAction:'retry_tool'});
  const checked=records.map(r=>classifyIP(r.address));
  if (checked.some(r=>!r.public)) throw new ProbeError('PRIVATE_DESTINATION','DNS includes a non-public destination.');
  // Prefer IPv4 for NAS installations without usable IPv6 routing. Every answer was checked.
  return checked.sort((a,b)=>a.family-b.family);
}
