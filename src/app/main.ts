import { catalog, categories } from '../catalog';
import type { CatalogItem, InputDef, Mode } from '../catalog/schema';
import { generate, type GenerateResult, type Os, type Shell } from '../generator/generate';
import guardSource from '../hook/deny-guard.cjs?raw';
import {
  applyPreset,
  defaultShells,
  guessOs,
  initialState,
  loadState,
  neededInputs,
  presets,
  saveState,
  toInputValues,
  toSelections,
  type AppState,
} from './state';

type Child = Node | string | null | undefined | false;

/** Tiny DOM builder. Text always goes in as text nodes, never as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) el.className = className;
  Object.assign(el, rest);
  for (const c of children) if (c) el.append(c);
  return el;
}

const app = document.getElementById('app')!;
const state: AppState = loadState(localStorage, initialState(guessOs(navigator.platform)));

const detailsEl = h('section');
const outputEl = h('section');

function changed(rerenderDetails = false): void {
  saveState(state, localStorage);
  if (rerenderDetails) renderDetails();
  renderOutput();
}

// ------------------------------------------------------------ 1. environment

function renderEnvironment(): HTMLElement {
  const section = h('section', {}, h('h2', {}, '1. Your setup'));

  const sandboxSelect = h('select', {
    onchange: () => {
      state.env.sandbox = sandboxSelect.value as AppState['env']['sandbox'];
      changed();
    },
  });
  for (const [value, label] of [
    ['off', 'Off'],
    ['on', 'On'],
    ['strict', 'On, strict (refuse to run without it)'],
  ] as const) {
    sandboxSelect.append(h('option', { value, selected: state.env.sandbox === value }, label));
  }
  const sandboxNote = h('span', { class: 'muted' });
  const syncSandbox = () => {
    const windows = state.env.os === 'windows';
    sandboxSelect.disabled = windows;
    sandboxNote.textContent = windows
      ? ' Not available on native Windows. Run Claude Code in WSL2 to get it.'
      : ' Holds shell commands, and the programs they start, to your path and domain rules.';
  };

  const shellBoxes = new Map<Shell, HTMLInputElement>();
  const shellRow = h('div', { class: 'row' }, 'Shell tools Claude has:');
  for (const [shell, label] of [
    ['bash', 'Bash'],
    ['powershell', 'PowerShell'],
  ] as const) {
    const box = h('input', {
      type: 'checkbox',
      checked: state.env.shells.includes(shell),
      onchange: () => {
        state.env.shells = [...shellBoxes].filter(([, b]) => b.checked).map(([s]) => s);
        changed();
      },
    });
    shellBoxes.set(shell, box);
    shellRow.append(h('label', {}, box, ` ${label}`));
  }

  const osSelect = h('select', {
    onchange: () => {
      state.env.os = osSelect.value as Os;
      state.env.shells = defaultShells(state.env.os);
      for (const [shell, box] of shellBoxes) box.checked = state.env.shells.includes(shell);
      syncSandbox();
      changed();
    },
  });
  for (const [value, label] of [
    ['windows', 'Windows'],
    ['macos', 'macOS'],
    ['linux', 'Linux'],
    ['wsl', 'Windows with WSL2'],
  ] as const) {
    osSelect.append(h('option', { value, selected: state.env.os === value }, label));
  }

  const scopeRow = h('div', { class: 'row' }, 'Where the rules will live:');
  for (const [value, label] of [
    ['project', 'This project (.claude/settings.json, shared with the team through git)'],
    ['user', 'All my projects (~/.claude/settings.json)'],
  ] as const) {
    scopeRow.append(
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'scope',
          checked: state.env.scope === value,
          onchange: () => {
            state.env.scope = value;
            changed();
          },
        }),
        ` ${label}`,
      ),
    );
  }

  syncSandbox();
  section.append(
    h('label', {}, 'Operating system: ', osSelect),
    shellRow,
    scopeRow,
    h('label', {}, 'Sandbox: ', sandboxSelect, sandboxNote),
    renderHookChoice(),
  );
  return section;
}

function renderHookChoice(): HTMLElement {
  const failClosed = h('input', {
    type: 'checkbox',
    checked: state.env.hookFailClosed !== false,
    onchange: () => {
      state.env.hookFailClosed = failClosed.checked;
      changed();
    },
  });
  const failClosedLabel = h(
    'label',
    {},
    failClosed,
    ' Block the command if the hook itself fails ',
    h('span', { class: 'muted' }, '(needs Claude Code v2.1.295 or later; untick on older versions)'),
  );
  const sync = () => {
    failClosed.disabled = state.env.hook === false;
    failClosedLabel.classList.toggle('muted', state.env.hook === false);
  };

  const choice = (value: boolean, title: string, summary: string) =>
    h(
      'label',
      {},
      h('input', {
        type: 'radio',
        name: 'hook',
        checked: (state.env.hook !== false) === value,
        onchange: () => {
          state.env.hook = value;
          sync();
          changed();
        },
      }),
      ' ',
      h('strong', {}, title),
      ` ${summary}`,
    );

  const li = (...c: Child[]) => h('li', {}, ...c);
  const info = h(
    'details',
    {},
    h('summary', {}, 'What is the difference?'),
    h(
      'p',
      {},
      h('strong', {}, 'Rules'),
      ' are lines in your settings file. Claude Code checks them itself before every tool call, and a matching call never runs. They cover file reads and edits, web domains, MCP tools, and shell commands.',
    ),
    h(
      'p',
      {},
      'For shell commands, a rule matches the text of the command as it is usually written. ',
      h('code', {}, 'Bash(git push --force *)'),
      ' stops ',
      h('code', {}, 'git push --force'),
      ' but not ',
      h('code', {}, 'git -C . push --force'),
      ' or ',
      h('code', {}, "bash -c 'git push --force'"),
      '. Claude rarely writes commands that way, but nothing prevents it.',
    ),
    h(
      'p',
      {},
      h('strong', {}, 'The hook'),
      ' is a script, ',
      h('code', {}, 'deny-guard.cjs'),
      ', that Claude Code runs before every shell command. It takes the command apart first, so those other spellings are caught too. It also does three things rules cannot:',
    ),
    h(
      'ul',
      {},
      li('Judges a recursive delete by where it lands, so ', h('code', {}, 'rm -rf ../other-project'), ' is blocked and ', h('code', {}, 'rm -rf dist'), ' is not.'),
      li('Looks up the current branch, so a bare ', h('code', {}, 'git push'), ' on a protected branch is caught.'),
      li('Spots a protected file named inside an inline script, such as ', h('code', {}, `node -e "readFileSync('.env')"`), '.'),
    ),
    h('p', {}, h('strong', {}, 'What the hook costs you:')),
    h(
      'ul',
      {},
      li('Two more files to install and keep, and Node.js must be on your PATH.'),
      li('A script of ours runs on your machine before every shell command. Read it before you trust it.'),
      li('If it misreads a command it can block something harmless. If it breaks, it blocks every shell command until you fix or remove it.'),
      li('It does nothing for file reads, web fetches or MCP tools. Rules already handle those in full.'),
    ),
    h(
      'p',
      {},
      h('strong', {}, 'Neither one'),
      ' stops a script that Claude writes to disk and then runs, or what a program does once it is running. That is what the sandbox is for.',
    ),
    h(
      'p',
      { class: 'muted' },
      'Start with rules only if you are new to this. Step 4 lists, for each thing you selected, exactly what the hook would add.',
    ),
  );

  sync();
  return h(
    'fieldset',
    {},
    h('legend', {}, 'How strict'),
    choice(false, 'Rules only.', 'One block of settings to paste. Nothing else to install.'),
    choice(true, 'Rules plus hook.', 'For advanced users. Also catches commands written in unusual ways. Needs Node.js.'),
    failClosedLabel,
    info,
  );
}

// ------------------------------------------------------------ 2. protections

const itemBoxes = new Map<string, { box: HTMLInputElement; mode: HTMLSelectElement; card: HTMLElement }>();

function syncItems(): void {
  for (const [id, els] of itemBoxes) {
    const on = id in state.selected;
    els.box.checked = on;
    els.mode.disabled = !on;
    els.mode.value = state.selected[id] ?? catalog.find((i) => i.id === id)!.defaultMode;
    els.card.classList.toggle('on', on);
  }
}

function renderItem(item: CatalogItem): HTMLElement {
  const box = h('input', {
    type: 'checkbox',
    onchange: () => {
      if (box.checked) state.selected[item.id] = mode.value as Mode;
      else delete state.selected[item.id];
      syncItems();
      changed(true);
    },
  });
  const mode = h(
    'select',
    {
      title: 'Block outright, or ask you each time',
      onchange: () => {
        if (item.id in state.selected) state.selected[item.id] = mode.value as Mode;
        changed();
      },
    },
    h('option', { value: 'deny' }, 'Block'),
    h('option', { value: 'ask' }, 'Ask me'),
  );
  const card = h(
    'div',
    { class: 'item' },
    h(
      'div',
      { class: 'item-head' },
      h('label', {}, box, ` ${item.title}`, h('span', { class: `sev ${item.severity}` }, item.severity)),
      mode,
    ),
    h('p', {}, item.stops),
    h('p', { class: 'muted' }, item.why),
    item.inputs?.length ? h('p', { class: 'muted' }, 'Asks for details in step 3.') : null,
  );
  itemBoxes.set(item.id, { box, mode, card });
  return card;
}

function renderProtections(): HTMLElement {
  const section = h('section', {}, h('h2', {}, '2. What to protect'));
  const presetRow = h('div', { class: 'row' }, 'Start from:');
  for (const preset of presets) {
    presetRow.append(
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            state.selected = applyPreset(preset.ids());
            syncItems();
            changed(true);
          },
        },
        preset.label,
      ),
    );
  }
  section.append(
    h(
      'p',
      { class: 'muted' },
      'The test for each one: if Claude gets it wrong once, can you take it back? These are the things you cannot.',
    ),
    presetRow,
  );
  for (const category of categories) {
    section.append(h('h3', {}, category.title), h('p', { class: 'muted' }, category.blurb));
    for (const item of catalog.filter((i) => i.category === category.id)) section.append(renderItem(item));
  }
  syncItems();
  return section;
}

// ---------------------------------------------------------------- 3. details

function renderInput(def: InputDef): HTMLElement {
  if (def.kind === 'boolean') {
    const box = h('input', {
      type: 'checkbox',
      checked: state.inputs[def.id] === true,
      onchange: () => {
        state.inputs[def.id] = box.checked;
        changed();
      },
    });
    return h('label', {}, box, ` ${def.label} `, h('span', { class: 'muted' }, def.help));
  }
  const area = h('textarea', {
    rows: 3,
    value: typeof state.inputs[def.id] === 'string' ? (state.inputs[def.id] as string) : '',
    placeholder: (def.placeholder ?? '').split(', ').join('\n'),
    spellcheck: false,
    oninput: () => {
      state.inputs[def.id] = area.value;
      changed();
    },
  });
  return h(
    'label',
    {},
    h('strong', {}, def.label),
    def.required ? ' (required)' : '',
    h('div', { class: 'muted' }, `${def.help} One per line.`),
    area,
  );
}

function renderDetails(): void {
  const needed = neededInputs(state.selected);
  detailsEl.replaceChildren(h('h2', {}, '3. Your details'));
  if (needed.length === 0) {
    detailsEl.append(h('p', { class: 'muted' }, 'Nothing you have selected needs any details.'));
    return;
  }
  for (const def of needed) detailsEl.append(renderInput(def));
}

// ----------------------------------------------------------------- 4. output

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** `collapsedNote`: when given, the text is not shown inline and this note is shown instead. */
function fileBlock(title: string, destination: string, filename: string, text: string, collapsedNote?: string): HTMLElement {
  const copy = h(
    'button',
    {
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Copy failed; select the text instead';
        }
        setTimeout(() => (copy.textContent = 'Copy'), 2000);
      },
    },
    'Copy',
  );
  return h(
    'div',
    {},
    h('h3', {}, title),
    h('p', {}, 'Goes in ', h('code', {}, destination)),
    h('div', {}, copy, h('button', { type: 'button', onclick: () => download(filename, text) }, `Download ${filename}`)),
    collapsedNote === undefined ? h('pre', {}, text) : h('p', { class: 'muted' }, `${text.split('\n').length} lines. ${collapsedNote}`),
  );
}

function installSteps(result: GenerateResult): HTMLElement {
  const base = state.env.scope === 'project' ? '.claude' : '~/.claude';
  const steps = h('ol');
  steps.append(
    h(
      'li',
      {},
      'Open ',
      h('code', {}, `${base}/settings.json`),
      ', or create it. If it already has ',
      h('code', {}, 'permissions'),
      ' or ',
      h('code', {}, 'hooks'),
      ', add these entries to the existing lists instead of replacing them.',
    ),
  );
  if (result.hook) {
    steps.append(
      h('li', {}, 'Save the two hook files into ', h('code', {}, `${base}/hooks/`), ', keeping their names.'),
      h('li', {}, 'Check that ', h('code', {}, 'node --version'), ' works in a terminal. The hook needs Node.js.'),
    );
  }
  steps.append(h('li', {}, 'Start a new Claude Code session. Settings and hooks are read when a session starts.'));
  if (state.env.scope === 'project') {
    steps.append(h('li', {}, 'Commit the ', h('code', {}, '.claude'), ' folder so your team gets the same rules.'));
  }
  return steps;
}

function hookExamples(commands: string[]): HTMLElement {
  const list = h('ul');
  for (const c of commands) list.append(h('li', {}, h('code', {}, c)));
  const heading = state.env.hook === false ? 'Only the hook would stop these (it is off):' : 'The hook, not a rule, is what stops these:';
  return h('div', {}, h('p', {}, heading), list);
}

function renderOutput(): void {
  outputEl.replaceChildren(h('h2', {}, '4. Your rules'));
  const selections = toSelections(state.selected);
  if (selections.length === 0) {
    outputEl.append(h('p', { class: 'muted' }, 'Select something in step 2 to see your rules here.'));
    return;
  }
  const result = generate({ env: state.env, selections, inputs: toInputValues(state.inputs) });
  const { deny = [], ask = [] } = result.settings.permissions;

  outputEl.append(
    h('p', {}, `${deny.length} block rules, ${ask.length} ask rules`, result.hook ? ', plus a hook.' : '.', result.settings.sandbox ? ' Sandbox on.' : ''),
  );
  const hookWouldHelp = result.items.filter((i) => i.hookOnly.length > 0);
  if (state.env.hook === false && hookWouldHelp.length > 0) {
    outputEl.append(
      h(
        'p',
        {},
        h('strong', {}, 'Rules only. '),
        `The hook would catch more for ${hookWouldHelp.length} of your ${result.items.length} selections; each one below shows examples. Switch to "Rules plus hook" in step 1 to add it.`,
      ),
    );
  }
  if (result.warnings.length > 0) {
    const list = h('ul');
    for (const w of result.warnings) list.append(h('li', {}, w));
    outputEl.append(h('div', { class: 'warnings' }, h('strong', {}, 'Before you use this'), list));
  }

  const base = state.env.scope === 'project' ? '.claude' : '~/.claude';
  outputEl.append(
    fileBlock('Settings', `${base}/settings.json`, 'settings.fragment.json', JSON.stringify(result.settings, null, 2) + '\n'),
  );
  if (result.hook) {
    const root = result.hook.relativeTo === 'project' ? '' : '~/';
    outputEl.append(
      fileBlock('Hook rules', root + result.hook.rulesPath, 'deny-guard.rules.json', JSON.stringify(result.hook.rules, null, 2) + '\n', 'Built from your selections; download it again whenever you change them.'),
      fileBlock('Hook script', root + result.hook.scriptPath, 'deny-guard.cjs', guardSource, 'The same for everyone; it reads the rules file next to it.'),
    );
  }
  outputEl.append(h('h3', {}, 'Install'), installSteps(result));

  outputEl.append(
    h('h3', {}, 'What still gets through'),
    h('p', { class: 'muted' }, 'No rule set is complete. These are the known holes in what you selected.'),
  );
  for (const item of result.items) {
    const gaps = h('ul');
    for (const g of item.gaps) gaps.append(h('li', {}, g));
    outputEl.append(
      h(
        'details',
        {},
        h(
          'summary',
          {},
          h('strong', {}, item.title),
          ` (${item.mode === 'deny' ? 'block' : 'ask'}, ${item.rules} rules)`,
          item.skipped ? h('span', { class: 'skipped' }, ` Skipped. ${item.skipped}`) : null,
        ),
        gaps,
        item.hookOnly.length > 0 ? hookExamples(item.hookOnly) : null,
        item.note ? h('p', { class: 'muted' }, item.note) : null,
      ),
    );
  }

  const table = h('table', {}, h('tr', {}, h('th', {}, 'Rule'), h('th', {}, 'Mode'), h('th', {}, 'From')));
  for (const r of result.rules) {
    table.append(h('tr', {}, h('td', {}, h('code', {}, r.rule)), h('td', {}, r.mode === 'deny' ? 'block' : 'ask'), h('td', {}, r.items.join(', '))));
  }
  outputEl.append(h('details', {}, h('summary', {}, 'Which selection produced each rule'), table));
}

app.append(renderEnvironment(), renderProtections(), detailsEl, outputEl);
renderDetails();
renderOutput();
