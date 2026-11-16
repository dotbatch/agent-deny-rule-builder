# Handoff notes

Written 2026-11-14, updated 2026-11-15 through pull request 18. For whoever picks this up next. Read this first, then `PLAN.md` for the reasoning behind each decision.

## What this is

A static web page that builds Claude Code deny rules. A person picks what they want to protect against and which tools they use, fills in the few details only they know (secret paths, protected branches, production names), and gets settings JSON to paste, plus an optional hook script. They can also paste their existing `settings.json` and get the new rules merged into it. A "Try it" box shows whether a typed command would be stopped and by what.

All seven phases in `PLAN.md` section 8 are written, and the page is live. The rules and the hook were run in a real Claude Code session on 2026-11-14 (v2.1.215 and v2.1.325, native Windows only); results are in `PLAN.md` section 9.

## State of the repo

- **`main`** holds everything, merged through pull requests 1 to 18 on `dotbatch/agent-deny-rule-builder`. No pull requests are open.
- CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on Ubuntu and Windows for every pull request and every push to `main`.
- The page is deployed to GitHub Pages (`.github/workflows/pages.yml`) at https://dotbatch.github.io/agent-deny-rule-builder/ on every push to `main`.
- `README.md` links to the live page and documents every item, preset and limit.
- **One local branch is unmerged and was never pushed:** `font-picker` (commit `44721e3`) adds a dev-only picker for trying fonts per section. It looks like a design experiment. Keep it, merge it, or delete it; that is the owner's call.

## What shipped after phase 7

| Pull request | Change |
| :- | :- |
| 6, 7 | README, the live test script, and the note that read paths get both `Read` and `Edit` rules. |
| 8 | CI. |
| 9 | Page redesign: a sticky step bar with a live rule count, preset and protection cards, inline feedback on required fields, and a coloured verdict in "Try it". No change to the catalog, generator, hook or simulator. |
| 10 | Environment choices that cannot happen are disabled: PowerShell is offered only on native Windows, and picking native Windows turns the sandbox off. Saved state is normalised on load. |
| 11 | **Tool picker** (34 tools in six groups, in `src/catalog/tools.ts`). Rules and hook checks tagged with a tool are left out when it is not picked; presets skip items none of the picked tools use. Picking nothing means every tool. Also deeper Azure coverage, and a hook check that asks for `az` commands while the default subscription matches a production name. |
| 12 | Maven tool, and blocking reads of `~/.m2/settings.xml` and `settings-security.xml`. |
| 13 | Light and dark theme toggle that remembers the choice. |
| 14 | The "How strict" choice is shown as pros and cons cards. |
| 15 | **Merge into an existing settings file** (`src/generator/merge.ts`). Accepts a whole `settings.json` or just its `permissions` value. Only `permissions`, `hooks` and `sandbox` are touched; every other key, including `env`, is copied through unchanged and in order. Rules already present are skipped, and rules moved from ask to block are taken out of `ask`. |
| 16 | The "Merge into it" pill is tinted with the accent color. |
| 17 | The cloud credentials note explains that its rules are written whatever tools are picked, because they protect files in the home folder. |
| 18 | README "Context cost" section: `CLAUDE.md` and `.claude/rules/` files use context, permission rules and the hook do not. |

The tool picker shipped without logos and without custom tools. Both were in the original idea; see the next steps.

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

- `npm test` runs 1,089 tests in 9 files in a few seconds. An earlier version of this file said 2,016; that was wrong. The count has only grown (1,039 after pull request 11, 1,076 after 12, 1,089 after 15).
- `npm run live-test rules <empty-folder>` (or `hook`, and optionally `readers` as a third word) runs real tool calls through the signed-in `claude` CLI and compares them with the simulator. It costs roughly a dollar of usage per run and takes a few minutes.
- `npm run dev` serves the page. `.claude/launch.json` starts it on port 5391, because 5173 was taken by another project on the machine this was built on.
- `npm run build` typechecks and writes `dist/` (ignored by git).
- Node 22.14 was used. The only dependencies are `typescript`, `vitest`, `vite`, and `@types/node`.

## Layout

| Path | What it is |
| :- | :- |
| `src/catalog/schema.ts` | Types for a catalog item: rules, hook checks, gaps, test cases. Start here. |
| `src/catalog/inputs.ts` | The nine shared user inputs. |
| `src/catalog/{secrets,local,remote,infra}.ts` | The 31 items, with 337 test cases between them. |
| `src/catalog/tools.ts` | The tool picker's list, and the helpers that decide whether a tagged rule or an item applies to the picked tools. |
| `src/generator/generate.ts` | Selections + inputs + environment (including picked tools) -> `permissions.deny/ask`, `hooks`, `sandbox`, hook rules file, per-item notes, warnings. |
| `src/generator/merge.ts` | Merges generated settings into a pasted `settings.json`. |
| `src/generator/paths.ts` | Converts pasted Windows, POSIX, home and project paths into rule prefixes. |
| `src/hook/deny-guard.cjs` | The hook the user installs. Plain CommonJS, no dependencies, about 940 lines. Shipped as-is. |
| `src/simulator/simulate.ts` | Predicts what rules and hook do to one tool call. Backs the "Try it" box and the catalog proof tests. |
| `src/app/` | The page: `main.ts` (DOM), `state.ts` (state, presets, storage), `style.css` (both themes). |
| `scripts/live-test.ts` | The live test against the real CLI. Not part of `npm test`. |
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

**The limit:** the rules half is a reading of the docs, not Claude Code's matcher. If the docs and the product disagree, these tests still pass and the generated rules are still wrong. Only a live session settles that. Live runs on v2.1.215 and v2.1.325 (native Windows) found the differences listed in `PLAN.md` section 9, and the simulator was corrected for them. On v2.1.325 the core set agrees 23 of 23, with and without the hook.

## Not done

1. **Live test on macOS or Linux.** The live test has only been run on native Windows (v2.1.215 and v2.1.325), where the sandbox cannot be tested at all. Only the Essentials preset was exercised; the infrastructure items and the larger presets were not.
2. **The file-command lists are sampled.** The live probe covered about twenty commands. Others that read or write a file may or may not be held to path rules.
3. **Copy and download buttons** on the page were never clicked in testing. Neither has the merge output been pasted back into a real Claude Code session.
4. **The optional `autoMode` fragment** from `PLAN.md` section 6 is not generated. Findings on how it must work are in section 9: it is ignored in project settings, and every list must include `"$defaults"`.
5. **Shareable links.** State lives in `localStorage` only.
6. **Tool picker extras.** No logos, and no way to add a tool that is not on the list.

## Known issues and risks

- **One unexplained test stall.** The first full run after the hook was written hung and was stopped. It has not recurred in dozens of runs since. Stray worker processes are the likely cause, but an intermittent hang in the hook's tokenizer is not ruled out. A hook that hangs would stall every shell command, so if it ever recurs, treat it as serious.
- **The hook's tokenizer is hand-written.** It is not a full shell parser. Unusual quoting could be misread in either direction.
- **`"onFailure": "block"`** is written on the hook by default and needs Claude Code v2.1.295 or later. v2.1.215 accepts a settings file containing the key and runs the hook; it presumably just ignores the key, so a crashed hook there lets the call through.
- **Rule count.** Measured 2026-11-15 on Windows with Bash and PowerShell and no tool filter: Essentials 176 block and 79 ask, Team repo 250 and 115, Production access 250 and 545, Everything 287 and 565. Picking tools cuts the infrastructure numbers sharply. Essentials loaded fine in the live run; the larger presets were not tried. Rule count does not cost context (the model never sees permission rules), but load time and startup warnings with 850 rules are untested.
- **The list of file commands Claude Code holds to Read rules is sampled, not known.** `FILE_READERS` and `PS_FILE_READERS` in `simulate.ts` hold the documented ones plus those seen refused live. Anything not on the list is shown as "needs the hook", which errs on the safe side.
- **Cloud CLI prompts.** With the hook on, every `aws ... delete-*` and every `gcloud` or `az` `delete` asks, including harmless ones. The rules alone list only high-impact services.
- **The hook is evaluated in the browser with `new Function`** on its bundled source text. This will break under a strict content security policy.
- **Docs may have moved.** Everything about Claude Code behaviour was read from `code.claude.com/docs` on 2026-11-13. The memory and permissions pages were re-read on 2026-11-15 for the README's context note. Re-check before trusting a detail.

## Gotchas that cost time

- **A rule ending in `:*` means something else.** Claude Code reads it as a trailing ` *`. `PowerShell(Get-ChildItem Env:*)` would match `Env *`, not `Env:`. A catalog test rejects this now.
- **A literal `*` cannot be written in a pattern.** `Bash(rm -rf *)` matches every recursive delete. Glob targets are left to the hook.
- **A leading `*` is allowed only as `*{input}*`.** Used by "Anything aimed at production". Sound for deny and ask, dangerous for allow, which this tool never writes.
- **`/path` in user settings means `~/.claude/path`.** The generator writes project-relative paths without the slash there, and warns.
- **A Read rule blocks the Edit tool but not a shell write; `Write(path)`, `Grep(path)` and `Glob(path)` match nothing.** `echo x > file` is stopped only by an Edit rule, so the generator writes both for every "read" path. Use `Read` and `Edit` only.
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
8. ~~**Where will the page be hosted, and under what name?**~~ Answered: GitHub Pages, at https://dotbatch.github.io/agent-deny-rule-builder/.
9. **Is linking to destructive_command_guard from the page acceptable?** The output recommends it by name when three or more infrastructure items are selected. The owner asked for it to be referenced, but did not see this wording before it was written.
10. **Should the infrastructure items default to "ask"?** All seven do, and none is in the Essentials preset. This was a judgment call, not a request.
11. ~~**Is CI wanted?**~~ Answered: yes. Added in `.github/workflows/ci.yml`.
12. ~~**Design.**~~ Answered: the owner asked for it. The page was redesigned in pull request 9 and gained a theme toggle in 13. The unmerged `font-picker` branch suggests font choices are still open.

## Decisions the owner did make

- Hook script language: Node.
- The page offers "Rules only" or "Rules plus hook", defaults to rules only, labels the hook as for advanced users, and explains the difference.
- Work goes on a branch and through a pull request; the owner merges.
- A tool picker on the page, so people get rules only for the tools they use.
- Pasted settings files are merged into, not replaced.
- No context meter on the page. The generated rules always add zero context, so a meter would never move. Decided 2026-11-15.

## Suggested next steps, in order

1. Run the live test on macOS or Linux, with the sandbox on.
2. Run it with the larger presets, which include the infrastructure items.
3. Get answers to the questions above, starting with 1, 2 and 3.
4. ~~Add CI and a short README.~~ Done.
5. Click through copy, download and merge on the page, and load a merged file in Claude Code.
6. Decide what to do with the `font-picker` branch.
7. Then the optional work: `autoMode` fragment, shareable links.
8. **Tool picker extras.** The picker shipped in pull request 11. Still open from the original idea: a logo beside each tool, and letting people add their own tools with their own commands and paths.
