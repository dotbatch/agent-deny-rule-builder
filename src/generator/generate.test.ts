import { describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import { generate, normalizeDomain, normalizeMcpTool, type Environment, type InputValues } from './generate';

const mac: Environment = { os: 'macos', shells: ['bash'], scope: 'project', sandbox: 'off' };
const win: Environment = { os: 'windows', shells: ['bash', 'powershell'], scope: 'project', sandbox: 'off' };

const run = (ids: string[], env: Environment = mac, inputs?: InputValues) =>
  generate({ env, selections: ids.map((id) => ({ id })), inputs });

describe('path rules', () => {
  it('writes .env rules with carve-outs directly after them', () => {
    const { settings } = run(['secrets.ssh-keys', 'secrets.env-files']);
    expect(settings.permissions.deny).toEqual([
      'Read(.env)',
      'Read(.env.*)',
      'Read(!.env.example)',
      'Read(!.env.sample)',
      'Read(!.env.template)',
      // A Read rule does not stop a shell command writing the file, so each path gets an Edit rule too.
      'Edit(.env)',
      'Edit(.env.*)',
      'Edit(!.env.example)',
      'Edit(!.env.sample)',
      'Edit(!.env.template)',
      'Read(~/.ssh/**)',
      'Edit(~/.ssh/**)',
    ]);
  });

  it('uses the exceptions the user gave', () => {
    const { settings } = run(['secrets.env-files'], mac, { envExceptions: ['.env.dist', 'nested/.env.x'] });
    expect(settings.permissions.deny).toEqual(['Read(.env)', 'Read(.env.*)', 'Read(!.env.dist)', 'Edit(.env)', 'Edit(.env.*)', 'Edit(!.env.dist)']);
  });

  it('picks OS-specific locations', () => {
    const posix = run(['secrets.cloud-credentials'], mac).settings.permissions.deny!;
    const windows = run(['secrets.cloud-credentials'], win).settings.permissions.deny!;
    expect(posix).toContain('Read(~/.config/gcloud/**)');
    expect(posix).not.toContain('Read(~/AppData/Roaming/gcloud/**)');
    expect(windows).toContain('Read(~/AppData/Roaming/gcloud/**)');
    expect(windows).toContain('Read(~/AppData/Roaming/GitHub CLI/hosts.yml)');
    expect(windows).not.toContain('Read(~/.config/gcloud/**)');
    expect(windows).toContain('Read(~/.aws/credentials)');
  });

  it('converts pasted paths', () => {
    const { settings, warnings } = run(['secrets.custom-paths'], win, {
      secretPaths: ['secrets/', '~/vault-export', 'C:\\keys\\prod.pem', '\\\\nas\\share'],
    });
    expect(settings.permissions.deny).toEqual([
      'Read(/secrets/**)',
      'Read(~/vault-export)',
      'Read(~/vault-export/**)',
      'Read(//c/keys/prod.pem)',
      'Read(//c/keys/prod.pem/**)',
      'Edit(/secrets/**)',
      'Edit(~/vault-export)',
      'Edit(~/vault-export/**)',
      'Edit(//c/keys/prod.pem)',
      'Edit(//c/keys/prod.pem/**)',
    ]);
    expect(warnings.some((w) => w.includes('network path'))).toBe(true);
  });

  it('writes edit rules for protected paths and anchors project paths per scope', () => {
    const inputs = { protectedPaths: ['db/migrations/'] };
    expect(run(['local.protected-paths'], mac, inputs).settings.permissions.deny).toEqual(['Edit(/db/migrations/**)']);
    const user = run(['local.protected-paths'], { ...mac, scope: 'user' }, inputs);
    expect(user.settings.permissions.deny).toEqual(['Edit(db/migrations/**)']);
    expect(user.warnings.some((w) => w.includes('relative'))).toBe(true);
  });

  it('never writes a project path as /x in user settings', () => {
    const { rules } = run(['local.self-protection'], { ...mac, scope: 'user' });
    expect(rules.map((r) => r.rule)).toContain('Edit(.claude/settings.json)');
    expect(rules.some((r) => /^(Read|Edit)\(\/[^/]/.test(r.rule))).toBe(false);
  });
});

describe('command rules', () => {
  it('writes only the selected shells', () => {
    const bashOnly = run(['local.disk'], mac).rules.map((r) => r.rule);
    expect(bashOnly).toContain('Bash(mkfs*)');
    expect(bashOnly.some((r) => r.startsWith('PowerShell('))).toBe(false);
    const both = run(['local.disk'], win).rules.map((r) => r.rule);
    expect(both).toContain('Bash(mkfs*)');
    expect(both).toContain('PowerShell(Format-Volume *)');
  });

  it('writes shell-neutral programs such as git for every selected shell', () => {
    const ps = run(['remote.force-push'], { ...win, shells: ['powershell'] }).rules.map((r) => r.rule);
    expect(ps).toContain('PowerShell(git push --force *)');
    expect(ps.some((r) => r.startsWith('Bash('))).toBe(false);
    const both = run(['remote.force-push'], win).rules.map((r) => r.rule);
    expect(both).toContain('Bash(git push --force *)');
    expect(both).toContain('PowerShell(git push --force *)');
  });

  it('expands protected branches into one rule per branch', () => {
    const { settings } = run(['remote.protected-branches'], mac, { protectedBranches: ['main', 'release', 'bad name'] });
    const ask = settings.permissions.ask!;
    expect(ask).toContain('Bash(git push * main)');
    expect(ask).toContain('Bash(git push * *:release *)');
    expect(ask.some((r) => r.includes('{'))).toBe(false);
    expect(ask.some((r) => r.includes('bad name'))).toBe(false);
    expect(settings.permissions.deny).toBeUndefined();
  });

  it('applies conditions on boolean inputs', () => {
    const lease = 'Bash(git push --force-with-lease*)';
    expect(run(['remote.force-push']).settings.permissions.deny).not.toContain(lease);
    expect(run(['remote.force-push'], mac, { allowForceWithLease: false }).settings.permissions.deny).toContain(lease);
  });
});

describe('domain and MCP rules', () => {
  it('writes the host and its subdomains', () => {
    const { settings, warnings } = run(['remote.blocked-domains'], mac, {
      blockedDomains: ['https://Pastebin.com/raw/x', '*.transfer.sh', 'not a host'],
    });
    expect(settings.permissions.deny).toEqual([
      'WebFetch(domain:pastebin.com)',
      'WebFetch(domain:*.pastebin.com)',
      'WebFetch(domain:transfer.sh)',
      'WebFetch(domain:*.transfer.sh)',
    ]);
    expect(warnings.some((w) => w.includes('not a host'))).toBe(true);
  });

  it('normalizes domains', () => {
    expect(normalizeDomain('user@api.example.com:8443/path?q=1')).toBe('api.example.com');
    expect(normalizeDomain('example.com.')).toBe('example.com');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('exa mple.com')).toBeNull();
  });

  it('writes MCP tools and servers', () => {
    const { settings } = run(['remote.mcp-tools'], mac, {
      mcpTools: ['mcp__slack__send_message', 'gmail', 'my.server', 'mcp__x__y(arg)'],
    });
    expect(settings.permissions.ask).toEqual(['mcp__slack__send_message', 'mcp__gmail', 'mcp__my_server']);
  });

  it('rejects MCP names that would be skipped or widened', () => {
    expect(normalizeMcpTool('mcp__*')).toBeNull();
    expect(normalizeMcpTool('mcp__a__b(c:d)')).toBeNull();
    expect(normalizeMcpTool('  ')).toBeNull();
  });
});

describe('modes and merging', () => {
  it('honors a mode override', () => {
    const { settings } = generate({ env: mac, selections: [{ id: 'remote.publish', mode: 'deny' }] });
    expect(settings.permissions.deny).toContain('Bash(npm publish *)');
    expect(settings.permissions.ask).toBeUndefined();
  });

  it('keeps one copy of a shared rule, records both sources, and lets deny win', () => {
    const { rules } = generate({
      env: mac,
      selections: [{ id: 'local.self-protection', mode: 'ask' }, { id: 'remote.skip-hooks' }, { id: 'local.self-protection' }],
    });
    expect(new Set(rules.map((r) => r.rule)).size).toBe(rules.length);
    // Selecting the same item twice is ignored; the first selection's mode stands.
    expect(rules.find((r) => r.rule === 'Edit(/.claude/settings.json)')?.mode).toBe('ask');
  });

  it('skips an item whose required input is empty and says why', () => {
    const { settings, items, warnings } = run(['secrets.custom-paths']);
    expect(settings.permissions).toEqual({});
    expect(items[0]!.skipped).toContain('Your secret files and folders');
    expect(warnings.some((w) => w.includes('skipped'))).toBe(true);
  });

  it('warns about unknown ids', () => {
    expect(run(['nope.nothing']).warnings[0]).toContain('nope.nothing');
  });
});

describe('sandbox', () => {
  it('is omitted when off', () => {
    expect(run(['secrets.env-files']).settings.sandbox).toBeUndefined();
  });

  it('is enabled without repeating paths', () => {
    const { settings, items } = run(['secrets.env-files'], { ...mac, sandbox: 'on' });
    expect(settings.sandbox).toEqual({ enabled: true });
    expect(items[0]!.gaps.at(-1)).toContain('With the sandbox on');
  });

  it('adds the lock-down keys in strict mode', () => {
    expect(run(['secrets.env-files'], { ...mac, sandbox: 'strict' }).settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
  });

  it('is never written on native Windows, and the gap says so', () => {
    const { settings, items, warnings } = run(['secrets.env-files'], { ...win, sandbox: 'strict' });
    expect(settings.sandbox).toBeUndefined();
    expect(warnings.some((w) => w.includes('native Windows'))).toBe(true);
    expect(items[0]!.gaps.at(-1)).toContain('native Windows');
  });

  it('tells the user when the sandbox is simply off', () => {
    expect(run(['secrets.ssh-keys']).items[0]!.gaps.at(-1)).toContain('sandbox is off');
  });
});

describe('hook output', () => {
  it('is omitted when no selected item needs it', () => {
    const r = run(['remote.mcp-tools'], mac, { mcpTools: ['gmail'] });
    expect(r.hook).toBeUndefined();
    expect(r.settings.hooks).toBeUndefined();
  });

  it('is omitted when turned off, and each item says what the rules alone miss', () => {
    const off = run(['local.git-discard', 'secrets.ssh-keys', 'remote.mcp-tools'], { ...mac, hook: false }, { mcpTools: ['gmail'] });
    expect(off.hook).toBeUndefined();
    expect(off.settings.hooks).toBeUndefined();
    expect(off.warnings.some((w) => w.includes('hook'))).toBe(false);
    // The rules themselves are unchanged.
    const on = run(['local.git-discard', 'secrets.ssh-keys', 'remote.mcp-tools'], mac, { mcpTools: ['gmail'] });
    expect(off.settings.permissions).toEqual(on.settings.permissions);

    const [discard, ssh, mcp] = off.items;
    expect(discard!.hookOnly).toContain('git -C . reset --hard');
    expect(discard!.gaps[0]).toContain('`git -C . reset --hard`');
    expect(discard!.gaps[0]).toContain('The hook stops these');
    expect(ssh!.hookOnly).toEqual(['xxd $HOME/.ssh/id_ed25519']);
    // Nothing for the hook to add on an MCP rule, so no extra line.
    expect(mcp!.hookOnly).toEqual([]);
    expect(mcp!.gaps.some((g) => g.includes('The hook stops these'))).toBe(false);
    // With the hook on, the examples are still reported but not listed as gaps.
    expect(on.items[0]!.hookOnly).toEqual(discard!.hookOnly);
    expect(on.items[0]!.gaps.some((g) => g.includes('The hook stops these'))).toBe(false);
  });

  it('only gives hook examples for the shells in use', () => {
    const bash = run(['local.recursive-delete'], { ...mac, hook: false }).items[0]!;
    expect(bash.hookOnly.some((c) => c.startsWith('Remove-Item'))).toBe(false);
    const ps = run(['local.recursive-delete'], { os: 'windows', shells: ['powershell'], scope: 'project', sandbox: 'off', hook: false });
    expect(ps.items[0]!.hookOnly.every((c) => c.startsWith('Remove-Item'))).toBe(true);
    // PowerShell-only with no hook: this item has nothing left to emit, and says so.
    expect(ps.items[0]!.skipped).toContain('only through the hook');
    expect(ps.warnings.some((w) => w.includes('Recursive delete'))).toBe(true);
  });

  it('registers the script without a shell in project settings', () => {
    const r = run(['local.git-discard']);
    expect(r.settings.hooks).toEqual({
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell',
          hooks: [
            { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/deny-guard.cjs'], onFailure: 'block' },
          ],
        },
      ],
    });
    expect(r.hook).toMatchObject({ scriptPath: '.claude/hooks/deny-guard.cjs', relativeTo: 'project' });
  });

  it('points at the home folder in user settings, through PowerShell when there is no Bash', () => {
    const user = run(['local.git-discard'], { ...mac, scope: 'user' });
    expect(user.settings.hooks!.PreToolUse[0]!.hooks[0]).toEqual({
      type: 'command',
      command: 'node "$HOME/.claude/hooks/deny-guard.cjs"',
      onFailure: 'block',
    });
    expect(user.hook!.relativeTo).toBe('home');
    const ps = run(['local.git-discard'], { os: 'windows', shells: ['powershell'], scope: 'user', sandbox: 'off' });
    expect(ps.settings.hooks!.PreToolUse[0]!.hooks[0]!.shell).toBe('powershell');
  });

  it('can leave out onFailure for older Claude Code versions', () => {
    const r = run(['local.git-discard'], { ...mac, hookFailClosed: false });
    expect(r.settings.hooks!.PreToolUse[0]!.hooks[0]).not.toHaveProperty('onFailure');
    expect(r.warnings.some((w) => w.includes('will not block if it crashes'))).toBe(true);
  });

  it('resolves inputs and conditions into the rules file', () => {
    const r = run(['secrets.env-files', 'remote.force-push', 'remote.protected-branches', 'remote.blocked-domains'], mac, {
      envExceptions: ['.env.example'],
      allowForceWithLease: false,
      protectedBranches: ['main'],
      blockedDomains: ['Pastebin.com'],
    });
    const rules = r.hook!.rules;
    expect(rules.protectedBranches).toEqual(['main']);
    const env = rules.items.find((i) => i.id === 'secrets.env-files')!;
    expect(env.checks[0]).toMatchObject({ type: 'touchesPath', except: ['.env.example'], paths: [{ anchor: 'anywhere', glob: '.env' }, { anchor: 'anywhere', glob: '.env.*' }] });
    const force = rules.items.find((i) => i.id === 'remote.force-push')!;
    expect(force.patterns.bash).toContain('git push --force-with-lease*');
    expect(force.patterns.powershell).toContain('git push --force *');
    expect(force.checks.filter((c) => c.type === 'argv')).toHaveLength(2);
    const branches = rules.items.find((i) => i.id === 'remote.protected-branches')!;
    expect(branches.mode).toBe('ask');
    expect(branches.patterns.bash).toContain('git push * main');
    // blockCommitsOnProtected defaults to false, so that builtin is left out.
    expect(branches.checks.map((c) => (c.type === 'builtin' ? c.name : c.type))).toEqual(['git-push-protected-branch']);
    expect(rules.items.find((i) => i.id === 'remote.blocked-domains')!.checks[0]).toMatchObject({ domains: ['pastebin.com'] });
    expect(JSON.parse(JSON.stringify(rules))).toEqual(rules);
  });
});

describe('whole catalog', () => {
  const sample: InputValues = Object.assign({}, ...catalog.map((i) => i.sampleInputs ?? {}));
  const envs: Environment[] = [
    mac,
    win,
    { os: 'linux', shells: ['bash'], scope: 'user', sandbox: 'strict' },
    { os: 'windows', shells: ['powershell'], scope: 'user', sandbox: 'on' },
  ];

  it.each(envs)('generates well-formed rules for $os / $scope', (env) => {
    const result = run(catalog.map((i) => i.id), env, sample);
    const all = [...(result.settings.permissions.deny ?? []), ...(result.settings.permissions.ask ?? [])];
    // PowerShell-only setups get far fewer command rules than Bash ones.
    expect(all.length).toBeGreaterThan(50);
    expect(new Set(all).size).toBe(all.length);
    for (const rule of all) {
      expect(rule).toMatch(/^(?:(?:Read|Edit|Bash|PowerShell)\(.+\)|WebFetch\(domain:.+\)|mcp__[\w-]+)$/);
      expect(rule, 'unexpanded template').not.toMatch(/\{\w+\}/);
      // The primary content field cannot be matched as a parameter; Claude Code ignores such rules.
      expect(rule).not.toMatch(/^\w+\((command|file_path|path|url):/);
    }
    // Recursive delete has only Bash-form rules; on PowerShell it writes none and relies on the hook.
    expect(result.items.filter((i) => i.skipped).map((i) => i.id)).toEqual([]);
    const del = result.items.find((i) => i.id === 'local.recursive-delete')!;
    expect(del.rules > 0).toBe(env.shells.includes('bash'));
    expect(result.hook!.rules.items.some((i) => i.id === 'local.recursive-delete')).toBe(true);
    expect(result.items).toHaveLength(catalog.length);
    expect(JSON.parse(JSON.stringify(result.settings))).toEqual(result.settings);
  });
});
