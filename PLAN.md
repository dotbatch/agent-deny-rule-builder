# Agent Deny Rule Builder — Project Plan

A web page where someone picks what they want to protect against, fills in the few details only they know (secret paths, protected branches, prod hosts), and gets a ready-to-paste Claude Code config: deny rules, hooks, and sandbox settings.

Sources: the two transcripts in `refrences/`, the Claude Code permissions and hooks docs (checked 2026-11-13), and the `destructive_command_guard` (dcg) README.

## 1. Notes from the references

### Transcript 1 (out-of-the-loop sessions talk)

- With auto mode as the default, a classifier approves commands instead of a person. It blocked about 89% of clearly dangerous commands in Anthropic's study, so about 1 in 10 still got through. A guarantee can only come from the harness.
- **Deny rules are checked before the auto mode classifier.** A call matching a deny rule never reaches the classifier.
- **The test for "does this need a rule?": if Claude gets it wrong once, can I take it back?** Wrong code can be reverted. Thrown-away uncommitted changes, or a key read into the transcript, cannot. Those need rules.
- A `Read` deny on `.env` also stops `cat .env`. It does not stop a script (`npm test`, a dependency, a throwaway script Claude wrote) from opening the file. Permissions decide whether a tool call runs, not what it reaches once running.
- **The sandbox closes that gap.** With it on, the same deny rule is passed to the OS and applies to child processes. It also limits which hosts commands can reach. By default the sandbox can still read most of the machine, so SSH keys and similar need their own rules.
- The sandbox covers only shell commands. File tools, MCP servers, and hooks run outside it.
- Cloud sessions remove local secrets entirely, but things that leave the machine (a pushed commit, a message sent through a connector) are still permanent. Commit deny rules to the repo so they travel with it: force push, secrets in commits.
- Auto mode can also be told in plain English which repos, buckets, and domains to trust.
- Hook scripts must exit with code 2 to block. Exit 1 is treated as a non-blocking error.

### Transcript 2 (hooks explainer)

- Hooks are deterministic: they always run. A prompt instruction is a suggestion.
- `PreToolUse` runs before a tool call, gets the tool name and input as JSON on stdin, and blocks with exit 2. Stderr is fed back to Claude so it can adjust.
- Examples given: block writes to a production config directory, block `rm -rf`, block commits to main.
- Put hooks in `.claude/settings.json` and commit them so the whole team gets them. Reference scripts with `$CLAUDE_PROJECT_DIR`.

### What the docs add (these shape the generator)

- **Bash deny rules match command text, not the program.** `Bash(rm *)` stops `rm -rf build/` but not `/bin/rm -rf build/` or `bash -c 'rm -rf build/'`. `Bash(git push *)` does not stop `git -C . push`. The docs say a Bash deny rule "isn't a security boundary around the program." This is the reason the tool must emit hooks as well as rules.
- Deny rules do apply to each part of a compound command, inside `$()`, and past env-var prefixes and wrappers like `timeout`.
- **Path prefixes are easy to get wrong:**
  - `//path` is absolute, `~/path` is home-relative, `/path` is relative to the settings file's anchor, `path` is relative to the current directory.
  - `/secrets/**` in user settings means `~/.claude/secrets/**`, not the project.
  - On Windows, `C:\Users\x` is written `//c/Users/x`.
- A `Read` deny also blocks Edit and Write on that path. `Write(path)`, `Grep(path)`, and `Glob(path)` rules silently match nothing; use `Edit` and `Read`.
- `WebFetch(domain:x)` deny rules are also added to the sandbox's denied-domain list. A bare `WebFetch` deny removes the tool.
- MCP: `mcp__<server>__*` or a single tool name. No argument matching from settings files.
- PowerShell has its own tool and rule namespace: `PowerShell(Remove-Item *)`. Aliases are canonicalized.
- A hook can return `deny` or `ask` as JSON instead of exit 2. `"onFailure": "block"` makes a crashed or timed-out hook fail closed (v2.1.295+).
- Deny at any settings scope wins over allow at any other scope. Project deny rules apply without workspace trust.

### What dcg does

- A Rust binary installed as a `PreToolUse` Bash hook for Claude Code and about 18 other agents.
- **Two packs always on:** `core.filesystem` (recursive `rm` and equivalents) and `core.git` (`reset --hard` and other work-losing or history-rewriting commands). `system.disk` is on by default. Windows packs turn on automatically on Windows.
- **About 50 opt-in packs by category:** databases, containers, Kubernetes, cloud (AWS, Azure, GCP), storage, Terraform and Pulumi, CI/CD, secrets managers, DNS, CDN, messaging, monitoring, payments, search, backup, package publishing, strict git.
- It scans heredocs and inline scripts (`python -c`, `bash -c`, `node -e`), re-running inner shell through the full pipeline. It distinguishes data from execution: `grep "rm -rf"` is allowed.
- Per-rule modes: `deny`, `ask`, `warn`, `log`. Critical rules cannot be loosened by a broad setting.
- `dcg explain "<command>"` says why a command is blocked. `dcg scan` checks files in CI.
- Escape hatches: one-time allow codes, a permanent allowlist with a required reason, and `DCG_BYPASS=1`.
- Stated limits: fails open by default on unparseable input, and the model can write a script to disk to get around command inspection.
- **Gap it leaves:** it only looks at shell commands. It does nothing for file-tool reads of secrets, WebFetch, MCP tools, or what a subprocess does. Those are the areas native deny rules and the sandbox cover.

## 2. What we are building

A static, client-side page. Nothing the user types (paths, hostnames) leaves the browser.

Flow:

1. **Environment.** OS and shell (Bash, PowerShell, or both), where the config will live (project `.claude/settings.json`, user `~/.claude/settings.json`, or managed), and whether they use the sandbox.
2. **Pick protections.** A categorized checklist. Each item says in one line what it stops and why it is irreversible. A few presets on top: "Solo dev essentials", "Team repo", "Production access on this machine".
3. **Fill in details.** Only the inputs the selected items need, asked once and shared across items.
4. **Output.** The settings JSON, any hook scripts, where each file goes, and a per-item list of what is not covered.

A "test a command" box (borrowed from `dcg explain`) lets the user type a command and see which generated rule or hook catches it, or that nothing does.

## 3. Enforcement layers and how the tool chooses

Each catalog item declares which layers it emits. The generator picks the weakest layer that actually holds and adds a stronger one when the first has a known hole.

| Layer | Good for | Known hole | Emitted as |
| :- | :- | :- | :- |
| Deny rule | File reads and edits, whole tools, MCP tools, WebFetch domains, plain command forms | Bash text matching misses `/bin/rm`, `bash -c`, `git -C . push` | `permissions.deny` |
| Ask rule | Things that are sometimes legitimate (push to main, `terraform apply`) | Same as deny | `permissions.ask` |
| PreToolUse hook | Commands needing real parsing: flag order, wrappers, inline scripts, branch names | A script written to disk and then run | `hooks.PreToolUse` plus a script file |
| Sandbox | Anything a subprocess might do: read secrets, reach unknown hosts | Only shell commands; file tools and MCP are outside it. Not available on native Windows | `sandbox` settings |

Rule of thumb the UI will state: a file path gets a deny rule and a sandbox entry. A dangerous command gets a deny rule for the common form and a hook for the rest.

## 4. Protection catalog (first version)

Grouped by the transcript's "can I take it back?" test. Items marked ✎ need user input.

**Secrets and credentials (cannot un-read)**
- `.env` files, with an optional carve-out for `.env.example`
- SSH keys, cloud credentials (`~/.aws`, `~/.config/gcloud`, `~/.azure`), `~/.kube/config`, `~/.npmrc`, `~/.netrc`, `~/.docker/config.json`, GPG keys
- ✎ Custom secret paths and file patterns (`*.pem`, `secrets/`, a vault export folder)
- Commands that print secrets: `env`, `printenv`, `gh auth token`, `aws configure export-credentials`, `op read`, `vault kv get`
- Shell history and browser profile directories

**Destroying local work (cannot un-delete)**
- Recursive delete outside the project, or of home and root
- `git reset --hard`, `git clean -fd`, `git checkout -- .`, `git restore .`, `git stash drop/clear`, `git branch -D`
- Disk-level: `dd` to a device, `mkfs`, `diskpart`, `format`
- Windows equivalents: `Remove-Item -Recurse`, `rd /s`, `del /s`
- ✎ Protected directories that must never be edited (prod config, migrations, generated files, lockfiles)
- Self-protection: edits to `.claude/settings.json`, the hook scripts, and `.git/hooks`

**Things that leave the machine (cannot recall)**
- `git push --force`, with `--force-with-lease` allowed or not
- ✎ Push or commit to protected branches (default `main`, `master`)
- `git push --no-verify`, `git commit --no-verify`
- Publishing: `npm publish`, `cargo publish`, `twine upload`, `gem push`, `docker push`
- `gh repo delete`, changing repo visibility, `gh release delete`
- ✎ Network: block specific domains, or block `curl`/`wget`/`nc` and rely on WebFetch plus a sandbox allowlist
- ✎ MCP tools that send or delete (send email, post message, delete issue) by server name

**Infrastructure and data (opt-in packs, following dcg's taxonomy)**
- Databases: `DROP`, `TRUNCATE`, `dropdb`, `FLUSHALL`, migration resets (`prisma migrate reset`, `supabase db reset`)
- ✎ Any command naming the production host, connection string fragment, or cloud profile
- Containers: `docker system prune`, `docker volume prune`, `compose down -v`
- Kubernetes: `kubectl delete namespace`, `drain`, `helm uninstall`; ✎ production context names
- IaC: `terraform destroy`, `apply -auto-approve`, `state rm`, `pulumi destroy`
- Cloud CLIs: instance, database, bucket, and resource-group deletion for AWS, GCP, Azure
- System: `chmod -R 777`, `chown -R` on system paths, `sudo`, stopping services

**Evasion (hook-only, on by default when any Bash item is selected)**
- Unwrap `bash -c`, `sh -c`, `eval`, `python -c`, `node -e`, heredocs, and re-check the inner text
- Normalize absolute binary paths and `git -C` / `git -c` forms
- Pipe-to-shell: `curl ... | sh`

## 5. User inputs

Asked only when a selected item needs them, each with a sensible default and validation.

| Input | Used by | Notes |
| :- | :- | :- |
| OS and shell | Everything | Decides Bash vs PowerShell rules and hook script language |
| Settings scope | All path rules | Changes the path prefix; the generator handles this so the user never sees `//` vs `/` |
| Secret paths and patterns | Read deny, sandbox deny-read | Accept pasted Windows or POSIX paths and convert (`C:\keys` to `//c/keys`) |
| `.env` exceptions | `!` carve-out | Must be ordered after the rule it carves from |
| Protected branches | Push and commit hooks | List |
| Protected directories | Edit deny | Project-relative |
| Blocked or allowed domains | WebFetch deny, sandbox network | Offer `domain` and `*.domain` together |
| Production identifiers | Prod hook | Hostnames, DB names, kube contexts, cloud profiles; substring match |
| MCP server and tool names | MCP deny | Normalize `.` and spaces to `_` |
| Deny or ask, per item | All | Default deny for irreversible, ask for sometimes-legitimate |

## 6. Output

- **`settings.json` fragment** with `permissions.deny`, `permissions.ask`, `hooks`, and `sandbox`, each rule traceable to the item that produced it.
- **Hook script** (Node, no dependencies) plus a JSON rules file it reads, so re-generating does not mean re-reviewing code. Blocks with exit 2 and a stderr message that tells Claude what was blocked and why. Registered with `"onFailure": "block"`.
- **Install steps** for the chosen scope, including how to merge into an existing settings file instead of overwriting it.
- **Coverage notes**: for each item, the plain statement of what still gets through (for example "a script that opens `.env` itself; turn on the sandbox to close this").
- **dcg handoff**: when someone selects many infrastructure packs, say that dcg covers this ground more deeply and show how the generated deny rules and sandbox settings sit alongside it.
- Optional: plain-English `autoMode` rules (trusted repos, buckets, domains) generated from the same inputs, as a separate fragment for `~/.claude/settings.json` because project settings cannot carry them.

## 7. Architecture

- Static site, no backend, no accounts, no analytics on typed input.
- **Catalog as data**, one entry per protection: id, category, title, why-irreversible, severity, default mode, required inputs, emitters per layer, known gaps, and test cases (commands that must and must not match).
- **Generator as pure functions**: `(selections, inputs, environment) -> { settings, files, notes }`. Easy to unit-test and reuse from a CLI later.
- **Matcher simulator** for the "test a command" box, implementing the documented rule semantics: wildcard and trailing-space behavior, compound splitting, wrapper stripping, gitignore path matching.
- The catalog's own test cases run against the simulator and the real hook script in CI, so every item ships with proof of what it catches.

## 8. Phases

1. **Verify the unknowns.** Confirm the exact sandbox setting keys and the auto mode settings key against current docs, and run a handful of generated rules in a real Claude Code session on Windows and macOS.
2. **Catalog and schema.** Write the entry schema and the secrets, local-work, and leaves-the-machine groups with test cases.
3. **Generator.** Deny and ask rules first, including path-prefix and Windows path conversion. Then the sandbox block.
4. **Hook.** The script, the rules file format, the evasion unwrapping, and tests against the catalog cases.
5. **Page.** The four-step flow, output with copy and download, coverage notes.
6. **Command tester.**
7. **Infrastructure packs and presets.**

### Status

- Phase 1: setting names verified; live testing still open (see section 9).
- Phase 2: done. Schema in `src/catalog/schema.ts`, shared inputs in `inputs.ts`, 23 items across `secrets.ts`, `local.ts`, and `remote.ts`, with 198 test cases. `npm test` checks catalog structure only; whether each rule or hook check actually catches its cases is verified in phases 3, 4, and 6.

- Phase 3: done. `src/generator/generate.ts` turns selections, inputs, and environment into `permissions.deny`, `permissions.ask`, and the `sandbox` block, with per-rule provenance, per-item coverage notes, and warnings. `src/generator/paths.ts` converts pasted Windows, POSIX, home, and project-relative paths. Not yet included: the `hooks` block (phase 4) and the optional `autoMode` fragment.

Phase 3 notes:

- Only one path writer was needed. Deny rules are merged into the sandbox by Claude Code, so nothing is written under `sandbox.filesystem`.
- Command patterns now have three lists: `any` (git, gh, npm and other programs typed the same in every shell, written once per selected shell), `bash`, and `powershell`. Without `any`, a PowerShell-only setup got no git rules.
- In user settings, project-relative paths are written without a leading slash, because `/x` there means `~/.claude/x`. The generator warns that such a rule then applies in every project.
- A path with no trailing slash and no wildcard produces two rules, the path and `path/**`, since a file cannot be told from a folder.
- Rules with `!` carve-outs are placed first in the list so each carve-out directly follows what it carves from.

- Phase 4: done. `src/hook/deny-guard.cjs` is the hook script: plain CommonJS, no dependencies, about 900 lines. The generator now also returns the `hooks` settings block and the contents of `deny-guard.rules.json`. Every shell test case in the catalog is run against the real hook logic, plus the script itself is run as a child process with JSON on stdin.

Phase 4 notes:

- **What the hook takes apart:** compound commands, `$(...)` and backtick substitutions, subshells, `sudo` / `env` / `timeout` / `xargs` and similar wrappers, `bash -c` and `eval` to six levels, heredocs and here-strings fed to a shell, `find -exec`, `cmd /c`, `powershell -Command`, absolute program paths, and `git -C` / `git -c`. PowerShell aliases are mapped to cmdlet names and matched without regard to case.
- **Text that only mentions a command is left alone:** `echo "git reset --hard"`, a commit message, a comment, a heredoc written to a file.
- **It fails closed.** A crash, unreadable input, a missing rules file, a command over 50,000 characters, or nesting too deep to analyze all block the call.
- **Recursive delete is judged by where it lands,** following `cd` within the command. Root, home, the project folder, anything containing them, and anything outside the project are blocked. Inside the project and inside the OS temp folder are allowed. A target that depends on a variable is blocked as unknown.
- **The file is `.cjs`,** so it still runs as CommonJS when the project's `package.json` says `"type": "module"`.
- **In user settings the hook is registered in shell form** (`node "$HOME/.claude/hooks/deny-guard.cjs"`), because the no-shell form has no way to name the home folder. `$HOME` works in both sh and PowerShell.
- **`onFailure: "block"` is written by default** and can be turned off for Claude Code older than v2.1.295. Not checked: whether older versions reject a settings file containing that key.
- **Catalog bug found by the hook tests:** Claude Code reads a rule ending in `:*` as another spelling of a trailing ` *`. Three patterns ended that way (`Get-ChildItem Env:*`, `git push * :*`, `rsync * *:*`) and would not have matched what they were meant to. They are rewritten, and the catalog tests now reject any pattern ending in `:*`.

Known limits of the hook, to state in the page's coverage notes:

- A script written to disk and then run is not inspected.
- It reads the command, not the result of expanding it: `rm -rf $DIR` is blocked as unknown, but a variable that hides a program name (`$CMD --force`) is not resolved.
- It is a hand-written shell tokenizer, not a full parser. Unusual quoting or syntax it does not model could be misread in either direction.
- The first full test run stalled once and never again in later runs; the cause was not found. Stray worker processes from that stopped run are the likely reason, but an intermittent hang in the tokenizer is not ruled out.

- Phase 5: done. `index.html` and `src/app/` are the page: plain TypeScript and DOM, built with Vite, no framework. `npm run dev` serves it, `npm run build` writes `dist/`. Checked in a browser: the Essentials preset, an item that needs input, a pasted Windows path, the generated settings, and state surviving a reload.

Phase 5 notes:

- State (setup, selections, typed details) is kept in the browser's `localStorage` only. There is no shareable link yet.
- List inputs are one entry per line, not comma-separated, because paths can contain commas.
- The hook script is bundled into the page as text and offered as a download next to the generated rules file.
- Output order follows the catalog, not the order boxes were ticked, so the same choices always give the same file.
- The dev server uses port 5391; 5173 was already taken on this machine.
- No design work, per the brief: system font, minimal CSS.

- Rules only or rules plus hook: done. Step 1 of the page has a "How strict" choice. Rules only is the default; the hook is opt-in and labelled for advanced users, with an expandable explanation of the difference and what the hook costs.
  - With the hook off, the generator writes no `hooks` block, rules file, or hook warnings. The permission rules are identical either way.
  - Each item reports `hookOnly`: the commands from its own test cases that only the hook stops, filtered to the shells in use. With the hook off these are shown as a gap with examples; with it on they are shown as what the hook is doing.
  - An item that works only through the hook in the current setup (recursive delete on PowerShell-only) is marked skipped with that reason when the hook is off.
  - The generator's own default stays hook-on when the field is omitted; the page sets it off explicitly.

Design choices made while writing the catalog, which phase 4 must honor:

- The hook re-applies every command pattern of an item to the normalized command. So `/usr/bin/printenv` and `bash -c 'printenv'` are caught without a separate check per item.
- Regex hook checks run against each simple command both as written and normalized, so stripped parts such as `git -c core.hooksPath=...` stay visible.
- A literal `*` cannot be written in a permission pattern (`rm -rf *` as a rule would match every recursive delete), so glob targets are left to the hook.
- Three checks are named builtins in the hook rather than data: recursive delete outside the project, push to a protected branch, and commit on a protected branch.

## 9. Phase 1 findings (docs checked 2026-11-13)

Status: setting names verified against the docs. Live testing not done; see the end of this section.

### Sandbox

- **Native Windows has no sandbox.** Commands run unsandboxed; the sandbox needs macOS, Linux, or WSL2. For a native Windows user the tool must not present the sandbox as a layer. Deny rules plus the hook are all they get, and the coverage notes must say subprocess reads of secrets are not stopped.
- Verified keys:
  - `sandbox.enabled`
  - `sandbox.filesystem.denyRead`, `allowRead`, `allowWrite`, `denyWrite`
  - `sandbox.network.allowedDomains`, `deniedDomains`, `strictAllowlist` (deny unlisted hosts instead of prompting, v2.1.219+)
  - `sandbox.failIfUnavailable` (exit at startup if the sandbox cannot run)
  - `sandbox.allowUnsandboxedCommands` (`false` stops Claude retrying a command outside the sandbox)
  - `sandbox.excludedCommands`
  - `sandbox.credentials.files` and `envVars`, each entry with a `mode` of `deny` or `mask`
- **Sandbox paths use a different syntax from permission rules.** In `sandbox.filesystem.*`, `/tmp/build` is absolute, `~/x` is home, and `.` is relative to the settings file. In `Read(...)` rules, absolute needs `//`. The generator needs two path writers.
- `Read` and `Edit` deny rules and `WebFetch(domain:...)` rules are merged into the sandbox automatically, so the generator emits each path once as a deny rule and does not repeat it under `sandbox.filesystem`.
- The sandbox honors only a leading `*.` or a bare `*` in domains. Other wildcard positions work for WebFetch but do nothing for sandboxed commands.
- Hosts that tools reach without a proxy (plain `ssh`, most database drivers) are blocked even when allowed. Worth a coverage note.
- For the "strict" preset: `enabled`, `failIfUnavailable`, and `allowUnsandboxedCommands: false` together, since otherwise a failed command can be retried outside the sandbox.

### Auto mode

- The key is `autoMode`, with `environment`, `allow`, `soft_deny`, and `hard_deny`. Each is an array of plain-English strings. There is also `autoMode.classifyAllShell`.
- **`autoMode` is ignored in project settings** (`.claude/settings.json` and `.claude/settings.local.json`). It is read only from `~/.claude/settings.json`, managed settings, and `--settings`. So this part of the output is always a separate user-level fragment, never part of the committed project file.
- **Each array must include the literal string `"$defaults"`** or it replaces the built-in list for that section, which would drop the built-in force-push and data-exfiltration rules. The generator always emits it first.
- Auto mode allows pushes to the working repo's branches, including the default branch, unless a rule says otherwise. The protected-branch item therefore matters even for auto mode users.
- `claude auto-mode config` prints the effective rules; the install steps should tell the user to run it.

### Other things that change the plan

- **Claude Code already guards some paths.** Writes to `.git`, `.claude`, `.vscode`, `.husky`, shell profiles, `.npmrc`, `.mcp.json`, and similar are prompted in manual mode and sent to the classifier in auto mode. The self-protection item is still worth a hard deny, but the UI should say what is already covered.
- **Version requirements.** `"onFailure": "block"` on hooks needs v2.1.295+. Input-redirect checks need v2.1.257+. The CLI on this machine is v2.1.215, so the output must state a minimum version and the hook must still be safe without `onFailure` (on older versions a crashed hook lets the call through).
- A hook's `if` field takes one permission-rule pattern and is best-effort. Use it only to avoid running the script on every call, never as the check itself.

### Not done: live testing

A throwaway project with fake secrets and two deny rules was set up, but the `claude` CLI on this machine returned `401 OAuth access token has expired`, so no rule was exercised in a real session. macOS cannot be tested from this machine at all. The test matrix to run once the CLI is signed in:

| Attempt | Expected with `Read(.env)` and `Bash(git push *)` denied |
| :- | :- |
| Read tool on `.env` | Refused |
| `cat .env` | Refused |
| `head -1 .env.example` | Allowed |
| `grep -r FAKE_KEY .` | Allowed (reads without naming the file) |
| `node -e` reading `.env` | Allowed (subprocess); hook should catch |
| `git push origin main` | Refused |
| `git -C . push origin main` | Allowed; hook should catch |

## 10. Decisions to make

- **Hook script language: decided, Node.** One dependency-free `.js` script for Windows, macOS, and Linux, registered in exec form (`"command": "node"`, script path in `args`) so it needs no shell. A native Claude Code install does not guarantee Node is on the path, so the output states Node as a prerequisite. Bash plus `jq` and PowerShell variants are not planned unless this turns people away.
- **Claude Code only, or other agents too.** dcg targets many agents. Native deny rules and the sandbox are Claude Code specific, and they are where this tool adds something dcg does not. Recommendation: Claude Code only for the first version, with the catalog kept agent-neutral so other emitters can be added.
- **How deep to go on command parsing.** A full shell parser in the hook is dcg's territory. Recommendation: handle the documented bypass forms (absolute paths, `-c` wrappers, `git -C`, heredocs) and point to dcg beyond that.
- **Shareable configs.** Encoding selections in the URL is handy for teams but would put secret paths in a link. Recommendation: share selections only, never the typed inputs.
