/**
 * Catalog schema.
 *
 * A catalog item describes one thing a user can choose to protect against.
 * It is pure data: the generator (phase 3) turns `rules` into permission
 * rules, the hook (phase 4) interprets `hook` checks, and the `tests` are run
 * against both so every item ships with proof of what it catches.
 */

export type Category = 'secrets' | 'local' | 'remote' | 'infra';

/** critical: unrecoverable and broad. high: unrecoverable. medium: costly to undo. */
export type Severity = 'critical' | 'high' | 'medium';

/** deny blocks outright; ask forces a prompt even in auto mode. */
export type Mode = 'deny' | 'ask';

// ---------------------------------------------------------------- inputs

export type InputKind =
  /** Files or folders, typed as Windows or POSIX paths, absolute, ~/ or project-relative. */
  | 'path-list'
  /** Bare file names matched at any depth, e.g. `.env.example`. */
  | 'filename-list'
  /** Free strings such as branch names. */
  | 'string-list'
  /** Hostnames without scheme or path. */
  | 'domain-list'
  /** `mcp__server__tool` names, or a bare server name meaning every tool on it. */
  | 'mcp-tool-list'
  | 'boolean';

export interface InputDef {
  id: string;
  kind: InputKind;
  label: string;
  help: string;
  placeholder?: string;
  /** Lists default to empty and booleans to false when omitted. */
  default?: string[] | boolean;
  /** A required list input must be non-empty for the item to emit anything. */
  required?: boolean;
}

// ----------------------------------------------------------------- paths

/**
 * Where a glob is anchored. The generator writes two syntaxes from this:
 * permission rules (`//abs`, `~/home`, `/project`, `relative`) and sandbox
 * paths (`/abs`, `~/home`, `./relative`).
 *
 * - `anywhere`: any depth under the current directory, e.g. `**\/.env`
 * - `project`:  fixed location under the project root
 * - `home`:     under the user's home directory
 * - `absolute`: from the filesystem root
 */
export type PathAnchor = 'anywhere' | 'project' | 'home' | 'absolute';

export type PathSpec =
  | {
      anchor: PathAnchor;
      /** gitignore-style glob, forward slashes, no leading slash. */
      glob: string;
      /** Emit only for this OS family. Omit for both. */
      os?: 'windows' | 'posix';
    }
  /** Paths the user typed; the generator classifies each one's anchor. */
  | { input: string };

// ----------------------------------------------------------------- rules

/** Emit this rule only when a boolean input has the given value. */
export interface Condition {
  input: string;
  equals: boolean;
}

/**
 * Blocks file access through `Read(...)` or `Edit(...)`.
 * A `read` rule also blocks Edit and Write on the same path, so use `edit`
 * only for files that may be read but must not change.
 */
export interface PathRule {
  kind: 'path';
  access: 'read' | 'edit';
  paths: PathSpec[];
  /**
   * Input holding file names to carve back out with `!name`. Only works when
   * every path in this rule is `anywhere`-anchored: a `!` pattern cannot
   * reach a rule anchored with `/`, `~/` or `//`.
   */
  exceptInput?: string;
}

/**
 * Blocks shell commands by text through `Bash(...)` and `PowerShell(...)`.
 *
 * Patterns use the permission-rule wildcard: `*` matches any text, and a
 * trailing ` *` also matches the bare command. `{inputId}` in a pattern
 * expands to one rule per value of that string-list input.
 *
 * A pattern may start with `*` only as `*{inputId}*`, meaning "any command
 * containing this value". That is sound for deny and ask rules; it would be
 * dangerous in an allow rule, which this tool never writes.
 *
 * These match the form Claude usually writes. They do not match the same
 * program by absolute path, inside `bash -c`, or with options moved around;
 * pair with a hook check when that matters.
 */
export interface CommandRule {
  kind: 'command';
  /**
   * Programs typed the same in every shell (git, gh, npm, docker). Written
   * once per shell the user has, so a PowerShell-only setup is covered too.
   */
  any?: string[];
  /** Bash builtins and POSIX tools. */
  bash?: string[];
  /** Cmdlets and Windows tools. */
  powershell?: string[];
  when?: Condition;
}

/** `WebFetch(domain:x)` and `WebFetch(domain:*.x)` for each host in the input. */
export interface DomainRule {
  kind: 'domain';
  input: string;
}

/** One rule per MCP tool or server named in the input. */
export interface McpRule {
  kind: 'mcp';
  input: string;
}

export type Rule = PathRule | CommandRule | DomainRule | McpRule;

// ----------------------------------------------------------------- hooks

/**
 * Hook checks run inside the generated PreToolUse script against each simple
 * command, after the script has normalized it: compound commands split,
 * absolute program paths reduced to the program name, `sudo` / `doas`
 * prefixes removed, `bash -c` / `sh -c` /
 * `eval` / heredoc bodies unwrapped and re-checked, `git -C dir` and
 * `git -c k=v` stripped, clustered short flags expanded (`-fd` to `-f -d`).
 *
 * The hook also re-applies every `CommandRule` pattern of the item to the
 * normalized command. So `/usr/bin/printenv` and `bash -c 'printenv'` are
 * caught by the hook with no extra check; list a check here only for shapes
 * the patterns cannot express.
 */
export type HookCheck =
  | ArgvCheck
  | RegexCheck
  | TouchesPathCheck
  | MentionsDomainCheck
  | BuiltinCheck;

interface HookCheckBase {
  /** Told to Claude on stderr when the check blocks. */
  message: string;
  when?: Condition;
}

/** Matches a parsed command by program, subcommand and flags in any order. */
export interface ArgvCheck extends HookCheckBase {
  type: 'argv';
  program: string | string[];
  /** Leading non-flag words after the program, e.g. `['stash', 'drop']`. */
  sub?: string[];
  /** Blocks only if at least one of these flags is present. */
  flagsAny?: string[];
  /** Does not block if any of these flags is present. */
  flagsNone?: string[];
}

/**
 * Last resort for shapes argv cannot express. Tested against each simple
 * command twice: as written (so stripped parts like `git -c k=v` are still
 * visible) and normalized. Either match blocks.
 */
export interface RegexCheck extends HookCheckBase {
  type: 'regex';
  pattern: string;
  flags?: string;
  /**
   * Only test commands run by one of these programs. Use it when the pattern
   * would otherwise fire on text that merely mentions it, such as SQL
   * keywords in a grep.
   */
  program?: string[];
}

/**
 * Blocks any command whose text names one of these paths, including inline
 * scripts. Catches `node -e "readFileSync('.env')"`; cannot catch a script
 * file that opens the path itself. Home-anchored paths match written as
 * `~/x`, `$HOME/x`, `$env:USERPROFILE\x` or the expanded absolute path.
 */
export interface TouchesPathCheck extends HookCheckBase {
  type: 'touchesPath';
  /** `write` only fires for redirects and known writing programs. */
  access: 'read' | 'write';
  paths: PathSpec[];
  exceptInput?: string;
}

/**
 * Blocks any command whose text contains one of the hosts in a domain-list
 * input, or a subdomain of one, as a whole hostname.
 */
export interface MentionsDomainCheck extends HookCheckBase {
  type: 'mentionsDomain';
  input: string;
}

/** Logic too specific to express as data. Implemented by name in the hook script. */
export interface BuiltinCheck extends HookCheckBase {
  type: 'builtin';
  name:
    /** `rm -r`, `Remove-Item -Recurse`, `rd /s`, `find -delete` whose target is root, home, the project root, or outside the project. */
    | 'recursive-delete-outside-project'
    /** `git push` whose destination ref, or current branch when none is given, is in the `protectedBranches` input. */
    | 'git-push-protected-branch'
    /** `git commit` or `git merge` while the current branch is in `protectedBranches`. */
    | 'git-commit-on-protected-branch';
}

// ----------------------------------------------------------------- tests

/**
 * A concrete tool call and what must happen to it with this item enabled
 * (using the item's `sampleInputs`). Every item needs at least one `block`
 * and one `allow`, so the tests show both what it stops and what it leaves alone.
 */
export interface TestCase {
  tool: 'Bash' | 'PowerShell' | 'Read' | 'Edit' | 'WebFetch' | 'Mcp';
  /** Command text, file path, URL, or MCP tool name. */
  input: string;
  expect: 'block' | 'allow';
  /** For `block`: the weakest layer that must catch it. `rule` means the permission rule alone suffices. */
  by?: 'rule' | 'hook';
  /** For `allow`: true when this is something we would like to stop but cannot. Must be explained in `gaps`. */
  gap?: boolean;
}

// ------------------------------------------------------------------ item

export interface CatalogItem {
  /** `<category>.<slug>`, stable across releases. */
  id: string;
  category: Category;
  title: string;
  /** One line: what this stops. */
  stops: string;
  /** One line: why it cannot be taken back. */
  why: string;
  severity: Severity;
  defaultMode: Mode;
  /** Pre-selected in the "essentials" preset. */
  essential?: boolean;
  /** Ids from the shared input registry that this item reads. */
  inputs?: string[];
  rules: Rule[];
  hook?: HookCheck[];
  /**
   * True when turning on the sandbox extends this item to subprocesses.
   * Path and domain rules are merged into the sandbox automatically, so
   * there is nothing extra to emit; this only drives the coverage note.
   */
  sandboxExtends?: boolean;
  /** Plain statements of what still gets through. Shown to the user. */
  gaps: string[];
  /** Side effects or overlaps the user should know before enabling. */
  note?: string;
  /** Input values used when running `tests`. Required for every `required` input. */
  sampleInputs?: Record<string, string[] | boolean>;
  tests: TestCase[];
}
