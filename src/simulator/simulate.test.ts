import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import { generate, type Environment, type InputValues } from '../generator/generate';
import { assumeHome, hostOf, loadGuard, simulate, type Call, type SimContext } from './simulate';

const here = dirname(fileURLToPath(import.meta.url));
// Loaded from source text, the same way the page does it.
const guard = loadGuard(readFileSync(join(here, '../hook/deny-guard.cjs'), 'utf8'));

const posix: SimContext = { win: false, home: '/home/dev', projectDir: '/home/dev/code/app', tmpDirs: ['/tmp'], currentBranch: 'feature/x', scope: 'project' };
const windows: SimContext = {
  win: true,
  home: 'C:\\Users\\dev',
  projectDir: 'C:\\Users\\dev\\code\\app',
  tmpDirs: ['C:\\Users\\dev\\AppData\\Local\\Temp'],
  currentBranch: 'feature/x',
  scope: 'project',
};
const linuxEnv: Environment = { os: 'linux', shells: ['bash', 'powershell'], scope: 'project', sandbox: 'off' };
const windowsEnv: Environment = { ...linuxEnv, os: 'windows' };

function run(ids: string[], call: Call, inputs: InputValues = {}, opts: { win?: boolean; ctx?: Partial<SimContext>; env?: Partial<Environment> } = {}) {
  const env = { ...(opts.win ? windowsEnv : linuxEnv), ...opts.env };
  const g = generate({ env, selections: ids.map((id) => ({ id })), inputs });
  return simulate(call, g.rules, g.hook?.rules, guard, { ...(opts.win ? windows : posix), scope: env.scope, ...opts.ctx });
}

/**
 * Every test case in the catalog, with only its own item enabled.
 *
 * - block, by rule: the permission rules alone must stop it.
 * - block, by hook: the rules must NOT stop it (the page tells users these
 *   need the hook), and the hook must.
 * - allow: neither may stop it.
 */
describe('catalog test cases against rules and hook together', () => {
  for (const item of catalog) {
    describe(item.id, () => {
      for (const t of item.tests) {
        const win = t.tool === 'PowerShell' || /^[A-Za-z]:\\/.test(t.input);
        const want = item.defaultMode;
        const label = t.expect === 'allow' ? 'allow' : `${want} by ${t.by}`;
        it(`${label}: ${t.tool} ${t.input}`, () => {
          const r = run([item.id], { tool: t.tool, input: t.input } as Call, item.sampleInputs, { win });
          if (t.expect === 'allow') {
            expect(r.ruleHits.map((h) => h.rule), 'rules').toEqual([]);
            expect(r.hookHits.map((h) => h.reason), 'hook').toEqual([]);
          } else if (t.by === 'rule') {
            expect(r.ruleDecision).toBe(want);
          } else {
            expect(r.ruleHits.map((h) => h.rule), 'rules should not catch a hook-only case').toEqual([]);
            expect(r.hookDecision).toBe(want);
          }
        });
      }
    });
  }
});

describe('path rules', () => {
  const env = ['secrets.env-files'];
  const read = (input: string, ids = env, inputs: InputValues = {}, opts = {}) => run(ids, { tool: 'Read', input }, inputs, opts).ruleHits.map((h) => h.rule);

  it('matches bare names at any depth and honours carve-outs', () => {
    expect(read('.env')).toEqual(['Read(.env)']);
    expect(read('packages/api/.env.local')).toEqual(['Read(.env.*)']);
    expect(read('.env.example')).toEqual([]);
    expect(read('packages/api/.env.sample')).toEqual([]);
    expect(read('.environment')).toEqual([]);
    // Outside the current directory a relative rule does not reach.
    expect(read('/srv/other/.env')).toEqual([]);
  });

  it('lets a Read rule block edits, but not an Edit rule block reads', () => {
    expect(run(env, { tool: 'Edit', input: '.env' }).ruleDecision).toBe('deny');
    const inputs = { protectedPaths: ['db/migrations/'] };
    expect(run(['local.protected-paths'], { tool: 'Edit', input: 'db/migrations/1.sql' }, inputs).ruleDecision).toBe('deny');
    expect(run(['local.protected-paths'], { tool: 'Read', input: 'db/migrations/1.sql' }, inputs).ruleDecision).toBe('allow');
  });

  it('resolves home, absolute and project anchors', () => {
    expect(read('~/.ssh/id_rsa', ['secrets.ssh-keys'])).toEqual(['Read(~/.ssh/**)']);
    expect(read('/home/dev/.ssh/config', ['secrets.ssh-keys'])).toEqual(['Read(~/.ssh/**)']);
    expect(read('/home/other/.ssh/config', ['secrets.ssh-keys'])).toEqual([]);
    const custom = { secretPaths: ['/etc/app/', 'vault'] };
    expect(read('/etc/app/key.json', ['secrets.custom-paths'], custom)).toEqual(['Read(//etc/app/**)']);
    // Both generated forms cover a file inside: the folder rule and the contents rule.
    expect(read('vault/a/b.txt', ['secrets.custom-paths'], custom)).toEqual(['Read(/vault)', 'Read(/vault/**)']);
    expect(read('vault', ['secrets.custom-paths'], custom)).toEqual(['Read(/vault)']);
    // `/vault` is anchored at the project root, so a nested folder of the same name is not covered.
    expect(read('src/vault/a.txt', ['secrets.custom-paths'], custom)).toEqual([]);
  });

  it('anchors /path at ~/.claude in user settings, which is why the generator avoids it there', () => {
    const user = { env: { scope: 'user' as const } };
    const inputs = { protectedPaths: ['db/migrations/'] };
    const r = run(['local.protected-paths'], { tool: 'Edit', input: 'db/migrations/1.sql' }, inputs, user);
    expect(r.ruleHits.map((h) => h.rule)).toEqual(['Edit(db/migrations/**)']);
  });

  it('ignores case and slash direction on Windows', () => {
    const inputs = { secretPaths: ['C:\\Keys\\'] };
    for (const p of ['C:\\keys\\prod.pem', 'c:/KEYS/sub/x.pem', '/c/Keys/prod.pem']) {
      expect(read(p, ['secrets.custom-paths'], inputs, { win: true }), p).toEqual(['Read(//c/Keys/**)']);
    }
    expect(read('C:\\Users\\dev\\.SSH\\id_rsa', ['secrets.ssh-keys'], {}, { win: true })).toEqual(['Read(~/.ssh/**)']);
    expect(read('D:\\keys\\prod.pem', ['secrets.custom-paths'], inputs, { win: true })).toEqual([]);
  });
});

describe('command rules', () => {
  const bash = (input: string, ids: string[], inputs: InputValues = {}) => run(ids, { tool: 'Bash', input }, inputs, { env: { hook: false } });

  it('follows the documented wildcard forms', () => {
    const ids = ['local.git-discard'];
    expect(bash('git reset --hard', ids).ruleDecision).toBe('deny');
    expect(bash('git reset --hard HEAD~2', ids).ruleDecision).toBe('deny');
    expect(bash('git reset --hardly', ids).ruleDecision).toBe('allow');
    expect(bash('git clean -fdx', ids).ruleDecision).toBe('deny');
    expect(bash('git clean', ids).ruleDecision).toBe('allow');
  });

  it('checks every part of a compound command and inside substitutions', () => {
    const ids = ['local.git-discard'];
    for (const c of ['npm test && git reset --hard', 'cd sub; git reset --hard', 'echo "$(git reset --hard)"', 'true || (git reset --hard)', 'for f in a; do git reset --hard; done']) {
      expect(bash(c, ids).ruleDecision, c).toBe('deny');
    }
    expect(bash('echo "git reset --hard"', ids).ruleDecision).toBe('allow');
  });

  it('strips the documented wrappers and leading assignments, and nothing else', () => {
    const ids = ['local.git-discard'];
    for (const c of ['timeout 30 git reset --hard', 'nohup git reset --hard', 'FOO=1 git reset --hard', 'xargs git reset --hard', 'nice -n 5 git reset --hard', 'command git reset --hard']) {
      expect(bash(c, ids).ruleDecision, c).toBe('deny');
    }
    // These are exactly the gaps the docs list for Bash rules.
    for (const c of ['sudo git reset --hard', '/usr/bin/git reset --hard', 'git -C . reset --hard', `bash -c 'git reset --hard'`, 'xargs -n1 git reset --hard', 'env git reset --hard']) {
      expect(bash(c, ids).ruleDecision, c).toBe('allow');
    }
  });

  it('holds recognised file commands and redirects to path rules', () => {
    const ids = ['secrets.env-files', 'local.protected-paths'];
    const inputs = { protectedPaths: ['package-lock.json'] };
    expect(bash('cat .env', ids, inputs).ruleHits[0]).toMatchObject({ rule: 'Read(.env)', via: '`cat` reads .env' });
    expect(bash('sort < .env', ids, inputs).ruleDecision).toBe('deny');
    expect(bash('echo x > package-lock.json', ids, inputs).ruleDecision).toBe('deny');
    expect(bash('echo x | tee package-lock.json', ids, inputs).ruleDecision).toBe('deny');
    expect(bash('cat package-lock.json', ids, inputs).ruleDecision).toBe('allow');
    // Programs Claude Code does not recognise as file commands are not held to path rules.
    expect(bash('base64 .env', ids, inputs).ruleDecision).toBe('allow');
    expect(bash('grep -r KEY .', ids, inputs).ruleDecision).toBe('allow');
    expect(bash('echo done 2>&1 > /dev/null', ids, inputs).ruleDecision).toBe('allow');
  });

  it('canonicalises PowerShell aliases and ignores case', () => {
    const ps = (input: string) => run(['secrets.printing-commands', 'local.git-discard'], { tool: 'PowerShell', input }, {}, { win: true, env: { hook: false } }).ruleDecision;
    expect(ps('gci Env:')).toBe('deny');
    expect(ps('GET-CHILDITEM env:')).toBe('deny');
    expect(ps('npm test; GIT reset --hard')).toBe('deny');
    expect(ps('Write-Output "git reset --hard"')).toBe('allow');
  });

  it('only applies a rule to its own shell tool', () => {
    const r = generate({ env: { ...linuxEnv, shells: ['bash'], hook: false }, selections: [{ id: 'local.git-discard' }] });
    expect(simulate({ tool: 'PowerShell', input: 'git reset --hard' }, r.rules, undefined, guard, windows).ruleDecision).toBe('allow');
    expect(simulate({ tool: 'Bash', input: 'git reset --hard' }, r.rules, undefined, guard, posix).ruleDecision).toBe('deny');
  });
});

describe('domains and MCP tools', () => {
  it('matches a host and its subdomains, not lookalikes', () => {
    const inputs = { blockedDomains: ['pastebin.com'] };
    const fetch = (input: string) => run(['remote.blocked-domains'], { tool: 'WebFetch', input }, inputs).ruleHits.map((h) => h.rule);
    expect(fetch('https://pastebin.com/raw/x')).toEqual(['WebFetch(domain:pastebin.com)']);
    expect(fetch('http://a.b.PASTEBIN.com:8080/x')).toEqual(['WebFetch(domain:*.pastebin.com)']);
    expect(fetch('https://notpastebin.com')).toEqual([]);
    expect(fetch('https://pastebin.com.evil.example')).toEqual([]);
    expect(hostOf('user@api.example.com:443/path')).toBe('api.example.com');
  });

  it('matches a tool by name or by server', () => {
    const inputs = { mcpTools: ['mcp__slack__send_message', 'gmail'] };
    const mcp = (input: string) => run(['remote.mcp-tools'], { tool: 'Mcp', input }, inputs).ruleDecision;
    expect(mcp('mcp__slack__send_message')).toBe('ask');
    expect(mcp('mcp__slack__send_message_draft')).toBe('allow');
    expect(mcp('mcp__gmail__anything')).toBe('ask');
    expect(mcp('mcp__gmailer__send')).toBe('allow');
  });
});

describe('rules and hook side by side', () => {
  it('reports hook hits separately so the page can say what the hook adds', () => {
    const r = run(['local.git-discard'], { tool: 'Bash', input: 'git -C . reset --hard' });
    expect(r.ruleDecision).toBe('allow');
    expect(r.hookDecision).toBe('deny');
    expect(r.hookHits[0]).toMatchObject({ id: 'local.git-discard' });
  });

  it('returns no hook hits when no hook rules are passed', () => {
    const r = run(['local.git-discard'], { tool: 'Bash', input: 'git -C . reset --hard' }, {}, { env: { hook: false } });
    expect(r.hookHits).toEqual([]);
    expect(r.hookDecision).toBe('allow');
  });

  it('uses the branch it is told the user is on', () => {
    const inputs = { protectedBranches: ['main'] };
    const push = (currentBranch: string) => run(['remote.protected-branches'], { tool: 'Bash', input: 'git push' }, inputs, { ctx: { currentBranch } });
    expect(push('main').hookDecision).toBe('ask');
    expect(push('main').ruleDecision).toBe('allow');
    expect(push('feature/x').hookDecision).toBe('allow');
  });
});

describe('assumeHome', () => {
  it.each([
    ['C:\\Users\\alice\\.ssh\\id_rsa', '~\\.ssh\\id_rsa'],
    ['cat /home/alice/.aws/credentials', 'cat ~/.aws/credentials'],
    ['/Users/bob', '~'],
    ['/c/Users/bob/x', '~/x'],
    ['/home', '/home'],
    ['docs/readme.md', 'docs/readme.md'],
  ])('%s', (input, expected) => {
    expect(assumeHome(input)).toBe(expected);
  });
});
