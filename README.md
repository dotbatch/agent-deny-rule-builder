<div align="center">

# Deny Rule Builder for Claude Code

**Pick what an agent must never do. Get the settings that stop it.**

A static web page that turns a checklist into Claude Code deny rules,<br>
an optional hook for the cases rules miss, and a box to test any command against both.

**[Open the live page](https://dotbatch.github.io/agent-deny-rule-builder/)**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg)](tsconfig.json)
[![Runtime dependencies: none](https://img.shields.io/badge/runtime%20dependencies-none-brightgreen.svg)](package.json)
[![Runs in your browser](https://img.shields.io/badge/runs-in%20your%20browser-8a2be2.svg)](#privacy)
[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange.svg)](#status)

[Quick start](#quick-start) ·
[What it protects](#what-it-protects) ·
[Rules or rules plus hook](#rules-or-rules-plus-hook) ·
[How it works](#how-it-works) ·
[Limits](#limits) ·
[Status](#status)

</div>

---

## TL;DR

### The problem

Claude Code can read your `.env`, force push over a teammate's work, or delete a folder outside the project. Its permission rules can stop all of that, but writing them by hand is error-prone:

- A rule matches the command **as typed**. `Bash(git push --force *)` does not stop `git -C . push --force` or `bash -c 'git push -f'`.
- The syntax has traps. `Write(path)` matches nothing, and `Bash(rm -rf *)` matches every recursive delete, including the harmless ones.
- Paths are written four different ways depending on where they are anchored and which settings file holds the rule.

### The solution

Tick the things you want protected, fill in the few details only you know (secret paths, protected branches, production names), and copy the result.

| You get | What it is |
| :- | :- |
| **Settings JSON** | `permissions.deny` and `permissions.ask` rules, ready to merge into `.claude/settings.json` or `~/.claude/settings.json`. |
| **A hook, if you want one** | `deny-guard.cjs`, a single Node script with no dependencies. It takes each shell command apart before checking it, so reworded commands are caught too. |
| **A sandbox block** | Optional, on macOS, Linux and WSL. Extends file and network rules to programs a command starts. |
| **A plain list of gaps** | For every item, what still gets through. Nothing is presented as airtight. |
| **A "Try it" box** | Type a command and see whether it would be blocked, asked about or allowed, and by which rule. |

### Quick example

Ticking **.env files** and **Force push** for a Linux project produces this:

```json
{
  "permissions": {
    "deny": [
      "Read(.env)",
      "Read(.env.*)",
      "Read(!.env.example)",
      "Read(!.env.sample)",
      "Read(!.env.template)",
      "Bash(git push --force)",
      "Bash(git push --force *)",
      "Bash(git push * --force)",
      "Bash(git push * --force *)",
      "Bash(git push -f)",
      "Bash(git push -f *)",
      "Bash(git push * -f)",
      "Bash(git push * -f *)",
      "Bash(git push --mirror*)",
      "Bash(git push * --mirror*)"
    ]
  }
}
```

Alongside it, the page tells you what these rules do not cover:

> Without the hook, some ways of doing this get past the rules, for example `git -C . push --force` or `git push origin +main`. The hook stops these.

---

## Quick start

The page is not hosted anywhere yet, so run it locally. You need a recent Node.js (22 was used to build it).

```bash
git clone https://github.com/dotbatch/agent-deny-rule-builder.git
```

```bash
cd agent-deny-rule-builder
```

```bash
npm install
```

```bash
npm run dev
```

Open the address Vite prints, then:

1. **Describe your setup.** Operating system, which shell tools Claude has, and whether the rules are for this project or all your projects.
2. **Choose what to protect.** Start from a preset or tick items one by one. Each item can block outright or ask first.
3. **Fill in your details.** Only the inputs your selection needs are shown.
4. **Copy or download the output** and merge it into the settings file named above each block.
5. **Try it.** Type a command into the "Try it" box to confirm it lands the way you expect.

### Installing the hook

If you choose "Rules plus hook", the page gives you two extra files. For a project they go here:

```text
.claude/
├── settings.json              <- merge the settings block into this
└── hooks/
    ├── deny-guard.cjs         <- the script, the same for everyone
    └── deny-guard.rules.json  <- built from your selections
```

The hook needs Node.js on your `PATH`. Download the rules file again whenever you change your selections.

---

## What it protects

30 items in four groups. **Block** refuses the action. **Ask** forces a prompt, even in auto mode. Either can be changed per item.

### Secrets and credentials

*Once read, a key cannot be un-read.*

| Item | What it stops | Default | Essentials |
| :- | :- | :-: | :-: |
| .env files | Reading or editing `.env` and `.env.*` anywhere in the project | Block | ✓ |
| SSH keys | Reading or changing anything in `~/.ssh` | Block | ✓ |
| Cloud and cluster credentials | Stored logins for AWS, Google Cloud, Azure, Kubernetes, Docker and the GitHub CLI | Block | ✓ |
| Commands that print secrets | Dumping every environment variable, and CLI commands whose output is a token | Block | ✓ |
| Package registry tokens and GPG keys | Publish tokens for npm, PyPI, crates.io and RubyGems, netrc logins, the GPG keyring | Block | |
| Key and certificate files in the project | Private key, keystore and service-account files, by name | Block | |
| Your own secret files and folders | The paths you list | Block | |
| Shell history and browser profiles | Command history files and browser profile folders | Block | |

### Destroying local work

*Deleted files and discarded changes cannot be recovered.*

| Item | What it stops | Default | Essentials |
| :- | :- | :-: | :-: |
| Recursive delete outside the project | Recursive deletes aimed at the filesystem root, your home folder, the project root, or anywhere outside the project | Block | ✓ |
| Throwing away uncommitted changes | `git reset --hard`, `git clean`, whole-tree checkout and restore, dropping stashes | Block | ✓ |
| Formatting and raw disk writes | Formatting volumes, repartitioning, writing directly to a disk device | Block | ✓ |
| These rules themselves | Editing the Claude Code settings files, the generated hook, and git hooks | Block | ✓ |
| Deleting branches and local history | Force-deleting branches, removing worktrees with changes, expiring the reflog | Ask | |
| Files and folders that must not change | Editing, overwriting or creating files in the paths you list | Block | |

### Things that leave the machine

*A push, a publish or a sent message cannot be recalled.*

| Item | What it stops | Default | Essentials |
| :- | :- | :-: | :-: |
| Force push | `git push` with `--force`, `-f`, `--mirror`, or a `+refspec` | Block | ✓ |
| Pushing to protected branches | Any push whose destination is one of your protected branches, and optionally commits made while on one | Ask | ✓ |
| Skipping commit and push checks | `--no-verify` on commit and push, and overriding the hooks path | Block | ✓ |
| Publishing packages and images | Publishing to npm, PyPI, crates.io, RubyGems, NuGet, Maven and container registries | Ask | ✓ |
| Deleting remote branches and tags | `git push --delete` and the `:branch` form | Ask | |
| Deleting or exposing things on GitHub | Deleting repos, releases and secrets, changing repo visibility, `DELETE` calls through `gh api` | Block | |
| Domains Claude must never contact | Fetching from the hosts you list, and their subdomains | Block | |
| Network commands in the shell | `curl`, `wget`, netcat, `scp`, `sftp` and the PowerShell web cmdlets | Ask | |
| MCP tools that send or delete | Calls to the MCP tools or whole servers you list | Ask | |

### Infrastructure and data

*A dropped database or a destroyed stack is gone for everyone who used it.*

| Item | What it stops | Default | Essentials |
| :- | :- | :-: | :-: |
| Anything aimed at production | Any shell command that contains one of the production names you list | Ask | |
| Dropping and resetting databases | Drop, truncate and flush commands, and the reset commands of common migration tools | Ask | |
| Wiping container volumes | docker and podman prune commands, volume removal, compose down with volumes | Ask | |
| Deleting Kubernetes resources | `kubectl delete` and `drain`, scaling to zero, `helm uninstall` and `rollback` | Ask | |
| Destroying infrastructure as code | terraform, OpenTofu, Pulumi and CDK destroy; apply without review; state surgery | Ask | |
| Deleting cloud resources | Delete and terminate commands in the AWS, Google Cloud and Azure CLIs, and app teardown on common hosts | Ask | |
| Changing the machine itself | `sudo`, opening permissions wide, stopping services, shutdown, firewall and registry changes | Ask | |

### Presets

| Preset | Contains |
| :- | :- |
| **Essentials** | The 12 ticked items above: secrets, lost work, force push and publishing. A sensible start for anyone. |
| **Team repo** | Essentials, plus shared-repo damage: deleting branches, repos and releases, and publish tokens. |
| **Production access** | Team repo, plus all seven infrastructure items. For a computer that can reach real systems. |
| **Everything** | Every item. Expect to fill in several details and to be asked often. |

---

## Rules or rules plus hook

The page starts in **rules only** mode: one block of JSON to paste and nothing to install. That covers the form of a command Claude usually writes.

**Rules plus hook** adds `deny-guard.cjs` as a `PreToolUse` hook. Before checking a shell command, the hook:

- splits compound commands (`a && b`, pipes, subshells, substitutions),
- reduces `/usr/bin/git` to `git` and removes `sudo`, `env`, `timeout`, `xargs` and similar wrappers,
- unwraps `bash -c`, `eval`, heredocs, `find -exec` and PowerShell's `Invoke-Expression`,
- strips `git -C dir` and `git -c key=value`, and expands clustered flags (`-uf`),
- follows `cd` so it knows which folder a relative path refers to.

Here is how the simulator scores some commands with the Essentials preset on Linux and `main` as a protected branch:

| Command | Rules only | Rules plus hook |
| :- | :-: | :-: |
| `git push --force origin work` | Blocked | Blocked |
| `git -C . push --force origin work` | Allowed | **Blocked** |
| `bash -c 'git push -f origin work'` | Allowed | **Blocked** |
| `cat .env` | Blocked | Blocked |
| `node -e "console.log(require('fs').readFileSync('.env','utf8'))"` | Allowed | **Blocked** |
| `/usr/bin/printenv` | Allowed | **Blocked** |
| `sudo rm -rf ~/` | Blocked | Blocked |
| `git push origin main` | Asks | Asks |
| `git push origin feature` | Allowed | Allowed |
| `rm -rf build` | Allowed | Allowed |
| `cat .env.example` | Allowed | Allowed |

If the hook itself crashes or times out, it blocks the call instead of letting it through. That setting (`"onFailure": "block"`) needs Claude Code v2.1.295 or later and can be turned off on the page.

---

## How it works

```text
  catalog (data)                 your choices
  30 items: rules, hook          OS, shells, scope,
  checks, gaps, test cases       selections, inputs
          │                           │
          └────────────┬──────────────┘
                       ▼
                  generator
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
  settings JSON   deny-guard.rules.json   per-item gaps
  deny / ask /    read by the hook        and warnings
  hooks / sandbox
        │              │
        └──────┬───────┘
               ▼
           simulator  ◄── a command typed into "Try it"
               │
               ▼
     blocked, asked or allowed, and by what
```

- **A catalog item is pure data.** It lists permission-rule patterns, hook checks, known gaps, and test cases. Each test case is a real tool call marked `block` (by rule or by hook) or `allow`.
- **The generator** turns selected items into permission rules and a JSON rules file for the hook. It also converts pasted Windows, POSIX, home and project paths into the right rule syntax for the settings file you chose.
- **The simulator** has two halves. The rules half is this project's own implementation of the matching that Claude Code documents. The hook half runs the real hook script.
- **The tests** run all 286 catalog test cases through the simulator with only that case's item enabled. A case marked "rule" must be stopped by rules alone; a case marked "hook" must get past the rules and be stopped by the hook; an "allow" case must be stopped by neither.

### Privacy

Everything runs in the page. Secret paths, branch names and production names you type are kept in your browser's `localStorage` and are not sent anywhere. There is no backend.

---

## Limits

Deny rules and a text-matching hook reduce accidents. They are not a security boundary.

- **Scripts that do the damage themselves.** A test suite or dependency that opens `.env` on its own is invisible to rules and to the hook. Only the sandbox stops that, and native Windows has no sandbox.
- **Indirect reads.** `grep -r KEY .` reads a secret file without naming it.
- **Aliases and wrapper scripts** that hide a blocked command behind another name.
- **The hook's shell parser is hand-written.** It handles the documented bypass forms, not every construct a shell allows. Unusual quoting could be misread in either direction.
- **Server-side protection is the real guarantee.** For force pushes and protected branches, turn on branch protection at your git host as well.

The page lists the specific gaps for every item you select. For deeper command analysis, see [Related projects](#related-projects).

---

## Status

Pre-release. Read this before relying on the output.

| | |
| :- | :- |
| **Works** | Catalog, generator, hook, simulator and page. 971 tests pass locally. |
| **Not verified** | The generated rules have not yet been confirmed inside a live Claude Code session. The simulator's rules half is a reading of the docs (checked 2026-11-13), not Claude Code's own matcher. If the two disagree, the tests still pass and the rules are still wrong. |
| **Not built** | Hosting, CI, shareable links, and an `autoMode` fragment. |
| **Scope** | Claude Code only. |

[HANDOFF.md](HANDOFF.md) has the full list of known issues and open questions. [PLAN.md](PLAN.md) has the reasoning behind each decision.

---

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

`npm run build` typechecks and writes a fully static site to `dist/`.

| Path | What it is |
| :- | :- |
| [`src/catalog/schema.ts`](src/catalog/schema.ts) | Types for a catalog item. Start here. |
| [`src/catalog/`](src/catalog) | The 30 items (`secrets`, `local`, `remote`, `infra`) and the nine shared inputs. |
| [`src/generator/`](src/generator) | Selections and inputs in, settings and hook rules out. Path conversion lives in `paths.ts`. |
| [`src/hook/deny-guard.cjs`](src/hook/deny-guard.cjs) | The hook users install. Plain CommonJS, no dependencies, shipped as-is. |
| [`src/simulator/`](src/simulator) | Predicts what the rules and the hook do to one tool call. |
| [`src/app/`](src/app) | The page: DOM, state, presets and styles. |

### Adding a protection

1. Add an item to the matching file in `src/catalog/`, following `CatalogItem` in the schema.
2. Give it at least one `block` and one `allow` test case. State what it cannot catch in `gaps`.
3. Run `npm test`. The simulator tests will tell you whether each case is stopped by the layer you claimed.

---

## Related projects

- **[destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard)** (dcg) analyses commands far more deeply than the hook here, and supports several agents. The infrastructure items in this catalog follow its taxonomy, and the page recommends it when you select three or more of them.

## License

[Apache License 2.0](LICENSE)
