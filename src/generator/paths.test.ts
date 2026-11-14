import { describe, expect, it } from 'vitest';
import { parseUserPath, permissionPath } from './paths';

const rules = (raw: string, scope: 'project' | 'user' = 'project') =>
  parseUserPath(raw).paths.map((p) => permissionPath(p, scope));

describe('parseUserPath + permissionPath', () => {
  it.each([
    // Windows absolute
    ['C:\\keys\\prod.pem', ['//c/keys/prod.pem', '//c/keys/prod.pem/**']],
    ['D:/Vault/', ['//d/Vault/**']],
    ['"C:\\Program Files\\App\\secrets\\"', ['//c/Program Files/App/secrets/**']],
    ['C:\\', ['//c/**']],
    // POSIX absolute
    ['/etc/app/secret.json', ['//etc/app/secret.json', '//etc/app/secret.json/**']],
    ['/var/secrets/', ['//var/secrets/**']],
    // Home
    ['~/vault-export', ['~/vault-export', '~/vault-export/**']],
    ['~\\vault\\', ['~/vault/**']],
    ['%USERPROFILE%\\keys', ['~/keys', '~/keys/**']],
    ['$HOME/keys/', ['~/keys/**']],
    ['$env:USERPROFILE\\keys\\', ['~/keys/**']],
    ['~', ['~/**']],
    // Project-relative
    ['secrets/', ['/secrets/**']],
    ['./config/production', ['/config/production', '/config/production/**']],
    ['package-lock.json', ['/package-lock.json', '/package-lock.json/**']],
    ['db\\migrations\\', ['/db/migrations/**']],
    // Wildcards pass through untouched
    ['certs/*.pem', ['/certs/*.pem']],
    ['~/keys/**', ['~/keys/**']],
  ])('%s', (raw, expected) => {
    expect(parseUserPath(raw).warning).toBeUndefined();
    expect(rules(raw)).toEqual(expected);
  });

  it('writes project-relative paths without a leading slash in user settings', () => {
    // `/secrets/**` in ~/.claude/settings.json would mean ~/.claude/secrets/**.
    expect(rules('secrets/', 'user')).toEqual(['secrets/**']);
    expect(rules('~/keys/', 'user')).toEqual(['~/keys/**']);
    expect(rules('C:\\keys\\', 'user')).toEqual(['//c/keys/**']);
  });

  it('skips network paths and parent traversal with a warning', () => {
    for (const raw of ['\\\\fileserver\\share\\keys', '//fileserver/share', '../other/secrets', 'a/../../b']) {
      const parsed = parseUserPath(raw);
      expect(parsed.paths, raw).toEqual([]);
      expect(parsed.warning, raw).toBeDefined();
    }
  });

  it('ignores blank entries', () => {
    expect(parseUserPath('   ')).toEqual({ paths: [] });
    expect(parseUserPath('""')).toEqual({ paths: [] });
  });

  it('keeps anywhere-anchored names bare and prefixes nested ones', () => {
    expect(permissionPath({ anchor: 'anywhere', glob: '.env.*' }, 'project')).toBe('.env.*');
    expect(permissionPath({ anchor: 'anywhere', glob: 'secrets/**' }, 'user')).toBe('**/secrets/**');
  });
});
