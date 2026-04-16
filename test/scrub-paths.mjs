// Regression test for dario#35 — scrubFrameworkIdentifiers must not
// corrupt filesystem paths or URLs that happen to contain a framework
// identifier. Before the fix, `/Users/foo/.openclaw/workspace/` became
// `/Users/foo/./workspace/` because `\b` word boundaries fired between
// `.` and `o`.

import { scrubFrameworkIdentifiers } from '../dist/cc-template.js';

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

console.log('\n======================================================================');
console.log('  dario#35 — path preservation in scrubFrameworkIdentifiers');
console.log('======================================================================');

// Paths must survive unchanged
assertEq(
  scrubFrameworkIdentifiers('/Users/foo/.openclaw/workspace/'),
  '/Users/foo/.openclaw/workspace/',
  'unix hidden dir .openclaw preserved',
);
assertEq(
  scrubFrameworkIdentifiers('C:\\Users\\foo\\.openclaw\\workspace'),
  'C:\\Users\\foo\\.openclaw\\workspace',
  'windows path with .openclaw preserved',
);
assertEq(
  scrubFrameworkIdentifiers('~/.openclaw/config.json'),
  '~/.openclaw/config.json',
  'tilde-expanded openclaw path preserved',
);
assertEq(
  scrubFrameworkIdentifiers('https://openclaw.dev/docs'),
  'https://openclaw.dev/docs',
  'URL host openclaw.dev preserved',
);
assertEq(
  scrubFrameworkIdentifiers('/tmp/aider-cache/session.db'),
  '/tmp/aider-cache/session.db',
  'aider path segment preserved',
);
assertEq(
  scrubFrameworkIdentifiers('load ~/.cursor/settings.json'),
  'load ~/.cursor/settings.json',
  'cursor in dotfile path preserved',
);

// Prose scrubbing must still work
assertEq(
  scrubFrameworkIdentifiers('powered by openclaw'),
  'powered by ',
  'prose "powered by openclaw" — openclaw stripped (powered-by pattern needs a trailing word)',
);
assertEq(
  scrubFrameworkIdentifiers('this request came from openclaw today'),
  'this request came from  today',
  'standalone openclaw in prose still stripped',
);
assertEq(
  scrubFrameworkIdentifiers('running openclaw with aider alongside cursor'),
  'running  with  alongside ',
  'multiple identifiers in prose still stripped',
);
assertEq(
  scrubFrameworkIdentifiers('gpt-4 is not claude'),
  ' is not claude',
  'gpt-4 stripped (claude passes through — not in pattern)',
);

// Mixed: path in same string as prose
assertEq(
  scrubFrameworkIdentifiers('use openclaw, config at ~/.openclaw/config'),
  'use , config at ~/.openclaw/config',
  'prose stripped but path segment preserved in same string',
);

// v3.19 — expanded framework pattern set. Each new identifier must be
// stripped in prose but preserved inside paths/URLs (same word-boundary
// contract as the existing set).
console.log('\n======================================================================');
console.log('  v3.19 — new framework identifiers stripped in prose');
console.log('======================================================================');
assertEq(scrubFrameworkIdentifiers('launched via zed today'), 'launched via  today', 'zed stripped in prose');
assertEq(scrubFrameworkIdentifiers('plandex generated this'), ' generated this', 'plandex stripped in prose');
assertEq(scrubFrameworkIdentifiers('tabby suggested fix'), ' suggested fix', 'tabby stripped in prose');
assertEq(scrubFrameworkIdentifiers('running Amazon Q flow'), 'running  flow', 'amazon q stripped in prose');
assertEq(scrubFrameworkIdentifiers('opencode cli was here'), ' cli was here', 'opencode stripped in prose');
assertEq(scrubFrameworkIdentifiers('spawned in daytona env'), 'spawned in  env', 'daytona stripped in prose');
assertEq(scrubFrameworkIdentifiers('use Roo Code today'), 'use  today', 'roo code (space variant) stripped in prose');
assertEq(scrubFrameworkIdentifiers('use roo-code today'), 'use  today', 'roo-code (dash variant) stripped in prose');

console.log('\n======================================================================');
console.log('  v3.19 — new identifiers preserved inside paths');
console.log('======================================================================');
assertEq(scrubFrameworkIdentifiers('/opt/zed/bin'), '/opt/zed/bin', 'zed preserved in path');
assertEq(scrubFrameworkIdentifiers('~/.plandex/cache'), '~/.plandex/cache', 'plandex preserved in dotfile path');
assertEq(scrubFrameworkIdentifiers('/usr/local/tabby/db'), '/usr/local/tabby/db', 'tabby preserved in path');
assertEq(scrubFrameworkIdentifiers('https://opencode.ai/docs'), 'https://opencode.ai/docs', 'opencode preserved in URL');
assertEq(scrubFrameworkIdentifiers('/var/daytona/workspace'), '/var/daytona/workspace', 'daytona preserved in path');

console.log('\n======================================================================');
console.log(`  ${pass} pass, ${fail} fail`);
console.log('======================================================================\n');

if (fail > 0) process.exit(1);
