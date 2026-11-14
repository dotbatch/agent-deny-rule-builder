import { catalog as defaultCatalog, inputs as defaultInputs } from '../catalog';
import type { CatalogItem, Condition, InputDef, Mode, PathRule, PathSpec } from '../catalog/schema';
import { parseUserPath, permissionPath, type ResolvedPath, type Scope } from './paths';

export type Os = 'windows' | 'macos' | 'linux' | 'wsl';
export type Shell = 'bash' | 'powershell';

export interface Environment {
  os: Os;
  /** Which shell tools Claude has in this setup. Rules are written for each. */
  shells: Shell[];
  scope: Scope;
  /** `strict` also refuses to start without the sandbox and forbids unsandboxed retries. */
  sandbox: 'off' | 'on' | 'strict';
  /**
   * Also emit the PreToolUse hook and its rules file. Defaults to true here;
   * the page starts with it off, since rules alone are the simpler install.
   */
  hook?: boolean;
  /**
   * Write `"onFailure": "block"` on the hook so a crash or timeout blocks the
   * call. Defaults to true. Turn off for Claude Code older than v2.1.295.
   */
  hookFailClosed?: boolean;
}

export interface Selection {
  id: string;
  /** Overrides the item's default. */
  mode?: Mode;
}

export type InputValues = Record<string, string[] | boolean>;

export interface GenerateInput {
  env: Environment;
  selections: Selection[];
  inputs?: InputValues;
}

export interface GeneratedRule {
  rule: string;
  mode: Mode;
  /** Ids of the catalog items that produced this rule. */
  items: string[];
}

export interface ItemReport {
  id: string;
  title: string;
  mode: Mode;
  /** Number of permission rules this item contributed. */
  rules: number;
  /** Set when the item produced nothing, with the reason. */
  skipped?: string;
  /** What still gets through, including the sandbox situation for this environment. */
  gaps: string[];
  /**
   * Commands from the item's test cases that only the hook stops, for the
   * shells in use. Empty when the hook would add nothing for this item.
   */
  hookOnly: string[];
  note?: string;
}

export interface SandboxSettings {
  enabled: true;
  failIfUnavailable?: true;
  allowUnsandboxedCommands?: false;
}

/** A hook check with its inputs and conditions already resolved; read by deny-guard.cjs. */
export type ResolvedCheck =
  | { type: 'argv'; program: string[]; sub?: string[]; flagsAny?: string[]; flagsNone?: string[]; message: string }
  | { type: 'regex'; pattern: string; flags?: string; program?: string[]; message: string }
  | { type: 'touchesPath'; access: 'read' | 'write'; paths: ResolvedPath[]; except: string[]; message: string }
  | { type: 'mentionsDomain'; domains: string[]; message: string }
  | { type: 'builtin'; name: string; message: string };

/** Contents of `deny-guard.rules.json`. */
export interface HookRules {
  version: 1;
  protectedBranches: string[];
  items: {
    id: string;
    title: string;
    mode: Mode;
    /** Command patterns re-applied to each normalized command. `any` patterns are folded into both lists. */
    patterns: { bash: string[]; powershell: string[] };
    checks: ResolvedCheck[];
  }[];
}

export interface HookHandler {
  type: 'command';
  command: string;
  args?: string[];
  shell?: 'powershell';
  /** Block the call if the hook crashes or times out. Needs Claude Code v2.1.295 or later. */
  onFailure?: 'block';
}

export interface HookOutput {
  rules: HookRules;
  /** Where to save the script and its rules file, relative to the project root or to the home folder. */
  scriptPath: string;
  rulesPath: string;
  relativeTo: 'project' | 'home';
}

export interface SettingsFragment {
  permissions: { deny?: string[]; ask?: string[] };
  hooks?: { PreToolUse: { matcher: string; hooks: HookHandler[] }[] };
  sandbox?: SandboxSettings;
}

export interface GenerateResult {
  /** Ready to merge into the settings file for `env.scope`. */
  settings: SettingsFragment;
  /** Every rule in output order, with where it came from. */
  rules: GeneratedRule[];
  /** Present when any selected item has something for the hook to check. */
  hook?: HookOutput;
  items: ItemReport[];
  warnings: string[];
}

export interface GenerateOptions {
  catalog?: CatalogItem[];
  inputDefs?: InputDef[];
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `https://Pastebin.com:443/raw/x` -> `pastebin.com`. Returns null if what is left is not a hostname. */
export function normalizeDomain(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/\.$/, '');
  return HOSTNAME.test(host) ? host : null;
}

/** A full `mcp__server__tool` name is kept; anything else is read as a server name. */
export function normalizeMcpTool(raw: string): string | null {
  const s = raw.trim();
  // Settings files skip any mcp__ rule with parentheses, and a * would widen the match.
  if (!s || /[()*]/.test(s)) return null;
  if (s.startsWith('mcp__')) return /^mcp__[\w-]+$/.test(s) ? s : null;
  // Claude Code replaces characters such as "." and spaces with "_" in server names.
  const server = s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${server}`;
}

interface Emitted {
  rule: string;
  /** Rules with `!` carve-outs go first so the carve-outs sit right after what they carve from. */
  early: boolean;
}

export function generate(input: GenerateInput, options: GenerateOptions = {}): GenerateResult {
  const catalog = options.catalog ?? defaultCatalog;
  const inputDefs = new Map((options.inputDefs ?? defaultInputs).map((d) => [d.id, d]));
  const { env } = input;
  const values = input.inputs ?? {};
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  const list = (id: string): string[] => {
    const v = values[id] ?? inputDefs.get(id)?.default;
    return Array.isArray(v) ? v.map((x) => x.trim()).filter(Boolean) : [];
  };
  const flag = (id: string): boolean => {
    const v = values[id] ?? inputDefs.get(id)?.default;
    return v === true;
  };
  const holds = (c?: Condition) => !c || flag(c.input) === c.equals;

  const hookEnabled = env.hook !== false;
  const sandboxAvailable = env.os !== 'windows';
  const sandboxOn = env.sandbox !== 'off' && sandboxAvailable;
  if (env.sandbox !== 'off' && !sandboxAvailable) {
    warn(
      'The sandbox is not available on native Windows, so no sandbox settings were written. Run Claude Code in WSL2 to get it.',
    );
  }

  const resolveSpecs = (specs: PathSpec[]): ResolvedPath[] =>
    specs.flatMap((spec) => {
      if ('input' in spec) {
        return list(spec.input).flatMap((raw) => {
          const parsed = parseUserPath(raw);
          if (parsed.warning) warn(parsed.warning);
          if (env.scope === 'user' && parsed.paths.some((p) => p.anchor === 'project')) {
            warn(
              `"${raw}" is relative. In user settings it applies relative to whichever folder a session starts in, in every project.`,
            );
          }
          return parsed.paths;
        });
      }
      if (spec.os === 'windows' && env.os !== 'windows') return [];
      if (spec.os === 'posix' && env.os === 'windows') return [];
      return [{ anchor: spec.anchor, glob: spec.glob }];
    });

  const pathRule = (rule: PathRule): Emitted[] => {
    // A Read rule stops the Read, Edit and Write tools, but not a shell command
    // writing the file (`echo x > .env`): live runs show only an Edit rule stops
    // that. So a `read` path gets both, and the file can be neither read nor destroyed.
    const tools = rule.access === 'read' ? ['Read', 'Edit'] : ['Edit'];
    const specs = resolveSpecs(rule.paths);
    const excepts: string[] = [];
    if (rule.exceptInput && specs.length > 0) {
      for (const name of list(rule.exceptInput)) {
        if (/[\\/]/.test(name) || name.startsWith('!')) {
          warn(`Exception "${name}" must be a bare file name. Skipped.`);
          continue;
        }
        excepts.push(name);
      }
    }
    // Each tool's block keeps its carve-outs right after its own paths.
    const out: Emitted[] = [];
    for (const tool of tools) {
      for (const p of specs) out.push({ rule: `${tool}(${permissionPath(p, env.scope)})`, early: !!rule.exceptInput });
      for (const name of excepts) out.push({ rule: `${tool}(!${name})`, early: true });
    }
    return out;
  };

  /** Expands `{inputId}` to one pattern per value. */
  const expand = (pattern: string): string[] => {
    const m = /\{(\w+)\}/.exec(pattern);
    if (!m) return [pattern];
    return list(m[1]!).flatMap((value) => {
      if (/[\s*()]/.test(value)) {
        warn(`"${value}" contains a space, * or parenthesis and cannot be used in a command rule. Skipped.`);
        return [];
      }
      return expand(pattern.replace(m[0], value));
    });
  };

  const emitItem = (item: CatalogItem): Emitted[] =>
    item.rules.flatMap((rule): Emitted[] => {
      switch (rule.kind) {
        case 'path':
          return pathRule(rule);
        case 'command': {
          if (!holds(rule.when)) return [];
          const out: Emitted[] = [];
          const tools = [
            ['bash', 'Bash'],
            ['powershell', 'PowerShell'],
          ] as const;
          for (const [shell, tool] of tools) {
            if (!env.shells.includes(shell)) continue;
            for (const p of [...(rule.any ?? []), ...(rule[shell] ?? [])].flatMap(expand)) {
              out.push({ rule: `${tool}(${p})`, early: false });
            }
          }
          return out;
        }
        case 'domain':
          return list(rule.input).flatMap((raw) => {
            const host = normalizeDomain(raw);
            if (!host) {
              warn(`"${raw}" is not a hostname. Skipped.`);
              return [];
            }
            return [
              { rule: `WebFetch(domain:${host})`, early: false },
              { rule: `WebFetch(domain:*.${host})`, early: false },
            ];
          });
        case 'mcp':
          return list(rule.input).flatMap((raw) => {
            const name = normalizeMcpTool(raw);
            if (!name) {
              warn(`"${raw}" is not an MCP tool or server name. Skipped.`);
              return [];
            }
            return [{ rule: name, early: false }];
          });
      }
    });

  const hookItem = (item: CatalogItem, mode: Mode): HookRules['items'][number] | null => {
    const patterns = { bash: [] as string[], powershell: [] as string[] };
    for (const rule of item.rules) {
      if (rule.kind !== 'command' || !holds(rule.when)) continue;
      patterns.bash.push(...[...(rule.any ?? []), ...(rule.bash ?? [])].flatMap(expand));
      patterns.powershell.push(...[...(rule.any ?? []), ...(rule.powershell ?? [])].flatMap(expand));
    }
    const checks: ResolvedCheck[] = [];
    for (const check of item.hook ?? []) {
      if (!holds(check.when)) continue;
      const { message } = check;
      switch (check.type) {
        case 'argv':
          checks.push({
            type: 'argv',
            program: Array.isArray(check.program) ? check.program : [check.program],
            sub: check.sub,
            flagsAny: check.flagsAny,
            flagsNone: check.flagsNone,
            message,
          });
          break;
        case 'regex':
          checks.push({ type: 'regex', pattern: check.pattern, flags: check.flags, program: check.program, message });
          break;
        case 'touchesPath': {
          const paths = resolveSpecs(check.paths);
          const except = check.exceptInput ? list(check.exceptInput).filter((n) => !/[\\/]/.test(n)) : [];
          if (paths.length > 0) checks.push({ type: 'touchesPath', access: check.access, paths, except, message });
          break;
        }
        case 'mentionsDomain': {
          const domains = list(check.input).map(normalizeDomain).filter((d): d is string => !!d);
          if (domains.length > 0) checks.push({ type: 'mentionsDomain', domains, message });
          break;
        }
        case 'builtin':
          checks.push({ type: 'builtin', name: check.name, message });
          break;
      }
    }
    if (patterns.bash.length + patterns.powershell.length + checks.length === 0) return null;
    return { id: item.id, title: item.title, mode, patterns, checks };
  };

  const byRule = new Map<string, GeneratedRule & { early: boolean }>();
  const items: ItemReport[] = [];
  const hookItems: HookRules['items'] = [];
  const seen = new Set<string>();

  for (const sel of input.selections) {
    if (seen.has(sel.id)) continue;
    seen.add(sel.id);
    const item = catalog.find((i) => i.id === sel.id);
    if (!item) {
      warn(`Unknown item "${sel.id}". Skipped.`);
      continue;
    }
    const mode = sel.mode ?? item.defaultMode;

    const missing = (item.inputs ?? [])
      .map((id) => inputDefs.get(id))
      .filter((d): d is InputDef => !!d && !!d.required && d.kind !== 'boolean' && list(d.id).length === 0);

    const emitted = missing.length > 0 ? [] : emitItem(item);
    const hookable = missing.length > 0 ? null : hookItem(item, mode);
    const forHook = hookEnabled ? hookable : null;
    if (forHook) hookItems.push(forHook);
    const hookOnly = hookable
      ? item.tests
          .filter((t) => t.expect === 'block' && t.by === 'hook')
          .filter((t) => env.shells.includes(t.tool === 'PowerShell' ? 'powershell' : 'bash'))
          .map((t) => t.input)
      : [];
    for (const e of emitted) {
      const existing = byRule.get(e.rule);
      if (existing) {
        if (!existing.items.includes(item.id)) existing.items.push(item.id);
        if (mode === 'deny') existing.mode = 'deny';
        existing.early ||= e.early;
      } else {
        byRule.set(e.rule, { rule: e.rule, mode, items: [item.id], early: e.early });
      }
    }

    const gaps = [...item.gaps];
    if (item.sandboxExtends) {
      if (sandboxOn) {
        gaps.push('With the sandbox on, shell commands and the programs they start are held to this too. Hooks and MCP servers are not.');
      } else if (!sandboxAvailable) {
        gaps.push('The sandbox is not available on native Windows, so programs started by a command are not held to this.');
      } else {
        gaps.push('The sandbox is off, so programs started by a command are not held to this. Turn it on to close that.');
      }
    }

    let skipped: string | undefined;
    if (missing.length > 0) {
      skipped = `Needs: ${missing.map((d) => d.label).join(', ')}.`;
      warn(`"${item.title}" was skipped. ${skipped}`);
    } else if (emitted.length === 0 && !forHook) {
      skipped = hookable ? 'In this setup it works only through the hook, which is off.' : 'Nothing applies to this environment.';
      if (hookable) warn(`"${item.title}" was skipped. ${skipped}`);
    }
    if (!hookEnabled && hookOnly.length > 0) {
      const examples = hookOnly.slice(0, 2).map((c) => `\`${c}\``).join(' or ');
      gaps.unshift(`Without the hook, some ways of doing this get past the rules, for example ${examples}. The hook stops these.`);
    }

    items.push({ id: item.id, title: item.title, mode, rules: new Set(emitted.map((e) => e.rule)).size, skipped, gaps, hookOnly, note: item.note });
  }

  // Stable: carve-out groups first, then everything else, each in selection order.
  const ordered = [...byRule.values()].sort((a, b) => Number(b.early) - Number(a.early));
  const rules: GeneratedRule[] = ordered.map(({ rule, mode, items: from }) => ({ rule, mode, items: from }));

  const settings: SettingsFragment = { permissions: {} };
  const deny = rules.filter((r) => r.mode === 'deny').map((r) => r.rule);
  const ask = rules.filter((r) => r.mode === 'ask').map((r) => r.rule);
  if (deny.length > 0) settings.permissions.deny = deny;
  if (ask.length > 0) settings.permissions.ask = ask;

  let hook: HookOutput | undefined;
  if (hookItems.length > 0) {
    const dir = '.claude/hooks';
    hook = {
      rules: { version: 1, protectedBranches: list('protectedBranches'), items: hookItems },
      scriptPath: `${dir}/deny-guard.cjs`,
      rulesPath: `${dir}/deny-guard.rules.json`,
      relativeTo: env.scope === 'project' ? 'project' : 'home',
    };
    const failClosed = env.hookFailClosed !== false;
    let handler: HookHandler;
    if (env.scope === 'project') {
      // Exec form: no shell involved, and Claude Code fills in the project folder.
      handler = { type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${hook.scriptPath}`] };
    } else {
      // Exec form does not expand a home folder, so use shell form. `$HOME` works in sh and in PowerShell.
      handler = { type: 'command', command: `node "$HOME/${hook.scriptPath}"` };
      if (env.os === 'windows' && !env.shells.includes('bash')) handler.shell = 'powershell';
    }
    if (failClosed) {
      handler.onFailure = 'block';
      warn('The hook is set to block if it fails, which needs Claude Code v2.1.295 or later. On older versions a crashed hook lets the command through.');
    } else {
      warn('The hook will not block if it crashes or times out. Update Claude Code to v2.1.295 or later and turn fail-closed back on.');
    }
    settings.hooks = { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [handler] }] };
    warn('The hook needs Node.js on your PATH.');
  }

  if (sandboxOn) {
    // Read/Edit deny rules and WebFetch domain rules are merged into the
    // sandbox by Claude Code, so paths and hosts are not repeated here.
    settings.sandbox = { enabled: true };
    if (env.sandbox === 'strict') {
      settings.sandbox.failIfUnavailable = true;
      settings.sandbox.allowUnsandboxedCommands = false;
    }
    if (ask.some((r) => r.startsWith('Read(') || r.startsWith('Edit(') || r.startsWith('WebFetch('))) {
      warn('Path and domain rules set to "ask" only prompt for Claude\'s own tools. The sandbox enforces deny rules, not ask rules.');
    }
  }

  if (env.shells.length === 0 && items.some((r) => catalog.find((i) => i.id === r.id)?.rules.some((x) => x.kind === 'command'))) {
    warn('No shell was selected, so no command rules were written.');
  }

  return { settings, rules, hook, items, warnings };
}
