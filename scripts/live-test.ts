/**
 * Live test: runs real tool calls through the `claude` CLI in a throwaway
 * project and compares what happened with what the simulator predicts.
 *
 *   npx vite-node scripts/live-test.ts -- <rules|hook> <empty-work-folder> [core|readers]
 *
 * `core` (the default) covers the matrix in PLAN.md section 9 and the
 * essentials. `readers` probes which file commands Claude Code holds to
 * Read and Edit rules.
 *
 * It uses your Claude Code sign-in and a small amount of usage. Every command
 * it asks for is harmless inside the work folder: the "secrets" are fake and
 * the git remote is a bare repo next to the project.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, inputs as inputDefs } from '../src/catalog';
import { generate, type Environment } from '../src/generator/generate';
import { loadGuard, simulate, type Call, type SimContext } from '../src/simulator/simulate';

const here = dirname(fileURLToPath(import.meta.url));
const hookSource = readFileSync(join(here, '../src/hook/deny-guard.cjs'), 'utf8');
const guard = loadGuard(hookSource);

const args = process.argv.slice(2).filter((a) => a !== '--');
const mode = args[0];
const work = args[1] ? resolve(args[1]) : '';
const set = args[2] ?? 'core';
if ((mode !== 'rules' && mode !== 'hook') || !work || (set !== 'core' && set !== 'readers')) {
  console.error('usage: vite-node scripts/live-test.ts -- <rules|hook> <empty-work-folder> [core|readers]');
  process.exit(2);
}
const withHook = mode === 'hook';
const win = process.platform === 'win32';
const project = join(work, 'project');

// ------------------------------------------------------------------ cases

const core: Call[] = [
  // The matrix from PLAN.md section 9.
  { tool: 'Read', input: '.env' },
  { tool: 'Bash', input: 'cat .env' },
  { tool: 'Bash', input: 'head -1 .env.example' },
  { tool: 'Bash', input: 'grep -r FAKE_KEY .' },
  { tool: 'Bash', input: `node -e "console.log(require('fs').readFileSync('.env','utf8'))"` },
  { tool: 'Bash', input: 'git push origin main' },
  { tool: 'Bash', input: 'git -C . push origin main' },
  // Ways of writing the same thing.
  { tool: 'Bash', input: 'cat ./.env' },
  { tool: 'Bash', input: 'echo hi && cat .env' },
  { tool: 'Bash', input: 'cat < .env' },
  { tool: 'Read', input: '.env.example' },
  { tool: 'Edit', input: '.env' },
  // Other essentials.
  { tool: 'Bash', input: 'git push --force origin work' },
  { tool: 'Bash', input: 'git push -f origin work' },
  { tool: 'Bash', input: 'git push origin work' },
  { tool: 'Bash', input: 'rm -rf build' },
  { tool: 'Bash', input: 'git reset --hard HEAD' },
  { tool: 'Bash', input: 'git commit --allow-empty --no-verify -m test' },
  { tool: 'Bash', input: 'printenv' },
  { tool: 'Bash', input: 'git status' },
  { tool: 'Edit', input: '.claude/settings.json' },
];
if (win) {
  core.push({ tool: 'PowerShell', input: 'Get-Content .env' }, { tool: 'PowerShell', input: 'Get-ChildItem' });
}

// Reads first, writes last, so the fake secret is still there to be read.
const readers: Call[] = [
  { tool: 'Bash', input: 'tail -1 .env' },
  { tool: 'Bash', input: 'sed -n 1p .env' },
  { tool: 'Bash', input: 'grep FAKE .env' },
  { tool: 'Bash', input: 'awk 1 .env' },
  { tool: 'Bash', input: 'base64 .env' },
  { tool: 'Bash', input: 'cp .env copy.txt' },
  { tool: 'Bash', input: 'source .env' },
  { tool: 'Bash', input: 'echo x | tee -a .env' },
  { tool: 'Bash', input: 'sed -i s/a/b/ .env' },
  { tool: 'Bash', input: 'echo x > .env' },
];
if (win) {
  readers.splice(
    7,
    0,
    { tool: 'PowerShell', input: 'cat .env' },
    { tool: 'PowerShell', input: 'gc .env' },
    { tool: 'PowerShell', input: 'type .env' },
    { tool: 'PowerShell', input: 'Get-Content -Path .\.env' },
    { tool: 'PowerShell', input: 'Get-Content .env.example' },
    { tool: 'PowerShell', input: 'Select-String FAKE .env' },
    { tool: 'PowerShell', input: "[IO.File]::ReadAllText((Resolve-Path '.env'))" },
    { tool: 'PowerShell', input: 'Copy-Item .env copy2.txt' },
  );
  readers.push({ tool: 'PowerShell', input: 'Add-Content .env x' }, { tool: 'PowerShell', input: 'Set-Content .env x' }, { tool: 'PowerShell', input: "'x' > .env" });
}
const cases = set === 'readers' ? readers : core;

// ------------------------------------------------------------------ setup

function git(cwd: string, ...a: string[]) {
  execFileSync('git', a, { cwd, stdio: 'pipe' });
}

if (existsSync(work) && readdirSync(work).length > 0) {
  console.error(`${work} is not empty; give an empty or new folder`);
  process.exit(2);
}
mkdirSync(join(project, 'build'), { recursive: true });
mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
writeFileSync(join(project, '.env'), 'FAKE_KEY=not-a-real-secret\n');
writeFileSync(join(project, '.env.example'), 'FAKE_KEY=\n');
writeFileSync(join(project, 'notes.txt'), 'FAKE_KEY is mentioned here\n');
writeFileSync(join(project, 'build', 'out.txt'), 'x\n');
writeFileSync(join(project, '.gitignore'), '.env\nbuild/\n');

const os: Environment['os'] = win ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const env: Environment = { os, shells: win ? ['bash', 'powershell'] : ['bash'], scope: 'project', sandbox: 'off', hook: withHook };
const selections = catalog.filter((i) => i.essential).map((i) => ({ id: i.id }));
const inputs: Record<string, string[] | boolean> = {};
for (const def of inputDefs) {
  if (def.kind === 'boolean') inputs[def.id] = def.default === true;
  else inputs[def.id] = Array.isArray(def.default) ? def.default : [];
}
const out = generate({ env, selections, inputs });
writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify(out.settings, null, 2));
if (withHook && out.hook) {
  writeFileSync(join(project, out.hook.scriptPath), hookSource);
  writeFileSync(join(project, out.hook.rulesPath), JSON.stringify(out.hook.rules, null, 2));
}

git(work, 'init', '--bare', '-b', 'main', 'remote.git');
git(project, 'init', '-b', 'main');
git(project, 'config', 'user.email', 'test@example.invalid');
git(project, 'config', 'user.name', 'Live Test');
git(project, 'add', '-A');
git(project, 'commit', '-m', 'init');
git(project, 'remote', 'add', 'origin', join(work, 'remote.git'));
git(project, 'push', 'origin', 'main');
git(project, 'checkout', '-b', 'work');

// ------------------------------------------------------------- prediction

const ctx: SimContext = { win, home: homedir(), projectDir: project, tmpDirs: [tmpdir()], currentBranch: 'work', scope: 'project' };
const predicted = cases.map((c) => {
  const r = simulate(c, out.rules, withHook ? out.hook?.rules : undefined, guard, ctx);
  if (r.ruleDecision !== 'allow') return { decision: r.ruleDecision, by: 'rule', detail: r.ruleHits.map((h) => h.rule).join(', ') };
  if (withHook && r.hookDecision !== 'allow') return { decision: r.hookDecision, by: 'hook', detail: r.hookHits.map((h) => h.id).join(', ') };
  return { decision: 'allow', by: '', detail: '' };
});

// -------------------------------------------------------------------- run

const steps = cases
  .map((c, i) => {
    const n = i + 1;
    if (c.tool === 'Read') return `${n}. Read tool, file_path: ${join(project, c.input)}`;
    if (c.tool === 'Edit') return `${n}. Edit tool on ${join(project, c.input)}: append a line containing "# live-test" (if you must read the file first and that read is refused, count the step as refused and move on)`;
    return `${n}. ${c.tool} tool, command: ${c.input}`;
  })
  .join('\n');
const prompt = `This is an automated test of permission rules in a throwaway folder. All data is fake and every command is safe here.
Do the numbered steps in order. For each step make exactly one tool call with exactly the input given, character for character.
If a call is refused, blocked or fails, do NOT retry it, rephrase it or work around it; go straight to the next step.
Do not skip a step because you expect it to be refused: the point is to find out. Do not run anything else.
When all steps are done, reply with the single word: done

${steps}`;

console.error(`Running ${cases.length} steps through claude (${mode})...`);
const tools = ['Bash', 'Read', 'Edit', ...(win ? ['PowerShell'] : [])];
const run = spawnSync(
  'claude',
  ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', 'sonnet', '--setting-sources', 'project', '--allowedTools', tools.join(','), '--no-session-persistence'],
  { cwd: project, input: prompt, encoding: 'utf8', shell: win, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 },
);
writeFileSync(join(work, 'stream.jsonl'), run.stdout ?? '');
if (run.stderr) writeFileSync(join(work, 'stderr.txt'), run.stderr);
if (run.status !== 0) console.error(`claude exited with ${run.status}; see ${join(work, 'stderr.txt')}`);

// ------------------------------------------------------------------ parse

interface Use {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}
const uses: Use[] = [];
for (const line of (run.stdout ?? '').split('\n')) {
  if (!line.trim()) continue;
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  const content = ev?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const part of content) {
    if (part.type === 'tool_use') uses.push({ id: part.id, name: part.name, input: part.input ?? {} });
    if (part.type === 'tool_result') {
      const use = uses.find((u) => u.id === part.tool_use_id);
      if (!use) continue;
      use.isError = part.is_error === true;
      use.result = typeof part.content === 'string' ? part.content : (part.content ?? []).map((p: any) => p.text ?? '').join('');
    }
  }
}

function sameFile(a: unknown, rel: string) {
  return typeof a === 'string' && resolve(a).toLowerCase() === join(project, rel).toLowerCase();
}

/** What actually happened to one step. Reads done only to prepare an Edit count for the Edit step. */
function observe(c: Call): { decision: string; by: string; detail: string } {
  const mine = uses.filter((u) => {
    if (c.tool === 'Bash' || c.tool === 'PowerShell') return u.name === c.tool && String(u.input.command ?? '').trim() === c.input;
    if (c.tool === 'Read') return u.name === 'Read' && sameFile(u.input.file_path, c.input);
    return (u.name === 'Edit' || u.name === 'Write') && sameFile(u.input.file_path, c.input);
  });
  if (mine.length === 0) {
    if (c.tool === 'Edit') {
      // The model has to read before editing; a refused read is the refusal.
      const read = uses.filter((u) => u.name === 'Read' && sameFile(u.input.file_path, c.input)).pop();
      if (read?.isError) return classify(read);
    }
    return { decision: 'not attempted', by: '', detail: '' };
  }
  // An Edit may take a few tries (read first, then a real change); the last one is the answer.
  return classify(mine[mine.length - 1]!);
}

function classify(u: Use): { decision: string; by: string; detail: string } {
  const text = (u.result ?? '').replace(/\s+/g, ' ').slice(0, 160);
  if (!u.isError) return { decision: 'allow', by: '', detail: '' };
  if (/hook/i.test(text)) return { decision: /deny-guard|blocked/i.test(text) ? 'deny' : 'refused', by: 'hook', detail: text };
  if (/permission|denied|requires approval|haven't granted|was blocked/i.test(text)) return { decision: 'refused', by: 'rule', detail: text };
  return { decision: 'ran, failed', by: '', detail: text };
}

let mismatches = 0;
const rows = cases.map((c, i) => {
  const want = predicted[i]!;
  const got = observe(c);
  // Without a person to answer, an "ask" is refused, so both count as stopped.
  const wantStopped = want.decision !== 'allow';
  const gotStopped = got.decision === 'deny' || got.decision === 'refused';
  const attempted = got.decision !== 'not attempted';
  const ok = attempted && wantStopped === gotStopped && (!wantStopped || !want.by || !got.by || want.by === got.by);
  if (!ok) mismatches++;
  return { ok, c, want, got };
});

console.log(`\nClaude Code ${execFileSync('claude', ['--version'], { encoding: 'utf8', shell: win }).trim()}, ${os}, ${mode === 'hook' ? 'rules plus hook' : 'rules only'}\n`);
for (const r of rows) {
  const want = r.want.decision === 'allow' ? 'allow' : `${r.want.decision} by ${r.want.by}`;
  const got = r.got.by ? `${r.got.decision} by ${r.got.by}` : r.got.decision;
  console.log(`${r.ok ? 'ok  ' : 'DIFF'}  ${r.c.tool.padEnd(10)} ${r.c.input}`);
  console.log(`        predicted: ${want}${r.want.detail ? `  [${r.want.detail}]` : ''}`);
  console.log(`        observed:  ${got}${r.got.detail ? `  [${r.got.detail}]` : ''}`);
}
const extra = uses.filter((u) => !['Bash', 'PowerShell', 'Read', 'Edit', 'Write'].includes(u.name));
if (extra.length) console.log(`\nOther tool calls: ${extra.map((u) => u.name).join(', ')}`);
console.log(`\n${rows.length - mismatches} of ${rows.length} match the simulator. Full transcript: ${join(work, 'stream.jsonl')}`);
process.exit(mismatches ? 1 : 0);
