import { writeFullRedactedBodyLog } from '../dist/proxy.js';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const WORKSPACE = join(tmpdir(), `dario-proxy-body-log-${randomBytes(6).toString('hex')}`);
mkdirSync(WORKSPACE, { recursive: true });

header('writeFullRedactedBodyLog — creates parent dirs and writes full redacted body');
{
  const target = join(WORKSPACE, 'nested', 'request.json');
  const raw = JSON.stringify({
    authorization: 'Bearer super-secret-token',
    apiKey: 'sk-ant-secret-value',
    jwt: 'eyJabc.eyJdef.ghi',
    prompt: 'hello',
  });
  writeFullRedactedBodyLog(target, raw);
  check('target file exists', existsSync(target));
  const out = readFileSync(target, 'utf8');
  check('body content preserved', out.includes('"prompt":"hello"'));
  check('bearer token redacted', out.includes('Bearer [REDACTED]'));
  check('anthropic key redacted', out.includes('[REDACTED]'));
  check('jwt redacted', out.includes('[REDACTED_JWT]'));
  check('newline appended', out.endsWith('\n'));
}

rmSync(WORKSPACE, { recursive: true, force: true });

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
