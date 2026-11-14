import type { PathAnchor } from '../catalog/schema';

/** Which settings file the rules will be pasted into. */
export type Scope = 'project' | 'user';

export interface ResolvedPath {
  anchor: PathAnchor;
  /** Forward slashes, no leading slash, no anchor prefix. */
  glob: string;
}

export interface ParsedUserPath {
  paths: ResolvedPath[];
  warning?: string;
}

const HOME_PREFIXES = [/^~(?=\/|$)/, /^\$HOME(?=\/|$)/, /^\$\{HOME\}(?=\/|$)/, /^%USERPROFILE%(?=\/|$)/i, /^\$env:USERPROFILE(?=\/|$)/i];

/**
 * Turns a path as a person would paste it into anchored globs.
 *
 * - `C:\keys\prod.pem`      -> absolute `c/keys/prod.pem`
 * - `/etc/app/secret`       -> absolute `etc/app/secret`
 * - `~/vault`, `%USERPROFILE%\vault`, `$HOME/vault` -> home `vault`
 * - `secrets/`, `./secrets` -> project `secrets`
 *
 * A trailing slash means a folder, so only its contents are matched. With no
 * trailing slash and no wildcard we cannot tell a file from a folder, so both
 * the path itself and everything under it are returned.
 */
export function parseUserPath(raw: string): ParsedUserPath {
  let s = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!s) return { paths: [] };

  if (/^\\\\/.test(s) || /^\/\/[^/]/.test(s)) {
    return { paths: [], warning: `"${raw}" is a network path, which these rules cannot express. Skipped.` };
  }

  const isDir = /[\\/]$/.test(s);
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');

  let anchor: PathAnchor;
  let rest: string;

  const home = HOME_PREFIXES.find((re) => re.test(s));
  const drive = /^([a-zA-Z]):(?=\/|$)/.exec(s);
  if (home) {
    anchor = 'home';
    rest = s.replace(home, '');
  } else if (drive) {
    anchor = 'absolute';
    // Claude Code normalizes C:\x to /c/x before matching.
    rest = drive[1]!.toLowerCase() + s.slice(2);
  } else if (s.startsWith('/') || s === '') {
    anchor = 'absolute';
    rest = s;
  } else {
    anchor = 'project';
    rest = s.replace(/^(\.\/)+/, '');
    if (rest === '.') rest = '';
  }
  rest = rest.replace(/^\/+/, '').replace(/\/{2,}/g, '/');

  if (rest.split('/').includes('..')) {
    return { paths: [], warning: `"${raw}" contains "..". Give the full path instead. Skipped.` };
  }

  if (rest === '') return { paths: [{ anchor, glob: '**' }] };
  if (/[*?[]/.test(rest)) return { paths: [{ anchor, glob: rest }] };
  if (isDir) return { paths: [{ anchor, glob: `${rest}/**` }] };
  return {
    paths: [
      { anchor, glob: rest },
      { anchor, glob: `${rest}/**` },
    ],
  };
}

/**
 * Writes the specifier for a `Read(...)` or `Edit(...)` permission rule.
 *
 * Permission rules use `//` for absolute, `~/` for home, `/` for "relative to
 * the settings file's anchor" and no prefix for "relative to the current
 * directory". In user settings `/x` would mean `~/.claude/x`, so project
 * paths fall back to the current-directory form there.
 */
export function permissionPath(p: ResolvedPath, scope: Scope): string {
  switch (p.anchor) {
    case 'absolute':
      return `//${p.glob}`;
    case 'home':
      return `~/${p.glob}`;
    case 'project':
      return scope === 'project' ? `/${p.glob}` : p.glob;
    case 'anywhere':
      // A bare name already matches at any depth (gitignore semantics), and
      // staying in that form keeps `!name` carve-outs applicable.
      return p.glob.includes('/') ? `**/${p.glob}` : p.glob;
  }
}
