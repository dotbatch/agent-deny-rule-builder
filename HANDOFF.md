# Handoff notes

Written 2026-11-14 for whoever picks this up next. Read this first, then `PLAN.md` for the reasoning behind each decision.

## What this is

A static web page that builds Claude Code deny rules. A person picks what they want to protect against, fills in the few details only they know (secret paths, protected branches, production names), and gets settings JSON to paste, plus an optional hook script. A "Try it" box shows whether a typed command would be stopped and by what.

All seven phases in `PLAN.md` section 8 are written. Nothing has been deployed, and nothing has been verified inside a real Claude Code session.

## State of the repo

- **`main`** holds phases 1 to 6, merged through pull requests 1 to 4 on `dotbatch/agent-deny-rule-builder`.
- **Branch `infrastructure-packs`** holds phase 7 and this file, committed with a clean working tree. When these notes were written it was **not yet pushed or merged**. Run `git log --oneline -5 main` and `gh pr list --state all` to see whether that has changed. If it has not, push the branch and open a pull request against `main`; the owner merges.
- There is no CI. Every "tests pass" claim in the pull requests comes from local runs.
- There is no README. `PLAN.md` and this file are the only docs.

## Run it

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev
```

- `npm test` runs 971 tests in about 15 seconds.
- `npm run dev` serves the page. `.claude/launch.json` starts it on port 5391, because 5173 was taken by another project on the machine this was built on.
- `npm run build` typechecks and writes `dist/` (ignored by git).
- Node 22.14 was used. The only dependencies are `typescript`, `vitest`, `vite`, and `@types/node`.

## Layout

| Path | What it is |
| :- | :- |
| `src/catalog/schema.ts` | Types for a catalog item: rules, hook checks, gaps, test cases. Start here. |
| `src/catalog/inputs.ts` | The nine shared user inputs. |
| `src/catalog/{secrets,local,remote,infra}.ts` | The 30 items, with 286 test cases between them. |
| `src/generator/generate.ts` | Selections + inputs + environment -> `permissions.deny/ask`, `hooks`, `sandbox`, hook rules file, per-item notes, warnings. |
| `src/generator/paths.ts` | Converts pasted Windows, POSIX, home and project paths into rule prefixes. |
| `src/hook/deny-guard.cjs` | The hook the user installs. Plain CommonJS, no dependencies, about 900 lines. Shipped as-is. |
| `src/simulator/simulate.ts` | Predicts what rules and hook do to one tool call. Backs the "Try it" box and the catalog proof tests. |
| `src/app/` | The page: `main.ts` (DOM), `state.ts` (state, presets, storage), `style.css`. |
| `refrences/` | The two source transcripts. The folder name is misspelled; see questions below. |

## How the pieces fit

1. A **catalog item** is pure data. It lists permission-rule patterns, hook checks, known gaps, and test cases. Each test case is a concrete tool call marked `block` (by `rule` or by `hook`) or `allow`.
2. The **generator** turns selected items into two outputs: permission rules, and a JSON rules file for the hook.
3. The **hook** reads that JSON. It takes a shell command apart (compound commands, `sudo`, `bash -c`, substitutions, absolute paths, `git -C`), then re-applies each item's command patterns to the normalized pieces and runs the item's extra checks.
4. The **simulator** has two halves. The rules half is our own implementation of the matching Claude Code documents. The hook half runs the real hook script, loaded from its source text.
5. The **page** runs the generator on every change and the simulator on every keystroke in the "Try it" box. Nothing typed leaves the browser.

## What the tests prove, and what they do not

`src/simulator/simulate.test.ts` runs every catalog test case with only its own item enabled:

- a case marked `by: 'rule'` must be stopped by the rules alone;
- a case marked `by: 'hook'` must get past the rules and be stopped by the hook;
- an `allow` case must be stopped by neither.

This is what backs the "only the hook stops these" examples on the page. It has found real catalog bugs four times, so keep it green and add a test case with every new pattern.

**The limit:** the rules half is a reading of the docs, not Claude Code's matcher. If the docs and the product disagree, these tests still pass and the generated rules are still wrong. Only a live session settles that.

## Not done

1. **Live test in a real Claude Code session.** The single biggest gap. `PLAN.md` section 9 has a seven-case matrix. It was attempted three times and failed each time because the `claude` CLI on the build machine reported `"loggedIn": false`, even after the user signed in. The stored login file was not updated by those sign-ins; the cause was never found. Test rules-only first, then rules plus hook. Test on macOS or Linux too, since the sandbox cannot be tested on native Windows.
2. **Copy and download buttons** on the page were never clicked in testing.
3. **The optional `autoMode` fragment** from `PLAN.md` section 6 is not generated. Findings on how it must work are in section 9: it is ignored in project settings, and every list must include `"$defaults"`.
4. **Shareable links.** State lives in `localStorage` only.
5. **Deployment.** Not discussed. `npm run build` output is fully static.
6. **CI.** None.
7. **README.** None.

## Known issues and risks

- **One unexplained test stall.** The first full run after the hook was written hung and was stopped. It has not recurred in dozens of runs since. Stray worker processes are the likely cause, but an intermittent hang in the hook's tokenizer is not ruled out. A hook that hangs would stall every shell command, so if it ever recurs, treat it as serious.
- **The hook's tokenizer is hand-written.** It is not a full shell parser. Unusual quoting could be misread in either direction.
- **`"onFailure": "block"`** is written on the hook by default and needs Claude Code v2.1.295 or later. Whether older versions reject a settings file containing that key was not checked. The build machine's CLI was v2.1.215.
- **Rule count.** The "Production access" preset produced 218 block rules and 424 ask rules on Windows. Whether Claude Code has a limit, or slows down at that size, is unknown.
- **Cloud CLI prompts.** With the hook on, every `aws ... delete-*` and every `gcloud` or `az` `delete` asks, including harmless ones. The rules alone list only high-impact services.
- **The hook is evaluated in the browser with `new Function`** on its bundled source text. This will break under a strict content security policy.
- **Docs may have moved.** Everything about Claude Code behaviour was read from `code.claude.com/docs` on 2026-11-13. Re-check before trusting a detail.

## Gotchas that cost time

- **A rule ending in `:*` means something else.** Claude Code reads it as a trailing ` *`. `PowerShell(Get-ChildItem Env:*)` would match `Env *`, not `Env:`. A catalog test rejects this now.
- **A literal `*` cannot be written in a pattern.** `Bash(rm -rf *)` matches every recursive delete. Glob targets are left to the hook.
- **A leading `*` is allowed only as `*{input}*`.** Used by "Anything aimed at production". Sound for deny and ask, dangerous for allow, which this tool never writes.
- **`/path` in user settings means `~/.claude/path`.** The generator writes project-relative paths without the slash there, and warns.
- **Read deny blocks edits too; `Write(path)`, `Grep(path)` and `Glob(path)` match nothing.** Use `Read` and `Edit` only.
- **Native Windows has no sandbox.** The generator never writes the sandbox block there.
- **The hook strips `sudo` to see the command behind it,** so a pattern like `sudo *` never matches in the hook. The sudo check is a regex on the command as written.
- **A regex hook check on raw text fires on mentions** (`echo "use sudo"`, `grep "DROP TABLE"`). Limit it with the `program` field or anchor it to the start of the command.
- **Line endings.** The working tree on Windows has CRLF. Scripted find-and-replace with `\n` in the search string fails silently; use an editor.
- **The hook file is `.cjs`** so it runs as CommonJS even in a project whose `package.json` says `"type": "module"`.
- **`deny-guard.cjs` cannot be imported by Vite in the browser** as a module. The page imports it with `?raw` and `loadGuard()` evaluates the text.

## Questions the owner has not answered

These were raised during the build and are still open. Each one has a default that is currently in effect.

1. **Should recursive deletes inside the OS temp folder be allowed by the hook?** Currently yes, because Claude often cleans up scratch folders there. Asked after phase 4; no answer.
2. **Should the transcripts in `refrences/` stay in the repo?** They were committed with everything else. Asked after the first commit; no answer. Related: the folder name is misspelled (`refrences`). Renaming it is trivial but was left alone because the owner created it.
3. **Should the generator's own default match the page?** The page starts in rules-only mode. The `generate()` function still defaults to hook-on when `env.hook` is omitted, to avoid changing existing tests. Raised in pull request 3; no answer.
4. **Claude Code only, or other agents too?** `PLAN.md` section 10 recommends Claude Code only for now. Never confirmed.
5. **How deep should command parsing go?** Section 10 recommends handling the documented bypass forms and pointing to destructive_command_guard beyond that. That is what was built. Never confirmed.
6. **Shareable links: selections only, never typed paths?** Section 10 recommends this. Never confirmed, and not built.
7. **Is the `autoMode` fragment wanted?** It was listed as optional and skipped.
8. **Where will the page be hosted, and under what name?** Never discussed.
9. **Is linking to destructive_command_guard from the page acceptable?** The output recommends it by name when three or more infrastructure items are selected. The owner asked for it to be referenced, but did not see this wording before it was written.
10. **Should the infrastructure items default to "ask"?** All seven do, and none is in the Essentials preset. This was a judgment call, not a request.
11. **Is CI wanted?** A workflow running `npm run typecheck` and `npm test` would take a few minutes to add.
12. **Design.** The brief said not to worry about it. The page is unstyled beyond basics. When that changes is the owner's call.

## Decisions the owner did make

- Hook script language: Node.
- The page offers "Rules only" or "Rules plus hook", defaults to rules only, labels the hook as for advanced users, and explains the difference.
- Work goes on a branch and through a pull request; the owner merges.

## Suggested next steps, in order

1. Get phase 7 merged if `main` does not have it yet (see "State of the repo").
2. Get the `claude` CLI signed in and run the live test matrix. Fix whatever it shows. This decides whether the rules half of the simulator can be trusted.
3. Get answers to the questions above, starting with 1, 2, 3 and 8.
4. Add CI and a short README.
5. Click through copy and download on the page.
6. Then the optional work: `autoMode` fragment, shareable links, design.
