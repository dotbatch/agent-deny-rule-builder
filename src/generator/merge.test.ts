import { describe, expect, it } from 'vitest';
import type { SettingsFragment } from './generate';
import { detectKind, mergeSettings, parsePasted } from './merge';

const handler = { type: 'command' as const, command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/deny-guard.cjs'], onFailure: 'block' as const };
const ours: SettingsFragment = {
  permissions: { deny: ['Read(.env)', 'Read(!.env.example)', 'Bash(rm -rf *)'], ask: ['Bash(git push *)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [handler] }] },
  sandbox: { enabled: true },
};

const merge = (value: unknown, frag: SettingsFragment = ours) => {
  const r = mergeSettings(typeof value === 'string' ? value : JSON.stringify(value), frag);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('parsePasted', () => {
  it('accepts a bare "permissions" entry copied out of a file', () => {
    const r = parsePasted('"permissions": { "deny": ["Read(x)"] },');
    expect(r).toEqual({ ok: true, value: { permissions: { deny: ['Read(x)'] } } });
  });

  it('explains comments', () => {
    const r = parsePasted('{ // mine\n "a": 1 }');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/comments/);
  });

  it('rejects arrays and plain values', () => {
    expect(parsePasted('[1]').ok).toBe(false);
    expect(parsePasted('"x"').ok).toBe(false);
  });
});

describe('detectKind', () => {
  it('tells a permissions value from a whole file', () => {
    expect(detectKind({ deny: [], allow: [] })).toBe('permissions');
    expect(detectKind({ permissions: {}, model: 'opus' })).toBe('file');
    expect(detectKind({})).toBe('file');
  });
});

describe('mergeSettings', () => {
  it('keeps other keys untouched and in order', () => {
    const r = merge({ env: { API_KEY: 'sk-secret' }, model: 'opus', permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: 'x' } });
    expect(Object.keys(r.merged)).toEqual(['env', 'model', 'permissions', 'statusLine', 'hooks', 'sandbox']);
    expect(r.merged.env).toEqual({ API_KEY: 'sk-secret' });
    expect(r.merged.permissions).toEqual({ allow: ['Bash(ls)'], deny: ours.permissions.deny, ask: ours.permissions.ask });
  });

  it('skips rules and hooks that are already there', () => {
    const existing = {
      permissions: { deny: ['Bash(rm -rf *)', 'Read(~/.aws/**)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [handler] }] },
    };
    const r = merge(existing);
    expect(r.merged.permissions).toEqual({ deny: ['Bash(rm -rf *)', 'Read(~/.aws/**)', 'Read(.env)', 'Read(!.env.example)'], ask: ['Bash(git push *)'] });
    expect(r.merged.hooks).toEqual(existing.hooks);
    expect(r.added).toBe(3);
    expect(r.skipped).toBe(2);
  });

  it('gives the same file when run on its own output', () => {
    const once = merge({ model: 'opus', hooks: { PostToolUse: [] } });
    const twice = merge(once.merged);
    expect(twice.merged).toEqual(once.merged);
    expect(twice.added).toBe(0);
  });

  it('adds the hook to a matching group, or as a new group', () => {
    const other = { type: 'command', command: 'lint.sh' };
    const same = merge({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [other] }] } });
    expect(same.merged.hooks).toEqual({ PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [other, handler] }] });
    const diff = merge({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [other] }], Stop: [] } });
    expect(diff.merged.hooks).toEqual({ PreToolUse: [{ matcher: 'Edit', hooks: [other] }, { matcher: 'Bash|PowerShell', hooks: [handler] }], Stop: [] });
  });

  it('moves a rule from ask to deny instead of listing it twice', () => {
    const r = merge({ permissions: { ask: ['Bash(rm -rf *)', 'Bash(npm publish)'] } });
    expect(r.merged.permissions).toMatchObject({ ask: ['Bash(npm publish)', 'Bash(git push *)'] });
    expect(r.moved).toEqual(['Bash(rm -rf *)']);
  });

  it('leaves a rule blocked when ours would only ask', () => {
    const r = merge({ permissions: { deny: ['Bash(git push *)'] } });
    expect(r.merged.permissions).not.toHaveProperty('ask');
    expect(r.skipped).toBe(1);
  });

  it('warns about allow overlap, disabled hooks, a sandbox change and lifted rules', () => {
    const r = merge({
      disableAllHooks: true,
      permissions: { allow: ['Bash(rm -rf *)'], deny: ['Read(.env.example)'] },
      sandbox: { enabled: false, excludedCommands: ['docker'] },
    });
    expect(r.warnings.join('\n')).toMatch(/allow list/);
    expect(r.warnings.join('\n')).toMatch(/disableAllHooks/);
    expect(r.warnings.join('\n')).toMatch(/enabled \(was false\)/);
    expect(r.warnings.join('\n')).toMatch(/Read\(!\.env\.example\)/);
    expect(r.merged.sandbox).toEqual({ enabled: true, excludedCommands: ['docker'] });
  });

  it('merges a permissions section and says hooks still need a hand', () => {
    const r = merge('{ "allow": ["Bash(ls)"], "deny": ["Read(.env)"] }');
    expect(r.kind).toBe('permissions');
    expect(r.merged.permissions).toEqual({ allow: ['Bash(ls)'], deny: ['Read(.env)', 'Read(!.env.example)', 'Bash(rm -rf *)'], ask: ['Bash(git push *)'] });
    expect(r.merged.hooks).toEqual(ours.hooks);
    expect(r.warnings.join('\n')).toMatch(/only the permissions section/);
  });

  it('refuses a section that is not an object', () => {
    const r = mergeSettings('{ "permissions": [] }', ours);
    expect(r.ok).toBe(false);
  });
});
