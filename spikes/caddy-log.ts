// Summarise Caddy's JSON access log from stdin: status host method path <- caller.
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  let j: any;
  try { j = JSON.parse(line); } catch { continue; }
  if (!j.request || j.msg !== 'handled request') continue;
  const r = j.request;
  if (r.uri.includes('_health')) continue;
  console.log(j.status, r.host, r.method, r.uri.slice(0, 80), '<-', r.remote_ip, (r.headers['User-Agent'] ?? [''])[0].slice(0, 30));
}
