import type { Mode } from '../catalog/schema';
import type { GeneratedRule, HookRules } from '../generator/generate';
import type { Scope } from '../generator/paths';

/**
 * Predicts what a set of generated rules does to one tool call.
 *
 * The permission-rule half follows the behaviour Claude Code documents; it is
 * not Claude Code's own matcher, so treat a result as a strong hint, not
 * proof. The hook half runs the real hook script's logic.
 */

// ------------------------------------------------------------------ guard

interface ParsedCommand {
  raw: string;
  words: { v: string; q: boolean }[];
  redirects: { op: string; target: string }[];
}

export interface HookHit {
  id: string;
  title: string;
  mode: Mode;
  reason: string;
  command: string;
}

/** The parts of deny-guard.cjs the simulator reuses. */
export interface GuardApi {
  evaluate(input: unknown, rules: HookRules, ctx: unknown): { decision: 'allow' | 'ask' | 'deny'; hits: HookHit[] };
  parseCommands(text: string, ps: boolean): { commands: ParsedCommand[]; subs: string[] };
  matchPattern(pattern: string, text: string, caseInsensitive: boolean): boolean;
  globToRegExp(glob: string, win: boolean): RegExp;
  resolvePath(written: string, cwd: string | null, ctx: { home: string; win: boolean }): string | null;
  normPath(path: string, win: boolean): string;
  positionals(args: { v: string; q: boolean }[]): string[];
  PS_ALIASES: Record<string, string>;
}

/**
 * Evaluates the hook script from its source text. The page ships the script
 * as text for download, and running that same text here means the tester
 * exercises exactly the file the user installs.
 */
export function loadGuard(source: string): GuardApi {
  const module = { exports: {} as GuardApi };
  const require = Object.assign(
    () => {
      throw new Error('Node modules are not available here');
    },
    { main: undefined },
  );
  new Function('module', 'exports', 'require', '__dirname', source.replace(/^#!.*/, ''))(module, module.exports, require, '');
  return module.exports;
}

// ------------------------------------------------------------------ types

export type Call =
  | { tool: 'Bash' | 'PowerShell'; input: string }
  | { tool: 'Read' | 'Edit'; input: string }
  | { tool: 'WebFetch'; input: string }
  | { tool: 'Mcp'; input: string };

export interface SimContext {
  win: boolean;
  /** Native paths, e.g. `C:\Users\you` or `/home/you`. */
  home: string;
  projectDir: string;
  /** Defaults to the project folder. */
  cwd?: string;
  tmpDirs?: string[];
  /** What `git rev-parse --abbrev-ref HEAD` would print; used by the hook's branch checks. */
  currentBranch?: string | null;
  scope: Scope;
}

export interface RuleHit {
  rule: string;
  mode: Mode;
  items: string[];
  /** Why this rule applied, when it is not a direct match on the call. */
  via?: string;
}

export interface SimResult {
  ruleHits: RuleHit[];
  /** Hits from the hook rules passed in, whether or not the hook is installed. */
  hookHits: HookHit[];
  ruleDecision: 'allow' | 'ask' | 'deny';
  hookDecision: 'allow' | 'ask' | 'deny';
}

// ------------------------------------------------------------- rule shapes

type Parsed =
  | { kind: 'path'; tool: 'Read' | 'Edit'; spec: string }
  | { kind: 'command'; tool: 'Bash' | 'PowerShell'; pattern: string }
  | { kind: 'domain'; host: string }
  | { kind: 'mcp'; name: string };

function parseRule(rule: string): Parsed | null {
  if (rule.startsWith('mcp__')) return { kind: 'mcp', name: rule };
  const m = /^(\w+)\((.*)\)$/s.exec(rule);
  if (!m) return null;
  const [, tool, body] = m as unknown as [string, string, string];
  if (tool === 'Read' || tool === 'Edit') return { kind: 'path', tool, spec: body };
  if (tool === 'Bash' || tool === 'PowerShell') return { kind: 'command', tool, pattern: body };
  if (tool === 'WebFetch' && body.startsWith('domain:')) return { kind: 'domain', host: body.slice(7).trim() };
  return null;
}

const strongest = (hits: { mode: Mode }[]): 'allow' | 'ask' | 'deny' =>
  hits.some((h) => h.mode === 'deny') ? 'deny' : hits.length > 0 ? 'ask' : 'allow';

// ------------------------------------------------------------------ paths

interface Paths {
  win: boolean;
  home: string;
  projectDir: string;
  cwd: string;
  scope: Scope;
}

/**
 * Does a Read/Edit specifier cover this absolute path?
 * Returns 'dir' when a whole folder is blocked (a `!` carve-out cannot reopen
 * files in it), 'file' for a match on the path itself, or null.
 */
function matchPathSpec(guard: GuardApi, spec: string, abs: string, p: Paths): 'file' | 'dir' | null {
  let base: string;
  let pattern: string;
  let relative = false;
  if (spec.startsWith('//')) {
    base = '';
    pattern = spec.slice(2);
  } else if (spec.startsWith('~/')) {
    base = p.home;
    pattern = spec.slice(2);
  } else if (spec.startsWith('/')) {
    // Anchored at the settings source: the project root, or ~/.claude for user settings.
    base = p.scope === 'project' ? p.projectDir : `${p.home}/.claude`;
    pattern = spec.slice(1);
  } else {
    base = p.cwd;
    pattern = spec.replace(/^\.\//, '');
    relative = true;
  }
  if (p.win) pattern = pattern.toLowerCase();
  if (base !== '' && abs !== base && !abs.startsWith(base + '/')) return null;
  const segs = abs.slice(base.length).split('/').filter(Boolean);
  if (segs.length === 0) return null;

  const prefixMatch = (re: RegExp): 'file' | 'dir' | null => {
    for (let k = 1; k <= segs.length; k++) {
      if (re.test(segs.slice(0, k).join('/'))) return k === segs.length ? 'file' : 'dir';
    }
    return null;
  };

  if (relative && !pattern.includes('/')) {
    // gitignore: a bare name matches a file or folder of that name at any depth.
    const re = guard.globToRegExp(pattern, p.win);
    const i = segs.findIndex((s) => re.test(s));
    return i < 0 ? null : i === segs.length - 1 ? 'file' : 'dir';
  }
  const single = /^([^/]+)\/\*\*$/.exec(pattern);
  if (relative && single) {
    // Deny and ask rules: `secrets/**` matches a folder of that name at any depth.
    const re = guard.globToRegExp(single[1]!, p.win);
    return segs.slice(0, -1).some((s) => re.test(s)) ? 'dir' : null;
  }
  const whole = pattern.endsWith('/**');
  const hit = prefixMatch(guard.globToRegExp(pattern, p.win));
  return hit && whole ? 'dir' : hit;
}

function pathHits(guard: GuardApi, abs: string, access: 'read' | 'edit', rules: GeneratedRule[], p: Paths, via?: string): RuleHit[] {
  const out: RuleHit[] = [];
  // A `!` carve-out only reaches rules in the same list, so walk each mode's list on its own.
  for (const mode of ['deny', 'ask'] as const) {
    for (const tool of ['Read', 'Edit'] as const) {
      // A Read rule also blocks Edit and Write on the path; an Edit rule only blocks edits.
      if (tool === 'Edit' && access === 'read') continue;
      const live: { hit: RuleHit; kind: 'file' | 'dir'; relative: boolean }[] = [];
      for (const r of rules) {
        if (r.mode !== mode) continue;
        const parsed = parseRule(r.rule);
        if (!parsed || parsed.kind !== 'path' || parsed.tool !== tool) continue;
        if (parsed.spec.startsWith('!')) {
          // Read relative to the current directory whatever follows the `!`.
          const carve = matchPathSpec(guard, parsed.spec.slice(1).replace(/^(\/\/|~\/|\/)/, ''), abs, p);
          if (carve) {
            for (let i = live.length - 1; i >= 0; i--) {
              if (live[i]!.relative && live[i]!.kind === 'file') live.splice(i, 1);
            }
          }
          continue;
        }
        const kind = matchPathSpec(guard, parsed.spec, abs, p);
        if (kind) {
          const relative = !/^(\/|~\/)/.test(parsed.spec);
          live.push({ hit: { rule: r.rule, mode: r.mode, items: r.items, via }, kind, relative });
        }
      }
      out.push(...live.map((l) => l.hit));
    }
  }
  return out;
}

// --------------------------------------------------------------- commands

/** Wrappers Claude Code strips before matching a Bash rule. */
const RULE_WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']);
const CONTROL_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
/** File commands Claude Code recognises in Bash and holds to Read and Edit rules. */
const FILE_READERS = new Set(['cat', 'head', 'tail', 'sed', 'tee']);

function allCommands(guard: GuardApi, text: string, ps: boolean, depth = 0): ParsedCommand[] {
  if (depth > 6) return [];
  const { commands, subs } = guard.parseCommands(text, ps);
  return [...commands, ...subs.flatMap((s) => allCommands(guard, s, ps, depth + 1))];
}

/** The words Claude Code matches a rule against, after its documented stripping. */
function ruleWords(cmd: ParsedCommand, ps: boolean): { v: string; q: boolean }[] {
  let words = cmd.words.slice();
  if (ps) return words;
  // Deny and ask rules apply inside control-flow bodies: `do cmd`, `then cmd`.
  while (words.length > 1 && !words[0]!.q && CONTROL_WORDS.has(words[0]!.v)) words = words.slice(1);
  // Deny and ask rules match past any leading VAR=value.
  while (words.length > 1 && !words[0]!.q && /^[A-Za-z_]\w*=/.test(words[0]!.v)) words = words.slice(1);
  for (let guardCount = 0; guardCount < 8 && words.length > 1; guardCount++) {
    const name = words[0]!.v;
    if (name === 'xargs') {
      // Only bare xargs is stripped; with flags it is matched as an xargs command.
      if (words[1]!.v.startsWith('-')) break;
      words = words.slice(1);
      continue;
    }
    if (!RULE_WRAPPERS.has(name)) break;
    if (name === 'command' && /^-[vV]$/.test(words[1]!.v)) break;
    let i = 1;
    while (i < words.length - 1 && words[i]!.v.startsWith('-')) i += /^-[nsk]$/.test(words[i]!.v) ? 2 : 1;
    if (name === 'timeout' && i < words.length - 1 && /^\d+(\.\d+)?[smhd]?$/.test(words[i]!.v)) i++;
    words = words.slice(i);
  }
  return words;
}

function commandHits(guard: GuardApi, call: { tool: 'Bash' | 'PowerShell'; input: string }, rules: GeneratedRule[], p: Paths): RuleHit[] {
  const ps = call.tool === 'PowerShell';
  const out = new Map<string, RuleHit>();
  const add = (hit: RuleHit) => {
    if (!out.has(hit.rule)) out.set(hit.rule, hit);
  };

  for (const cmd of allCommands(guard, call.input, ps)) {
    const words = ruleWords(cmd, ps);
    if (words.length > 0) {
      let program = words[0]!.v;
      if (ps) program = guard.PS_ALIASES[program.toLowerCase()] ?? program;
      const text = [program, ...words.slice(1).map((w) => w.v)].join(' ');
      for (const r of rules) {
        const parsed = parseRule(r.rule);
        if (parsed?.kind === 'command' && parsed.tool === call.tool && guard.matchPattern(parsed.pattern, text, ps)) {
          add({ rule: r.rule, mode: r.mode, items: r.items, via: text === call.input.trim() ? undefined : `matches the part \`${text}\`` });
        }
      }

      if (!ps && FILE_READERS.has(program)) {
        const writes = program === 'tee' || (program === 'sed' && words.some((w) => /^(-[a-zA-Z]*i|--in-place)/.test(w.v)));
        for (const arg of guard.positionals(words.slice(1))) {
          const abs = guard.resolvePath(arg, p.cwd, p);
          if (!abs) continue;
          for (const h of pathHits(guard, abs, writes ? 'edit' : 'read', rules, p, `\`${program}\` ${writes ? 'writes' : 'reads'} ${arg}`)) add(h);
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.op !== '>' && r.op !== '<') continue;
      const abs = guard.resolvePath(r.target, p.cwd, p);
      if (!abs) continue;
      const access = r.op === '>' ? 'edit' : 'read';
      for (const h of pathHits(guard, abs, access, rules, p, `the command redirects ${r.op === '>' ? 'into' : 'from'} ${r.target}`)) add(h);
    }
  }
  return [...out.values()];
}

// ------------------------------------------------------- domains and MCP

function domainMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  if (p === '*') return true;
  // A leading `*.` matches subdomains at any depth, but not the domain itself.
  if (p.startsWith('*.') && !p.slice(2).includes('*')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  // Anywhere else a wildcard matches only the text between two dots.
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*') + '$');
  return re.test(h);
}

export function hostOf(url: string): string | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/:?#\s]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

function mcpMatches(rule: string, tool: string): boolean {
  if (rule === tool) return true;
  // `mcp__server` and `mcp__server__*` both cover every tool on that server.
  const server = rule.endsWith('__*') ? rule.slice(0, -3) : rule;
  return tool.startsWith(server + '__');
}

// ---------------------------------------------------------------- simulate

export function simulate(call: Call, rules: GeneratedRule[], hookRules: HookRules | undefined, guard: GuardApi, ctx: SimContext): SimResult {
  const win = ctx.win;
  const toAbs = (native: string) => guard.resolvePath(native, null, { home: '', win }) ?? guard.normPath(native, win);
  const home = toAbs(ctx.home);
  const p: Paths = { win, home, projectDir: toAbs(ctx.projectDir), cwd: toAbs(ctx.cwd ?? ctx.projectDir), scope: ctx.scope };

  let ruleHits: RuleHit[] = [];
  let hookHits: HookHit[] = [];

  if (call.tool === 'Bash' || call.tool === 'PowerShell') {
    ruleHits = commandHits(guard, call, rules, p);
    if (hookRules) {
      hookHits = guard.evaluate({ tool_name: call.tool, tool_input: { command: call.input } }, hookRules, {
        win,
        cwd: ctx.cwd ?? ctx.projectDir,
        projectDir: ctx.projectDir,
        home: ctx.home,
        tmpDirs: ctx.tmpDirs ?? [],
        currentBranch: () => ctx.currentBranch ?? null,
      }).hits;
    }
  } else if (call.tool === 'Read' || call.tool === 'Edit') {
    const abs = guard.resolvePath(call.input.trim(), p.cwd, p);
    if (abs) ruleHits = pathHits(guard, abs, call.tool === 'Read' ? 'read' : 'edit', rules, p);
  } else if (call.tool === 'WebFetch') {
    const host = hostOf(call.input);
    if (host) {
      ruleHits = rules
        .filter((r) => {
          const parsed = parseRule(r.rule);
          return parsed?.kind === 'domain' && domainMatches(parsed.host, host);
        })
        .map((r) => ({ rule: r.rule, mode: r.mode, items: r.items }));
    }
  } else {
    const name = call.input.trim();
    ruleHits = rules
      .filter((r) => parseRule(r.rule)?.kind === 'mcp' && mcpMatches(r.rule, name))
      .map((r) => ({ rule: r.rule, mode: r.mode, items: r.items }));
  }

  return { ruleHits, hookHits, ruleDecision: strongest(ruleHits), hookDecision: strongest(hookHits) };
}

/**
 * Rewrites a typed absolute path under a typical home folder to `~/...`, so
 * the tester works without knowing the user's real name:
 * `C:\Users\alice\.ssh\id_rsa` and `/home/alice/.ssh/id_rsa` -> `~/.ssh/id_rsa`.
 */
export function assumeHome(text: string): string {
  return text.replace(/(?:[A-Za-z]:[\\/]Users|\/home|\/Users|\/[a-z]\/Users)[\\/][^\\/\s'"]+(?=[\\/]|$)/gi, '~');
}
