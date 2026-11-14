#!/usr/bin/env node
'use strict';
/**
 * deny-guard: a Claude Code PreToolUse hook for the Bash and PowerShell tools.
 *
 * Reads the tool call as JSON on stdin and the rules from
 * `deny-guard.rules.json` next to this file. Exits 2 with a reason on stderr
 * to block, prints an "ask" decision to force a prompt, or exits 0 silently.
 *
 * It exists because permission rules match command text as written. This
 * script takes the command apart first (compound commands, wrappers such as
 * sudo, `bash -c`, absolute program paths, `git -C`), then checks each piece.
 *
 * No dependencies. Any internal error blocks the call rather than letting it
 * through.
 */

const MAX_COMMAND_CHARS = 50000;
const MAX_DEPTH = 6;

// ------------------------------------------------------------- tokenizer

/** Index of the `)` matching the `(` at `open`, skipping quoted text. -1 if unbalanced. */
function findClose(text, open, ps) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (!ps && c === '\\') i++;
    else if (ps && c === '`') i++;
    else if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if ((!ps && text[j] === '\\') || (ps && text[j] === '`')) j++;
        j++;
      }
      i = j;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Splits shell text into words and operators.
 * Words: { t:'w', v: unquoted value, q: any part was quoted, s, e }
 * Operators: { t:'op', v } for separators, { t:'r', v } for redirects,
 * { t:'h', v: body } for a heredoc body.
 * `subs` collects the text of every command substitution found.
 */
function tokenize(text, ps) {
  const tokens = [];
  const subs = [];
  const pendingHeredocs = [];
  let word = null;
  const start = (i) => (word = word || { t: 'w', v: '', q: false, s: i, e: i });
  const end = (i) => {
    if (word) {
      word.e = i;
      tokens.push(word);
      word = null;
    }
  };
  const captureParen = (i, openIdx) => {
    const close = findClose(text, openIdx, ps);
    const stop = close < 0 ? text.length : close;
    subs.push(text.slice(openIdx + 1, stop));
    start(i).v += text.slice(i, stop + 1);
    return stop;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '\n') {
      end(i);
      tokens.push({ t: 'op', v: ';', s: i, e: i + 1 });
      while (pendingHeredocs.length > 0) {
        const { delim, strip } = pendingHeredocs.shift();
        const lines = [];
        let j = i + 1;
        for (;;) {
          let k = text.indexOf('\n', j);
          if (k < 0) k = text.length;
          const line = text.slice(j, k);
          j = k + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim || k >= text.length) {
            if (k >= text.length && line !== delim) lines.push(line);
            break;
          }
          lines.push(line);
        }
        tokens.push({ t: 'h', v: lines.join('\n'), s: i, e: i });
        i = Math.min(j - 1, text.length - 1);
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      end(i);
      continue;
    }
    if (c === '#' && !word) {
      const k = text.indexOf('\n', i);
      i = (k < 0 ? text.length : k) - 1;
      continue;
    }
    if (!ps && c === '\\') {
      if (next === '\n') i++;
      else if (next !== undefined) {
        start(i).v += next;
        word.q = true;
        i++;
      }
      continue;
    }
    if (ps && c === '`') {
      if (next !== undefined) {
        start(i).v += next;
        i++;
      }
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = '';
      for (; j < text.length; j++) {
        if (text[j] === "'") {
          if (ps && text[j + 1] === "'") {
            v += "'";
            j++;
          } else break;
        } else v += text[j];
      }
      start(i).v += v;
      word.q = true;
      i = j;
      continue;
    }
    if (c === '"') {
      start(i).q = true;
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j];
        if (!ps && d === '\\' && j + 1 < text.length) {
          word.v += text[++j];
        } else if (ps && d === '`' && j + 1 < text.length) {
          word.v += text[++j];
        } else if (d === '$' && text[j + 1] === '(') {
          const close = findClose(text, j + 1, ps);
          const stop = close < 0 ? text.length : close;
          subs.push(text.slice(j + 2, stop));
          word.v += text.slice(j, stop + 1);
          j = stop;
        } else if (!ps && d === '`') {
          const k = text.indexOf('`', j + 1);
          const stop = k < 0 ? text.length : k;
          subs.push(text.slice(j + 1, stop));
          word.v += text.slice(j, stop + 1);
          j = stop;
        } else word.v += d;
      }
      i = j;
      continue;
    }
    if (c === '$' && next === '(') {
      i = captureParen(i, i + 1);
      continue;
    }
    if (!ps && (c === '<' || c === '>') && next === '(') {
      i = captureParen(i, i + 1);
      continue;
    }
    if (!ps && c === '`') {
      const k = text.indexOf('`', i + 1);
      const stop = k < 0 ? text.length : k;
      subs.push(text.slice(i + 1, stop));
      start(i).v += text.slice(i, stop + 1);
      i = stop;
      continue;
    }

    // Redirects. A word made only of digits right before one is a file descriptor.
    if (c === '>' || c === '<' || (c === '&' && next === '>')) {
      if (word && /^\d+$/.test(word.v) && !word.q) word = null;
      else end(i);
      let j = c === '&' ? i + 1 : i;
      const kind = text[j];
      let op = kind;
      j++;
      if (kind === '<' && text.startsWith('<<', j)) {
        op = '<<<';
        j += 2;
      } else if (kind === '<' && text[j] === '<') {
        j++;
        const strip = text[j] === '-';
        if (strip) j++;
        while (text[j] === ' ' || text[j] === '\t') j++;
        let delim = '';
        const quote = text[j] === "'" || text[j] === '"' ? text[j++] : null;
        while (j < text.length && (quote ? text[j] !== quote : /[^\s;&|<>()]/.test(text[j]))) {
          if (!quote && text[j] === '\\') j++;
          delim += text[j++];
        }
        if (quote) j++;
        pendingHeredocs.push({ delim, strip });
        i = j - 1;
        continue;
      } else if (text[j] === '>' || text[j] === '|') j++;
      if (text[j] === '&') {
        // >&2, 2>&1, <&3, >&- duplicate a descriptor and name no file.
        const m = /^&(\d+|-)/.exec(text.slice(j));
        if (m) {
          i = j + m[0].length - 1;
          continue;
        }
        j++;
      }
      tokens.push({ t: 'r', v: op, s: i, e: j });
      i = j - 1;
      continue;
    }

    const two = c + (next || '');
    if (two === '&&' || two === '||' || two === '|&' || two === ';;') {
      end(i);
      tokens.push({ t: 'op', v: two, s: i, e: i + 2 });
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '(' || c === ')' || (c === '&' && !ps) || (c === '&' && ps && word)) {
      end(i);
      tokens.push({ t: 'op', v: c, s: i, e: i + 1 });
      continue;
    }
    start(i).v += c;
  }
  end(text.length);
  return { tokens, subs };
}

/** Groups tokens into simple commands. */
function parseCommands(text, ps) {
  const { tokens, subs } = tokenize(text, ps);
  const commands = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.words.length > 0 || cur.redirects.length > 0)) {
      cur.raw = text.slice(cur.s, cur.e);
      commands.push(cur);
    }
    cur = null;
  };
  let pendingRedirect = null;
  for (const tok of tokens) {
    if (tok.t === 'op') {
      pendingRedirect = null;
      flush();
      continue;
    }
    if (tok.t === 'h') {
      const target = cur || commands[commands.length - 1];
      if (target) target.heredocs.push(tok.v);
      continue;
    }
    cur = cur || { words: [], redirects: [], heredocs: [], s: tok.s, e: tok.e, raw: '' };
    cur.e = Math.max(cur.e, tok.e);
    if (tok.t === 'r') {
      pendingRedirect = tok.v;
    } else if (pendingRedirect) {
      cur.redirects.push({ op: pendingRedirect, target: tok.v });
      pendingRedirect = null;
    } else {
      cur.words.push({ v: tok.v, q: tok.q });
    }
  }
  flush();
  return { commands, subs };
}

// ------------------------------------------------------------ normalizer

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', '!', '{', '}', 'function']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const INTERPRETERS = /^(python[\d.]*|node|nodejs|deno|bun|ruby|perl|php|pwsh|powershell|osascript|lua)$/;

/** Wrappers that run their arguments as a command. Value = flags that take a separate argument. */
const WRAPPERS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '--user', '--group'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '--unset', '--chdir'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'],
  nohup: [],
  time: [],
  stdbuf: [],
  command: [],
  builtin: [],
  exec: ['-a'],
  setsid: [],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter'],
  watch: ['-n', '--interval'],
  noglob: [],
};

const PS_ALIASES = {
  gci: 'Get-ChildItem', ls: 'Get-ChildItem', dir: 'Get-ChildItem',
  gi: 'Get-Item',
  rm: 'Remove-Item', del: 'Remove-Item', erase: 'Remove-Item', rd: 'Remove-Item', ri: 'Remove-Item', rmdir: 'Remove-Item',
  cat: 'Get-Content', gc: 'Get-Content', type: 'Get-Content',
  iwr: 'Invoke-WebRequest', curl: 'Invoke-WebRequest', wget: 'Invoke-WebRequest',
  irm: 'Invoke-RestMethod',
  h: 'Get-History', history: 'Get-History', ghy: 'Get-History',
  cd: 'Set-Location', sl: 'Set-Location', chdir: 'Set-Location',
  mv: 'Move-Item', move: 'Move-Item', mi: 'Move-Item',
  cp: 'Copy-Item', copy: 'Copy-Item', cpi: 'Copy-Item',
  ren: 'Rename-Item', rni: 'Rename-Item',
  sc: 'Set-Content', ac: 'Add-Content', clc: 'Clear-Content', ni: 'New-Item',
  iex: 'Invoke-Expression',
};

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const GIT_BARE_OPTS = /^(--no-pager|--paginate|-p|-P|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks|--git-dir=.*|--work-tree=.*|--namespace=.*|--exec-path(=.*)?|--config-env=.*)$/;

function basename(program) {
  return program.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|com)$/i, '');
}

function isFlag(w) {
  return !w.q && w.v.length > 1 && w.v[0] === '-';
}

/** Is `flag` present? Understands `--flag=value`, clustered short flags, and PowerShell prefixes. */
function hasFlag(args, flag, ps) {
  for (const w of args) {
    if (w.q) continue;
    if (!ps && w.v === '--') break;
    const v = w.v;
    if (ps) {
      const name = v.split(':')[0].toLowerCase();
      const f = flag.toLowerCase();
      if (name === f || (name.length >= 2 && name[0] === '-' && f.startsWith(name))) return true;
      continue;
    }
    if (v === flag || v.startsWith(flag + '=')) return true;
    if (/^-[A-Za-z]$/.test(flag) && /^-[A-Za-z]{2,}$/.test(v) && v.includes(flag[1])) return true;
  }
  return false;
}

function positionals(args) {
  const out = [];
  let rest = false;
  for (const w of args) {
    if (!rest && !w.q && w.v === '--') rest = true;
    else if (rest || !isFlag(w)) out.push(w.v);
  }
  return out;
}

/**
 * Takes text apart into units, one per simple command, including commands
 * nested in substitutions, `sh -c`, `eval`, heredocs fed to a shell, and
 * `find -exec`. Each unit carries the directory it would run in, tracked
 * through `cd`; `null` means it could not be worked out.
 */
function analyze(text, shell, state, depth, out) {
  if (depth > MAX_DEPTH) throw new Error('command nesting too deep to analyze');
  const ps = shell === 'powershell';
  const { commands, subs } = parseCommands(text, ps);
  for (const sub of subs) analyze(sub, shell, { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);

  for (const cmd of commands) {
    let words = cmd.words.slice();
    while (words.length > 0 && !words[0].q && (KEYWORDS.has(words[0].v) || (ps && words[0].v === '&'))) words.shift();
    if (!ps) while (words.length > 0 && !words[0].q && /^[A-Za-z_]\w*=/.test(words[0].v)) words.shift();

    // Peel wrappers, keeping the wrapper itself if nothing follows it (bare `env`).
    for (let guard = 0; guard < 10 && words.length > 0 && !ps; guard++) {
      const name = basename(words[0].v);
      const valueFlags = WRAPPERS[name];
      if (!valueFlags || words[0].q) break;
      if (name === 'command' && words[1] && /^-[vV]$/.test(words[1].v)) break;
      let i = 1;
      while (i < words.length) {
        const w = words[i];
        if (isFlag(w)) i += valueFlags.includes(w.v) ? 2 : 1;
        else if (name === 'env' && !w.q && /^[A-Za-z_]\w*=/.test(w.v)) i++;
        else if (name === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(w.v)) {
          i++;
          break;
        } else break;
      }
      if (i >= words.length) break;
      words = words.slice(i);
    }
    if (words.length === 0) {
      if (cmd.redirects.length > 0) {
        out.push({ raw: cmd.raw, norm: '', program: '', args: [], shell, cwd: state.cwd, redirects: cmd.redirects, inline: cmd.heredocs });
      }
      continue;
    }

    let program = basename(words[0].v);
    if (ps) program = PS_ALIASES[program.toLowerCase()] || program;
    let args = words.slice(1);
    let gitDir = null;

    if (program === 'git') {
      while (args.length > 0 && !args[0].q) {
        if (GIT_VALUE_OPTS.has(args[0].v)) {
          if (args[0].v === '-C' && args[1]) gitDir = args[1].v;
          args = args.slice(2);
        } else if (GIT_BARE_OPTS.test(args[0].v)) args = args.slice(1);
        else break;
      }
    }

    const unit = {
      raw: cmd.raw,
      norm: [program, ...args.map((w) => w.v)].join(' '),
      program,
      args,
      shell,
      cwd: state.cwd,
      gitDir,
      redirects: cmd.redirects,
      inline: cmd.heredocs,
    };
    out.push(unit);

    const lower = program.toLowerCase();
    const pos = positionals(args);

    if (lower === 'cd' || lower === 'pushd' || lower === 'set-location' || lower === 'push-location') {
      const target = pos[0];
      state.cwd = target === undefined ? state.ctx.home : resolvePath(target, state.cwd, state.ctx);
      continue;
    }

    if (SHELLS.has(lower)) {
      const c = args.findIndex((w) => !w.q && /^-[a-zA-Z]*c$/.test(w.v));
      if (c >= 0 && args[c + 1]) analyze(args[c + 1].v, 'bash', { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);
      for (const body of cmd.heredocs) analyze(body, 'bash', { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);
      for (const r of cmd.redirects) if (r.op === '<<<') analyze(r.target, 'bash', { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);
    } else if (lower === 'eval') {
      analyze(args.map((w) => w.v).join(' '), 'bash', { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);
    } else if (lower === 'powershell' || lower === 'pwsh') {
      const c = args.findIndex((w) => !w.q && /^-(c|command)$/i.test(w.v));
      if (c >= 0) analyze(args.slice(c + 1).map((w) => w.v).join(' '), 'powershell', { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);
    } else if (lower === 'cmd') {
      const c = args.findIndex((w) => /^\/[ck]$/i.test(w.v));
      if (c >= 0) analyze(args.slice(c + 1).map((w) => w.v).join(' '), 'bash', { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);
    } else if (lower === 'invoke-expression') {
      analyze(args.map((w) => w.v).join(' '), 'powershell', { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);
    } else if (lower === 'find') {
      for (let i = 0; i < args.length; i++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(args[i].v)) continue;
        let j = i + 1;
        while (j < args.length && args[j].v !== ';' && args[j].v !== '+') j++;
        const inner = args.slice(i + 1, j).map((w) => w.v).join(' ');
        if (inner) analyze(inner, 'bash', { cwd: state.cwd, ctx: state.ctx }, depth + 1, out);
        i = j;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------- paths

/** `C:\Users\x` and `C:/Users/x` become `/c/Users/x`; lowercased on Windows, where paths ignore case. */
function normPath(p, win) {
  let s = String(p).replace(/\\/g, '/');
  const m = /^([A-Za-z]):(\/|$)/.exec(s);
  if (m) s = '/' + m[1].toLowerCase() + '/' + s.slice(m[0].length);
  return win ? s.toLowerCase() : s;
}

function collapse(abs) {
  const out = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

const HOME_VARS = /\$\{HOME\}|\$HOME\b|\$env:USERPROFILE\b|\$env:HOME\b|%USERPROFILE%|\$\{env:USERPROFILE\}/gi;

/** Absolute normalized form of a path as written in a command, or null if it cannot be known. */
function resolvePath(written, cwd, ctx) {
  let s = normPath(String(written).replace(HOME_VARS, '~'), ctx.win);
  if (/[$%`]/.test(s)) return null;
  if (s === '~' || s.startsWith('~/')) return collapse(ctx.home + s.slice(1));
  if (s.startsWith('/')) return collapse(s);
  if (cwd == null) return null;
  return collapse(cwd + '/' + s);
}

function inside(child, parent) {
  if (parent === '/') return child !== '/';
  return child.startsWith(parent + '/');
}

function globToRegExp(glob, win) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', win ? 'i' : '');
}

/** Path-looking strings in a piece of command text, including inside inline scripts. */
function pathCandidates(text) {
  const cleaned = String(text).replace(HOME_VARS, '~');
  return cleaned.match(/[^\s'"`()<>|;,=&]+/g) || [];
}

function describeCandidate(written, cwd, ctx) {
  const rel = normPath(written, ctx.win).replace(/\/+$/, '');
  const abs = resolvePath(written, cwd, ctx);
  const under = (root) => (abs == null ? undefined : abs === root ? '' : inside(abs, root) ? abs.slice(root === '/' ? 1 : root.length + 1) : undefined);
  return { rel, abs, homeRel: under(ctx.home), projRel: under(ctx.projectDir) };
}

function matchTarget(target, glob, win) {
  if (target == null) return false;
  const g = win ? glob.toLowerCase() : glob;
  const re = globToRegExp(g, win);
  if (re.test(target)) return true;
  const prefix = g.endsWith('/**') && !/[*?]/.test(g.slice(0, -3)) ? g.slice(0, -3) : null;
  // The folder itself, e.g. `tar czf x ~/.ssh`.
  if (prefix !== null && target === prefix) return true;
  const w = target.search(/[*?]/);
  if (w >= 0) {
    // A wildcard in the command: `cat secrets/*` or `cat .env*`.
    const dir = target.slice(0, Math.max(0, target.lastIndexOf('/', w)));
    if (dir && (re.test(dir + '/x') || dir === prefix)) return true;
    if (!/[*?]/.test(g) && globToRegExp(target, win).test(g)) return true;
  }
  return false;
}

function candidateHits(cand, spec, except, ctx) {
  const name = cand.rel.slice(cand.rel.lastIndexOf('/') + 1);
  if (except.some((x) => (ctx.win ? x.toLowerCase() : x) === name)) return false;
  switch (spec.anchor) {
    case 'home':
      return matchTarget(cand.homeRel, spec.glob, ctx.win);
    case 'project':
      return matchTarget(cand.projRel, spec.glob, ctx.win);
    case 'absolute':
      return cand.abs != null && matchTarget(cand.abs.slice(1), spec.glob, ctx.win);
    case 'anywhere': {
      const segs = (cand.abs || cand.rel).split('/').filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        if (matchTarget(segs.slice(i).join('/'), spec.glob, ctx.win)) return true;
        if (!spec.glob.includes('/')) break;
      }
      return false;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------- checks

/** Permission-rule wildcard matching: `*` is any text, and a lone trailing ` *` also matches the bare command. */
function matchPattern(pattern, text, ci) {
  let p = pattern.endsWith(':*') ? pattern.slice(0, -2) + ' *' : pattern;
  let t = text;
  if (ci) {
    p = p.toLowerCase();
    t = t.toLowerCase();
  }
  if (p.endsWith(' *') && p.indexOf('*') === p.length - 1) {
    const prefix = p.slice(0, -2);
    return t === prefix || t.startsWith(prefix + ' ');
  }
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
  return re.test(t);
}

const ALL_ARG_WRITERS = new Set([
  'rm', 'mv', 'tee', 'touch', 'chmod', 'chown', 'chgrp', 'truncate', 'unlink', 'shred', 'rmdir', 'mkdir',
  'remove-item', 'set-content', 'add-content', 'out-file', 'clear-content', 'move-item', 'rename-item', 'new-item',
]);
const LAST_ARG_WRITERS = new Set(['cp', 'install', 'ln', 'rsync', 'scp', 'copy-item']);
const WRITE_HINT = /write|unlink|remove|rename|rmSync|rmtree|truncate|appendFile|chmod|open\([^)]*,\s*['"][wax+]/i;

/** Strings in this unit that name something it would write to. */
function writeTargets(unit) {
  const out = unit.redirects.filter((r) => r.op === '>').map((r) => r.target);
  const lower = unit.program.toLowerCase();
  const pos = positionals(unit.args);
  if (ALL_ARG_WRITERS.has(lower)) out.push(...pos);
  else if (LAST_ARG_WRITERS.has(lower) && pos.length > 0) out.push(pos[pos.length - 1]);
  else if (lower === 'sed' && unit.args.some((w) => !w.q && /^(-[a-zA-Z]*i|--in-place)/.test(w.v))) out.push(...pos);
  else if (lower === 'dd') out.push(...unit.args.filter((w) => w.v.startsWith('of=')).map((w) => w.v.slice(3)));
  else if (lower === 'git' && /^(rm|mv|checkout|restore|clean)$/.test(pos[0] || '')) out.push(...pos.slice(1));
  else if (INTERPRETERS.test(lower) && WRITE_HINT.test(unit.raw)) out.push(...pathCandidates(unit.raw));
  return out.flatMap(pathCandidates);
}

function checkTouchesPath(check, unit, ctx) {
  const written =
    check.access === 'write'
      ? writeTargets(unit)
      : [...pathCandidates(unit.raw), ...unit.inline.flatMap(pathCandidates), ...unit.redirects.map((r) => r.target)];
  const except = check.except || [];
  for (const w of written) {
    const cand = describeCandidate(w, unit.cwd, ctx);
    if (check.paths.some((spec) => candidateHits(cand, spec, except, ctx))) return true;
  }
  return false;
}

function checkArgv(check, unit) {
  const programs = Array.isArray(check.program) ? check.program : [check.program];
  const ps = unit.shell === 'powershell';
  if (!programs.some((p) => p.toLowerCase() === unit.program.toLowerCase())) return false;
  const pos = positionals(unit.args);
  const sub = check.sub || [];
  if (!sub.every((s, i) => pos[i] === s)) return false;
  if (check.flagsNone && check.flagsNone.some((f) => hasFlag(unit.args, f, ps))) return false;
  if (check.flagsAny && !check.flagsAny.some((f) => hasFlag(unit.args, f, ps))) return false;
  return true;
}

function checkMentionsDomain(check, unit) {
  const text = [unit.raw, ...unit.inline].join('\n').toLowerCase();
  return check.domains.some((d) => {
    const host = d.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![a-z0-9-])(?:[a-z0-9-]+\\.)*' + host + '(?![a-z0-9-]|\\.[a-z0-9])').test(text);
  });
}

/** Paths a recursive delete is aimed at, or null if this unit is not one. */
function recursiveDeleteTargets(unit) {
  const lower = unit.program.toLowerCase();
  const ps = unit.shell === 'powershell';
  if (lower === 'rm' && (hasFlag(unit.args, '-r', false) || hasFlag(unit.args, '-R', false) || hasFlag(unit.args, '--recursive', false))) {
    return positionals(unit.args);
  }
  if (lower === 'find') {
    const acts = unit.args.some((w, i) => w.v === '-delete' || (/^-(exec|execdir|ok)$/.test(w.v) && /(^|\/)(rm|shred)$/.test((unit.args[i + 1] || {}).v || '')));
    if (!acts) return null;
    const roots = [];
    for (const w of unit.args) {
      if (isFlag(w) || w.v === '(' || w.v === '!') break;
      roots.push(w.v);
    }
    return roots.length > 0 ? roots : ['.'];
  }
  if (lower === 'remove-item' || ((lower === 'rd' || lower === 'rmdir' || lower === 'del' || lower === 'erase') && !ps)) {
    const recursive = hasFlag(unit.args, '-Recurse', true) || unit.args.some((w) => /^\/s$/i.test(w.v));
    if (!recursive) return null;
    const out = [];
    for (let i = 0; i < unit.args.length; i++) {
      const w = unit.args[i];
      if (/^\/[a-z]$/i.test(w.v)) continue;
      if (isFlag(w)) {
        if (/^-(path|literalpath|include|exclude|filter)$/i.test(w.v)) i += /^-(path|literalpath)$/i.test(w.v) ? 0 : 1;
        continue;
      }
      out.push(...w.v.split(',').map((s) => s.trim()).filter(Boolean));
    }
    return out;
  }
  return null;
}

function checkRecursiveDelete(unit, ctx) {
  const targets = recursiveDeleteTargets(unit);
  if (!targets) return null;
  if (targets.length === 0) return 'no target could be read from the command';
  for (const written of targets) {
    let t = String(written).replace(HOME_VARS, '~').replace(/\\/g, '/');
    const w = t.search(/[*?]/);
    // `dir/*` empties `dir`; judge the folder being emptied.
    if (w >= 0) t = t.slice(0, Math.max(0, t.lastIndexOf('/', w))) || (t.startsWith('/') ? '/' : '.');
    const abs = resolvePath(t, unit.cwd, ctx);
    if (abs == null) return `the target "${written}" cannot be resolved ahead of time`;
    if (abs === '/' || (ctx.win && /^\/[a-z]$/.test(abs))) return `"${written}" is the filesystem root`;
    if (abs === ctx.home || inside(ctx.home, abs)) return `"${written}" is your home folder or contains it`;
    if (abs === ctx.projectDir || inside(ctx.projectDir, abs)) return `"${written}" is the project folder or contains it`;
    if (inside(abs, ctx.projectDir)) continue;
    if (ctx.tmpDirs.some((tmp) => inside(abs, tmp))) continue;
    return `"${written}" is outside the project`;
  }
  return null;
}

const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec', '--recurse-submodules']);

function gitBranch(unit, ctx) {
  const dir = unit.gitDir ? resolvePath(unit.gitDir, unit.cwd, ctx) : unit.cwd;
  return ctx.currentBranch(dir);
}

function checkPushProtected(unit, ctx, protectedBranches) {
  if (unit.program !== 'git' || protectedBranches.length === 0) return null;
  const words = [];
  for (let i = 0; i < unit.args.length; i++) {
    const w = unit.args[i];
    if (isFlag(w)) {
      if (PUSH_VALUE_OPTS.has(w.v)) i++;
      continue;
    }
    words.push(w.v);
  }
  if (words[0] !== 'push') return null;
  if (hasFlag(unit.args, '--all', false) || hasFlag(unit.args, '--mirror', false) || hasFlag(unit.args, '--branches', false)) {
    return 'it pushes every branch, including protected ones';
  }
  const refspecs = words.slice(2);
  const isProtected = (name) => protectedBranches.includes(name);
  let needCurrent = refspecs.length === 0;
  for (const spec of refspecs) {
    const s = spec.replace(/^\+/, '');
    const dst = (s.includes(':') ? s.slice(s.indexOf(':') + 1) : s).replace(/^refs\/heads\//, '');
    if (dst === 'HEAD' || dst === '@') needCurrent = true;
    else if (isProtected(dst)) return `"${dst}" is a protected branch`;
  }
  if (needCurrent && !hasFlag(unit.args, '--tags', false) && !hasFlag(unit.args, '--delete', false)) {
    const current = gitBranch(unit, ctx);
    if (current && isProtected(current)) return `the current branch "${current}" is protected`;
  }
  return null;
}

function checkCommitOnProtected(unit, ctx, protectedBranches) {
  if (unit.program !== 'git') return null;
  const sub = positionals(unit.args)[0];
  if (sub !== 'commit' && sub !== 'merge' && sub !== 'cherry-pick' && sub !== 'revert') return null;
  const current = gitBranch(unit, ctx);
  return current && protectedBranches.includes(current) ? `the current branch "${current}" is protected` : null;
}

/** `az` command groups that only sign in, switch or inspect the subscription, or manage the CLI itself. */
const AZ_LOCAL = new Set(['account', 'login', 'logout', 'version', 'upgrade', 'extension', 'config', 'cloud', 'find', 'feedback', 'interactive', 'init', 'bicep', 'help']);

/**
 * An `az` command that names no subscription, run while the CLI's default
 * subscription matches a production name. Matching is case-insensitive and
 * by substring, like the item's `*name*` rules.
 */
function checkAzureDefaultSubscription(unit, ctx, values) {
  if (unit.program.toLowerCase() !== 'az' || !values || values.length === 0) return null;
  const pos = positionals(unit.args);
  if (pos.length === 0 || AZ_LOCAL.has(pos[0].toLowerCase())) return null;
  // An explicit subscription is covered by the item's rules when it is a production one.
  if (hasFlag(unit.args, '--subscription', false) || hasFlag(unit.args, '--ids', false)) return null;
  const sub = ctx.azureSubscription();
  if (!sub) return null;
  const names = [sub.name, sub.id].filter(Boolean).map((x) => String(x).toLowerCase());
  const hit = values.find((v) => names.some((n) => n.includes(String(v).toLowerCase())));
  return hit ? `the default Azure subscription "${sub.name || sub.id}" matches "${hit}"` : null;
}

/** Returns a reason string if the check fires for this unit, else null. */
function runCheck(check, unit, ctx, rules) {
  switch (check.type) {
    case 'argv':
      return checkArgv(check, unit) ? check.message : null;
    case 'regex': {
      // An optional program list limits the check to commands run by those programs.
      if (check.program && !check.program.some((p) => p.toLowerCase() === unit.program.toLowerCase())) return null;
      const re = new RegExp(check.pattern, check.flags || '');
      return re.test(unit.raw.trim()) || re.test(unit.norm) ? check.message : null;
    }
    case 'touchesPath':
      return checkTouchesPath(check, unit, ctx) ? check.message : null;
    case 'mentionsDomain':
      return checkMentionsDomain(check, unit) ? check.message : null;
    case 'builtin': {
      const branches = rules.protectedBranches || [];
      let detail = null;
      if (check.name === 'recursive-delete-outside-project') detail = checkRecursiveDelete(unit, ctx);
      else if (check.name === 'git-push-protected-branch') detail = checkPushProtected(unit, ctx, branches);
      else if (check.name === 'git-commit-on-protected-branch') detail = checkCommitOnProtected(unit, ctx, branches);
      else if (check.name === 'azure-default-subscription') detail = checkAzureDefaultSubscription(unit, ctx, check.values);
      else throw new Error(`unknown builtin check "${check.name}"`);
      return detail ? `${check.message} (${detail})` : null;
    }
    default:
      throw new Error(`unknown check type "${check.type}"`);
  }
}

// -------------------------------------------------------------- evaluate

function defaultContext(input) {
  const os = require('os');
  const win = process.platform === 'win32';
  const cwd = (input && input.cwd) || process.cwd();
  const tmp = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/folders', '/var/folders', os.tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP];
  return {
    win,
    cwd,
    projectDir: process.env.CLAUDE_PROJECT_DIR || cwd,
    home: os.homedir(),
    tmpDirs: tmp.filter(Boolean),
    azureSubscription() {
      // The Azure CLI keeps its profile in AZURE_CONFIG_DIR, or ~/.azure. The file starts with a BOM.
      try {
        const path = require('path');
        const dir = process.env.AZURE_CONFIG_DIR || path.join(os.homedir(), '.azure');
        const text = require('fs').readFileSync(path.join(dir, 'azureProfile.json'), 'utf8').replace(/^﻿/, '');
        const def = (JSON.parse(text).subscriptions || []).find((s) => s && s.isDefault);
        return def ? { name: def.name || '', id: def.id || '' } : null;
      } catch {
        return null;
      }
    },
    currentBranch(dir) {
      if (!dir) return null;
      try {
        const native = win ? dir.replace(/^\/([a-z])\//, '$1:/') : dir;
        return require('child_process')
          .execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: native, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
          .trim();
      } catch {
        return null;
      }
    },
  };
}

/**
 * Decides one tool call.
 * Returns { decision: 'allow' | 'ask' | 'deny', hits: [{ id, title, mode, reason, command }] }.
 */
function evaluate(input, rules, context) {
  const tool = input && input.tool_name;
  const command = input && input.tool_input && input.tool_input.command;
  if ((tool !== 'Bash' && tool !== 'PowerShell') || typeof command !== 'string') return { decision: 'allow', hits: [] };

  const base = context || defaultContext(input);
  const win = !!base.win;
  const ctx = {
    win,
    home: collapse(normPath(base.home, win)),
    projectDir: collapse(normPath(base.projectDir, win)),
    tmpDirs: (base.tmpDirs || []).map((d) => collapse(normPath(d, win))),
    currentBranch: base.currentBranch || (() => null),
    azureSubscription: base.azureSubscription || (() => null),
  };
  const fail = (reason) => ({ decision: 'deny', hits: [{ id: 'guard', title: 'deny-guard', mode: 'deny', reason, command: '' }] });

  if (command.length > MAX_COMMAND_CHARS) return fail('The command is too long to check. Split it into smaller commands.');

  let units;
  try {
    const state = { cwd: collapse(normPath(base.cwd, win)), ctx };
    units = analyze(command, tool === 'PowerShell' ? 'powershell' : 'bash', state, 0, []);
  } catch (err) {
    return fail(`The command could not be analyzed (${err.message}). Rewrite it more simply.`);
  }

  const hits = [];
  for (const item of rules.items || []) {
    let hit = null;
    for (const unit of units) {
      const ps = unit.shell === 'powershell';
      const patterns = (item.patterns && item.patterns[ps ? 'powershell' : 'bash']) || [];
      const pattern = unit.norm ? patterns.find((p) => matchPattern(p, unit.norm, ps)) : undefined;
      if (pattern !== undefined) hit = `Matches the blocked form \`${pattern}\`.`;
      for (const check of item.checks || []) {
        if (hit) break;
        hit = runCheck(check, unit, ctx, rules);
      }
      if (hit) {
        hits.push({ id: item.id, title: item.title, mode: item.mode, reason: hit, command: unit.raw.trim() });
        break;
      }
    }
  }
  const decision = hits.some((h) => h.mode === 'deny') ? 'deny' : hits.length > 0 ? 'ask' : 'allow';
  return { decision, hits };
}

function formatHits(hits) {
  return hits.map((h) => `[${h.title}] ${h.reason}${h.command ? `\n  in: ${h.command.slice(0, 200)}` : ''}`).join('\n');
}

function main() {
  const fs = require('fs');
  const path = require('path');
  const block = (message) => {
    process.stderr.write(message + '\n');
    process.exit(2);
  };
  try {
    const rulesPath = process.env.DENY_GUARD_RULES || path.join(__dirname, 'deny-guard.rules.json');
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = evaluate(input, rules);
    if (result.decision === 'deny') {
      const denied = result.hits.filter((h) => h.mode === 'deny');
      block(`Blocked by deny-guard. Do not retry this another way; tell the user what you were trying to do.\n${formatHits(denied)}`);
    }
    if (result.decision === 'ask') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: formatHits(result.hits) },
        }),
      );
    }
    process.exit(0);
  } catch (err) {
    block(`deny-guard failed and blocked this call to stay safe: ${err && err.message ? err.message : err}`);
  }
}

module.exports = { evaluate, analyze, tokenize, parseCommands, matchPattern, globToRegExp, resolvePath, normPath, positionals, PS_ALIASES };

if (require.main === module) main();
