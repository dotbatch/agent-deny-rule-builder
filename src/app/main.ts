import { catalog, categories, itemApplies, itemTools, toolGroups, tools, type ToolId } from '../catalog';
import type { CatalogItem, InputDef, Mode } from '../catalog/schema';
import { generate, type GenerateResult, type Os, type Shell } from '../generator/generate';
import guardSource from '../hook/deny-guard.cjs?raw';
import { assumeHome, loadGuard, simulate, type Call, type SimContext } from '../simulator/simulate';
import {
  applyPreset,
  defaultShells,
  guessOs,
  initialState,
  loadState,
  neededInputs,
  normalizeEnv,
  parseList,
  presetIds,
  presets,
  saveState,
  shellAllowed,
  toInputValues,
  toSelections,
  type AppState,
} from './state';

type Child = Node | string | null | undefined | false;
type Attrs = { [k: `aria-${string}`]: string; [k: `data-${string}`]: string };

/** Tiny DOM builder. Text always goes in as text nodes, never as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } & Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = String(value);
    else if (key === 'role' || key.startsWith('aria-') || key.startsWith('data-')) el.setAttribute(key, String(value));
    else (el as unknown as Record<string, unknown>)[key] = value;
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

// ------------------------------------------------------------ theme

const themeBtn = document.getElementById('theme-toggle') as HTMLButtonElement;
function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function syncThemeBtn(): void {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  themeBtn.textContent = next === 'dark' ? 'Dark mode' : 'Light mode';
  themeBtn.setAttribute('aria-label', `Switch to ${next} mode`);
}
themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('theme', next);
  } catch {
    /* storage unavailable: the choice just won't persist */
  }
  syncThemeBtn();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeBtn);
syncThemeBtn();

const app = document.getElementById('app')!;
const state: AppState = loadState(localStorage, initialState(guessOs(navigator.platform)));

const detailsBody = h('div', { class: 'step-body' });
const outputBody = h('div', { class: 'step-body' });
const testerResultEl = h('div', { class: 'tester-result', 'aria-live': 'polite' });
const guard = loadGuard(guardSource);

function changed(rerenderDetails = false): void {
  saveState(state, localStorage);
  if (rerenderDetails) renderDetails();
  renderOutput();
  renderTesterResult();
  syncNav();
}

// ------------------------------------------------------------ shared pieces

const STEPS = [
  { id: 'setup', label: 'Setup' },
  { id: 'protect', label: 'Protect' },
  { id: 'details', label: 'Details' },
  { id: 'rules', label: 'Rules' },
  { id: 'try', label: 'Try it' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

function step(id: StepId, title: string, lead: string, ...body: Child[]): HTMLElement {
  const n = STEPS.findIndex((s) => s.id === id) + 1;
  return h(
    'section',
    { id, class: 'step' },
    h('header', { class: 'step-head' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(n)), h('div', {}, h('h2', {}, title), h('p', { class: 'lead' }, lead))),
    ...body,
  );
}

let segCount = 0;

/** A row of mutually exclusive choices, built on real radio inputs so the keyboard works as usual. */
function segmented<T extends string>(label: string, options: readonly (readonly [T, string])[], value: T, onChange: (value: T) => void, small = false) {
  const name = `seg-${segCount++}`;
  const inputs = new Map<T, HTMLInputElement>();
  const el = h('div', { class: small ? 'seg small' : 'seg', role: 'radiogroup', 'aria-label': label });
  for (const [v, text] of options) {
    const input = h('input', { type: 'radio', name, checked: v === value, onchange: () => onChange(v) });
    inputs.set(v, input);
    el.append(h('label', {}, input, h('span', {}, text)));
  }
  return {
    el,
    set(v: T) {
      for (const [k, input] of inputs) input.checked = k === v;
    },
    disable(disabled: boolean) {
      for (const input of inputs.values()) input.disabled = disabled;
      el.classList.toggle('disabled', disabled);
    },
    /** Disables one option, for example PowerShell where it cannot run. */
    disableOption(v: T, disabled: boolean) {
      inputs.get(v)!.disabled = disabled;
    },
  };
}

function field(label: string, control: Child, note?: Child): HTMLElement {
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), h('div', { class: 'field-control' }, control, note ? h('div', { class: 'field-note' }, note) : null));
}

/** Which collapsible sections are open, so re-rendering the output does not close what the user opened. */
const openSections = new Set<string>();

function disclosure(key: string, summary: Child[], ...body: Child[]): HTMLDetailsElement {
  const el = h('details', { class: 'disclosure', open: openSections.has(key) }, h('summary', {}, ...summary), h('div', { class: 'disclosure-body' }, ...body));
  el.addEventListener('toggle', () => (el.open ? openSections.add(key) : openSections.delete(key)));
  return el;
}

const toastEl = h('div', { class: 'toast', role: 'status' });
let toastTimer: number | undefined;

function hideToast(): void {
  window.clearTimeout(toastTimer);
  toastEl.classList.remove('show');
}

function toast(message: string, actionLabel: string, action: () => void): void {
  hideToast();
  toastEl.replaceChildren(
    h('span', {}, message),
    h(
      'button',
      {
        type: 'button',
        class: 'link',
        onclick: () => {
          action();
          hideToast();
        },
      },
      actionLabel,
    ),
  );
  toastEl.classList.add('show');
  toastTimer = window.setTimeout(hideToast, 7000);
}

// ------------------------------------------------------------ 1. environment

function renderEnvironment(): HTMLElement {
  const sandboxNote = h('span');
  const sandbox = segmented(
    'Sandbox',
    [
      ['off', 'Off'],
      ['on', 'On'],
      ['strict', 'Strict'],
    ] as const,
    state.env.sandbox,
    (value) => {
      state.env.sandbox = value;
      syncSandbox();
      changed();
    },
  );
  const syncSandbox = () => {
    const windows = state.env.os === 'windows';
    sandbox.set(state.env.sandbox);
    sandbox.disable(windows);
    sandboxNote.textContent = windows
      ? 'Not available on native Windows. Run Claude Code in WSL2 to get it.'
      : state.env.sandbox === 'strict'
        ? 'Holds shell commands, and the programs they start, to your path and domain rules. Strict refuses to run without it.'
        : 'Holds shell commands, and the programs they start, to your path and domain rules.';
  };

  const shellBoxes = new Map<Shell, HTMLInputElement>();
  const shellNotes = new Map<Shell, HTMLElement>();
  const shellRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Shell tools Claude has' });
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
    const note = h('span', { class: 'chip-note' });
    shellBoxes.set(shell, box);
    shellNotes.set(shell, note);
    shellRow.append(h('label', { class: 'chip' }, box, h('span', {}, label), note));
  }
  const syncShells = () => {
    for (const [shell, box] of shellBoxes) {
      const allowed = shellAllowed(state.env.os, shell);
      box.disabled = !allowed;
      box.checked = allowed && state.env.shells.includes(shell);
      shellNotes.get(shell)!.textContent = allowed ? '' : 'Windows only';
    }
    testerSyncShell();
  };

  const os = segmented(
    'Operating system',
    [
      ['windows', 'Windows'],
      ['macos', 'macOS'],
      ['linux', 'Linux'],
      ['wsl', 'WSL2'],
    ] as const,
    state.env.os,
    (value: Os) => {
      state.env.os = value;
      state.env.shells = defaultShells(value);
      Object.assign(state.env, normalizeEnv(state.env));
      syncShells();
      syncSandbox();
      changed();
    },
  );

  const scopeNote = h('span');
  const syncScope = () => {
    scopeNote.replaceChildren(
      ...(state.env.scope === 'project'
        ? [h('code', {}, '.claude/settings.json'), ' in this project, shared with the team through git.']
        : [h('code', {}, '~/.claude/settings.json'), ', applied to every project on this machine.']),
    );
  };
  const scope = segmented(
    'Where the rules will live',
    [
      ['project', 'This project'],
      ['user', 'All my projects'],
    ] as const,
    state.env.scope,
    (value) => {
      state.env.scope = value;
      syncScope();
      changed();
    },
  );

  syncShells();
  syncSandbox();
  syncScope();
  return step(
    'setup',
    'Your setup',
    'Guessed from this browser. Change anything that is off.',
    h(
      'div',
      { class: 'group' },
      field('Operating system', os.el),
      field('Shell tools Claude has', shellRow),
      field('Tools you use', renderToolPicker()),
      field('Where the rules live', scope.el, scopeNote),
      field('Sandbox', sandbox.el, sandboxNote),
    ),
    renderHookChoice(),
  );
}

const toolLabel = new Map<ToolId, string>(tools.map((t) => [t.id, t.label]));

/**
 * Clouds, clusters, databases and so on, picked as chips inside a fold so
 * the setup step stays short. Nothing picked means every tool is covered.
 */
function renderToolPicker(): HTMLElement {
  const summary = h('span', { class: 'tool-summary' });
  const boxes = new Map<ToolId, HTMLInputElement>();
  const picked = () => state.env.tools ?? [];

  const clear = h(
    'button',
    {
      type: 'button',
      class: 'link',
      onclick: () => {
        state.env.tools = [];
        sync();
        toolsChanged();
      },
    },
    'Clear',
  );

  const sync = () => {
    const ids = picked();
    for (const [id, box] of boxes) box.checked = ids.includes(id);
    clear.hidden = ids.length === 0;
    if (ids.length === 0) {
      summary.replaceChildren(h('span', {}, 'Every tool'), h('span', { class: 'muted' }, ' · pick yours to drop rules for the rest'));
    } else {
      const names = ids.map((id) => toolLabel.get(id)!);
      const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
      summary.replaceChildren(h('span', {}, shown));
    }
  };

  const groups = toolGroups.map((group) => {
    const row = h('div', { class: 'chips', role: 'group', 'aria-label': group.title });
    for (const tool of tools.filter((t) => t.group === group.id)) {
      const box = h('input', {
        type: 'checkbox',
        onchange: () => {
          const set = new Set(picked());
          if (box.checked) set.add(tool.id);
          else set.delete(tool.id);
          // Keep list order, so the summary and saved state do not depend on click order.
          state.env.tools = tools.map((t) => t.id).filter((id) => set.has(id));
          sync();
          toolsChanged();
        },
      });
      boxes.set(tool.id, box);
      row.append(h('label', { class: 'chip small', title: tool.hint }, box, h('span', {}, tool.label)));
    }
    return h('div', { class: 'tool-group' }, h('div', { class: 'tool-group-title' }, group.title), row);
  });

  sync();
  return disclosure(
    'tools',
    [summary],
    ...groups,
    h('p', { class: 'field-note' }, 'Leave empty to cover every tool. Rules for tools you do not pick are left out, and presets skip items none of them use. ', clear),
  );
}

/** Tools changed: item cards, presets and output all depend on them. */
function toolsChanged(): void {
  syncItems();
  changed(true);
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
  const failClosedRow = h(
    'label',
    { class: 'check-row' },
    failClosed,
    h('span', {}, 'Block the command if the hook itself fails', h('span', { class: 'field-note' }, 'Needs Claude Code v2.1.295 or later. Untick on older versions.')),
  );
  const sync = () => {
    failClosedRow.hidden = state.env.hook === false;
  };

  const choice = (value: boolean, title: string, tag: string, summary: string) =>
    h(
      'label',
      { class: 'option' },
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
      h('span', { class: 'option-body' }, h('span', { class: 'option-title' }, title, h('span', { class: 'tag' }, tag)), h('span', { class: 'option-desc' }, summary)),
    );

  const li = (...c: Child[]) => h('li', {}, ...c);
  const info = disclosure(
    'hook-info',
    ['What is the difference?'],
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
    h('p', { class: 'muted' }, 'Start with rules only if you are new to this. Step 4 lists, for each thing you selected, exactly what the hook would add.'),
  );

  sync();
  return h(
    'div',
    { class: 'block' },
    h('h3', {}, 'How strict'),
    h(
      'div',
      { class: 'options', role: 'radiogroup', 'aria-label': 'How strict' },
      choice(false, 'Rules only', 'Simplest', 'One block of settings to paste. Nothing else to install.'),
      choice(true, 'Rules plus hook', 'Advanced', 'Also catches commands written in unusual ways. Needs Node.js.'),
    ),
    failClosedRow,
    info,
  );
}

// ------------------------------------------------------------ 2. protections

interface ItemEls {
  box: HTMLInputElement;
  card: HTMLElement;
  foot: HTMLElement;
  toolNote: HTMLElement;
  setMode: (mode: Mode) => void;
}
const itemEls = new Map<string, ItemEls>();
const presetButtons = new Map<string, { button: HTMLButtonElement; count: HTMLElement }>();
const categoryCounts = new Map<string, HTMLElement>();
const selectionCount = h('span', { class: 'muted' });
const clearButton = h('button', { type: 'button', class: 'link', onclick: () => replaceSelection({}, 'Selection cleared.') }, 'Clear all');

function activePresetId(): string | null {
  const count = Object.keys(state.selected).length;
  if (count === 0) return null;
  for (const preset of presets) {
    const ids = presetIds(preset, state.env.tools);
    if (ids.length === count && ids.every((id) => id in state.selected)) return preset.id;
  }
  return null;
}

function syncItems(): void {
  for (const [id, els] of itemEls) {
    const mode = state.selected[id];
    const on = mode !== undefined;
    els.box.checked = on;
    els.card.classList.toggle('on', on);
    els.foot.hidden = !on;
    if (mode) els.setMode(mode);
    const item = catalog.find((i) => i.id === id)!;
    const applies = itemApplies(item, state.env.tools);
    els.card.classList.toggle('unused', !applies);
    els.toolNote.hidden = applies;
  }
  const active = activePresetId();
  for (const preset of presets) {
    const els = presetButtons.get(preset.id);
    if (!els) continue;
    els.button.setAttribute('aria-pressed', String(preset.id === active));
    els.count.textContent = `${presetIds(preset, state.env.tools).length} protections`;
  }
  for (const category of categories) {
    const items = catalog.filter((i) => i.category === category.id);
    categoryCounts.get(category.id)!.textContent = `${items.filter((i) => i.id in state.selected).length} of ${items.length}`;
  }
  const count = Object.keys(state.selected).length;
  selectionCount.textContent = count === 0 ? 'Nothing selected yet' : `${count} of ${catalog.length} selected`;
  clearButton.hidden = count === 0;
}

/** Swaps the whole selection, and offers a way back if that threw away choices the user had made. */
function replaceSelection(next: AppState['selected'], message: string): void {
  const previous = state.selected;
  state.selected = next;
  syncItems();
  changed(true);
  if (Object.keys(previous).length > 0) {
    toast(message, 'Undo', () => {
      state.selected = previous;
      syncItems();
      changed(true);
    });
  }
}

function renderItem(item: CatalogItem): HTMLElement {
  let modeValue: Mode = item.defaultMode;
  const box = h('input', {
    type: 'checkbox',
    class: 'check',
    onchange: () => {
      if (box.checked) state.selected[item.id] = modeValue;
      else delete state.selected[item.id];
      syncItems();
      changed(true);
    },
  });
  const mode = segmented(
    `When Claude tries this: ${item.title}`,
    [
      ['deny', 'Block'],
      ['ask', 'Ask me'],
    ] as const,
    modeValue,
    (value: Mode) => {
      modeValue = value;
      if (item.id in state.selected) state.selected[item.id] = value;
      changed();
    },
    true,
  );
  const foot = h(
    'div',
    { class: 'item-foot' },
    mode.el,
    item.inputs?.length ? h('a', { class: 'item-needs', href: '#details' }, 'Needs details in step 3') : null,
  );
  const toolNote = h(
    'span',
    { class: 'item-unused', hidden: true },
    `Not used by your tools. Covers ${itemTools(item)
      .map((t) => toolLabel.get(t))
      .join(', ')}.`,
  );
  const card = h(
    'div',
    { class: 'item' },
    h(
      'label',
      { class: 'item-main' },
      box,
      h(
        'span',
        { class: 'item-text' },
        h('span', { class: 'item-title' }, item.title, h('span', { class: `sev ${item.severity}` }, item.severity)),
        h('span', { class: 'item-stops' }, item.stops),
        h('span', { class: 'item-why' }, item.why),
        toolNote,
      ),
    ),
    foot,
  );
  itemEls.set(item.id, {
    box,
    card,
    foot,
    toolNote,
    setMode: (value) => {
      modeValue = value;
      mode.set(value);
    },
  });
  return card;
}

function renderProtections(): HTMLElement {
  const presetGrid = h('div', { class: 'presets' });
  for (const preset of presets) {
    if (preset.id === 'none') continue;
    const count = h('span', { class: 'preset-count' });
    const button = h(
      'button',
      {
        type: 'button',
        class: 'preset',
        'aria-pressed': 'false',
        onclick: () => replaceSelection(applyPreset(presetIds(preset, state.env.tools)), `Switched to ${preset.label}.`),
      },
      h('span', { class: 'preset-title' }, preset.label),
      count,
      h('span', { class: 'preset-hint' }, preset.hint),
    );
    presetButtons.set(preset.id, { button, count });
    presetGrid.append(button);
  }

  const section = step(
    'protect',
    'What to protect',
    'The test for each one: if Claude gets it wrong once, can you take it back? These are the things you cannot.',
    h('div', { class: 'bar' }, h('h3', {}, 'Start from a preset, then adjust'), h('span', { class: 'bar-end' }, selectionCount, clearButton)),
    presetGrid,
  );
  for (const category of categories) {
    const count = h('span', { class: 'count' });
    categoryCounts.set(category.id, count);
    const grid = h('div', { class: 'items' });
    for (const item of catalog.filter((i) => i.category === category.id)) grid.append(renderItem(item));
    section.append(h('div', { class: 'category-head' }, h('h3', {}, category.title, count), h('p', { class: 'muted' }, category.blurb)), grid);
  }
  syncItems();
  return section;
}

// ---------------------------------------------------------------- 3. details

const isMissing = (def: InputDef): boolean => def.kind !== 'boolean' && def.required === true && parseList(String(state.inputs[def.id] ?? '')).length === 0;

function renderInput(def: InputDef): HTMLElement {
  const usedBy = catalog.filter((i) => i.id in state.selected && i.inputs?.includes(def.id)).map((i) => i.title);
  const usedByNote = h('span', { class: 'used-by' }, `Used by: ${usedBy.join(', ')}`);

  if (def.kind === 'boolean') {
    const box = h('input', {
      type: 'checkbox',
      checked: state.inputs[def.id] === true,
      onchange: () => {
        state.inputs[def.id] = box.checked;
        changed();
      },
    });
    return h('label', { class: 'check-row card' }, box, h('span', {}, def.label, h('span', { class: 'field-note' }, def.help), usedByNote));
  }

  const missingNote = h('span', { class: 'missing-note' }, 'Required. The protections that use this are skipped until you fill it in.');
  const area = h('textarea', {
    rows: 3,
    value: typeof state.inputs[def.id] === 'string' ? (state.inputs[def.id] as string) : '',
    placeholder: (def.placeholder ?? '').split(', ').join('\n'),
    spellcheck: false,
    oninput: () => {
      state.inputs[def.id] = area.value;
      sync();
      changed();
    },
  });
  const card = h(
    'label',
    { class: 'input-card card' },
    h('span', { class: 'input-title' }, def.label, def.required ? h('span', { class: 'tag' }, 'Required') : null),
    h('span', { class: 'field-note' }, `${def.help} One per line.`),
    area,
    missingNote,
    usedByNote,
  );
  const sync = () => {
    const missing = isMissing(def);
    card.classList.toggle('missing', missing);
    missingNote.hidden = !missing;
  };
  sync();
  return card;
}

function renderDetails(): void {
  const needed = neededInputs(state.selected);
  if (needed.length === 0) {
    detailsBody.replaceChildren(h('p', { class: 'empty' }, 'Nothing you have selected needs any details.'));
    return;
  }
  detailsBody.replaceChildren(...needed.map(renderInput));
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
      class: 'btn primary',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = 'Copied';
          copy.classList.add('done');
        } catch {
          copy.textContent = 'Copy failed; select the text instead';
        }
        setTimeout(() => {
          copy.textContent = 'Copy';
          copy.classList.remove('done');
        }, 2000);
      },
    },
    'Copy',
  );
  return h(
    'div',
    { class: 'file card' },
    h(
      'div',
      { class: 'file-head' },
      h('div', {}, h('h3', {}, title), h('p', { class: 'muted' }, 'Goes in ', h('code', {}, destination))),
      h('div', { class: 'file-actions' }, copy, h('button', { type: 'button', class: 'btn', onclick: () => download(filename, text) }, `Download ${filename}`)),
    ),
    collapsedNote === undefined ? h('pre', { tabIndex: 0 }, text) : h('p', { class: 'file-note muted' }, `${text.split('\n').length} lines. ${collapsedNote}`),
  );
}

function installSteps(result: GenerateResult): HTMLElement {
  const base = state.env.scope === 'project' ? '.claude' : '~/.claude';
  const steps = h('ol', { class: 'install' });
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

const stat = (value: string, label: string) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, value), h('span', { class: 'stat-label' }, label));

const starter = presets.find((p) => p.id === 'essentials')!;

function renderOutput(): void {
  const summary = document.getElementById('summary')!;
  const selections = toSelections(state.selected);
  if (selections.length === 0) {
    summary.textContent = 'No rules yet';
    summary.classList.remove('has');
    outputBody.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('p', {}, h('strong', {}, 'Your rules appear here.')),
        h('p', { class: 'muted' }, 'Select something in step 2, or begin with the usual set.'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => replaceSelection(applyPreset(starter.ids()), '') }, `Start with ${starter.label}`),
      ),
    );
    return;
  }
  const result = generate({ env: state.env, selections, inputs: toInputValues(state.inputs) });
  const { deny = [], ask = [] } = result.settings.permissions;
  summary.textContent = `${deny.length} block · ${ask.length} ask`;
  summary.classList.add('has');

  const out: Child[] = [
    h(
      'div',
      { class: 'stats' },
      stat(String(deny.length), 'block rules'),
      stat(String(ask.length), 'ask rules'),
      stat(result.hook ? 'On' : 'Off', 'hook'),
      stat(result.settings.sandbox ? 'On' : 'Off', 'sandbox'),
    ),
  ];

  const hookWouldHelp = result.items.filter((i) => i.hookOnly.length > 0);
  if (state.env.hook === false && hookWouldHelp.length > 0) {
    out.push(
      h(
        'p',
        { class: 'callout' },
        h('strong', {}, 'Rules only. '),
        `The hook would catch more for ${hookWouldHelp.length} of your ${result.items.length} selections; each one below shows examples. Switch to "Rules plus hook" in step 1 to add it.`,
      ),
    );
  }
  const infraCount = result.items.filter((i) => i.id.startsWith('infra.')).length;
  if (infraCount >= 3) {
    out.push(
      h(
        'p',
        { class: 'callout' },
        h('strong', {}, 'Working with a lot of infrastructure? '),
        `You selected ${infraCount} infrastructure items. These cover the common destructive commands, not every service. `,
        h('a', { href: 'https://github.com/Dicklesworthstone/destructive_command_guard', target: '_blank', rel: 'noopener noreferrer' }, 'destructive_command_guard'),
        ' is a dedicated tool with around 50 packs for databases, Kubernetes, cloud providers, CI and more. It runs as a hook and can sit alongside these rules, which still handle what it does not: secret files, web domains and MCP tools.',
      ),
    );
  }
  if (result.warnings.length > 0) {
    const list = h('ul');
    for (const w of result.warnings) list.append(h('li', {}, w));
    out.push(h('div', { class: 'callout warn' }, h('strong', {}, 'Before you use this'), list));
  }

  const base = state.env.scope === 'project' ? '.claude' : '~/.claude';
  out.push(fileBlock('Settings', `${base}/settings.json`, 'settings.fragment.json', JSON.stringify(result.settings, null, 2) + '\n'));
  if (result.hook) {
    const root = result.hook.relativeTo === 'project' ? '' : '~/';
    out.push(
      fileBlock('Hook rules', root + result.hook.rulesPath, 'deny-guard.rules.json', JSON.stringify(result.hook.rules, null, 2) + '\n', 'Built from your selections; download it again whenever you change them.'),
      fileBlock('Hook script', root + result.hook.scriptPath, 'deny-guard.cjs', guardSource, 'The same for everyone; it reads the rules file next to it.'),
    );
  }
  out.push(h('div', { class: 'block' }, h('h3', {}, 'Install'), installSteps(result)));

  const gapList = h('div', { class: 'group' });
  for (const item of result.items) {
    const gaps = h('ul');
    for (const g of item.gaps) gaps.append(h('li', {}, g));
    gapList.append(
      disclosure(
        `gap:${item.id}`,
        [
          h('span', { class: 'gap-title' }, item.title),
          h('span', { class: 'tag' }, `${item.mode === 'deny' ? 'block' : 'ask'} · ${item.rules} rules`),
          item.skipped ? h('span', { class: 'skipped' }, `Skipped. ${item.skipped}`) : null,
        ],
        gaps,
        item.hookOnly.length > 0 ? hookExamples(item.hookOnly) : null,
        item.note ? h('p', { class: 'muted' }, item.note) : null,
      ),
    );
  }
  out.push(
    h('div', { class: 'block' }, h('h3', {}, 'What still gets through'), h('p', { class: 'muted' }, 'No rule set is complete. These are the known holes in what you selected.'), gapList),
  );

  const table = h('table', {}, h('tr', {}, h('th', {}, 'Rule'), h('th', {}, 'Mode'), h('th', {}, 'From')));
  for (const r of result.rules) {
    table.append(h('tr', {}, h('td', {}, h('code', {}, r.rule)), h('td', {}, r.mode === 'deny' ? 'block' : 'ask'), h('td', {}, r.items.join(', '))));
  }
  out.push(h('div', { class: 'group' }, disclosure('rule-table', ['Which selection produced each rule'], h('div', { class: 'table-wrap' }, table))));

  outputBody.replaceChildren(...out.filter((c): c is Node | string => Boolean(c)));
}

// ----------------------------------------------------------------- 5. tester

/** Not saved: what is typed here is only ever used to show a result on this page. */
const tester = { kind: 'shell' as 'shell' | 'Read' | 'Edit' | 'WebFetch' | 'Mcp', shell: 'Bash' as 'Bash' | 'PowerShell', text: '', branch: 'feature-branch' };

const TESTER_KINDS: { id: (typeof tester)['kind']; label: string; placeholder: string }[] = [
  { id: 'shell', label: 'Run a command', placeholder: 'git -C . push --force' },
  { id: 'Read', label: 'Read a file', placeholder: '~/.ssh/id_rsa' },
  { id: 'Edit', label: 'Edit a file', placeholder: '.claude/settings.json' },
  { id: 'WebFetch', label: 'Fetch a page', placeholder: 'https://pastebin.com/raw/abc' },
  { id: 'Mcp', label: 'Call an MCP tool', placeholder: 'mcp__slack__send_message' },
];

/** Stand-in folders. The tester cannot know the real ones, and the rules do not depend on them. */
function testerContext(): SimContext {
  const win = state.env.os === 'windows';
  return {
    win,
    home: win ? 'C:\\Users\\you' : '/home/you',
    projectDir: win ? 'C:\\Users\\you\\project' : '/home/you/project',
    tmpDirs: win ? ['C:\\Users\\you\\AppData\\Local\\Temp'] : ['/tmp', '/var/tmp'],
    currentBranch: tester.branch.trim() || null,
    scope: state.env.scope,
  };
}

/** The tester's shell picker, once rendered. Kept here so the environment step can update it. */
let testerShell: ReturnType<typeof segmented<'Bash' | 'PowerShell'>> | undefined;

/** Only offer PowerShell in the tester on native Windows, and fall back to Bash everywhere else. */
function testerSyncShell(): void {
  if (!testerShell) return;
  const allowed = shellAllowed(state.env.os, 'powershell');
  testerShell.disableOption('PowerShell', !allowed);
  if (!allowed) tester.shell = 'Bash';
  testerShell.set(tester.shell);
}

function renderTesterResult(): void {
  testerSyncShell();
  testerResultEl.replaceChildren();
  const text = tester.text.trim();
  const selections = toSelections(state.selected);
  if (!text) return;
  if (selections.length === 0) {
    testerResultEl.append(h('p', { class: 'muted' }, 'Select something in step 2 first.'));
    return;
  }
  const inputs = toInputValues(state.inputs);
  const result = generate({ env: state.env, selections, inputs });
  const hookOn = state.env.hook !== false;
  // Always work out what the hook would do, so the result can say what turning it on would add.
  const hookRules = (hookOn ? result : generate({ env: { ...state.env, hook: true }, selections, inputs })).hook?.rules;

  const call: Call = tester.kind === 'shell' ? { tool: tester.shell, input: assumeHome(text) } : { tool: tester.kind, input: tester.kind === 'Read' || tester.kind === 'Edit' ? assumeHome(text) : text };
  let sim;
  try {
    sim = simulate(call, result.rules, hookRules, guard, testerContext());
  } catch (err) {
    testerResultEl.append(h('p', { class: 'verdict bad' }, `Could not analyze that: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  const title = (id: string) => catalog.find((i) => i.id === id)?.title ?? id;
  const hookDecision = hookOn ? sim.hookDecision : 'allow';
  const decision = sim.ruleDecision === 'deny' || hookDecision === 'deny' ? 'deny' : sim.ruleDecision === 'ask' || hookDecision === 'ask' ? 'ask' : 'allow';
  const verdict =
    decision === 'deny' ? 'Blocked.' : decision === 'ask' ? 'Claude will ask you before doing this.' : 'Not stopped. Nothing you selected catches this.';
  testerResultEl.append(h('p', { class: `verdict ${decision === 'deny' ? 'ok' : decision === 'ask' ? 'warn' : 'bad'}` }, h('strong', {}, verdict)));

  if (sim.ruleHits.length > 0) {
    const list = h('ul');
    for (const hit of sim.ruleHits) {
      list.append(
        h('li', {}, h('code', {}, hit.rule), ` (${hit.mode === 'deny' ? 'block' : 'ask'}) from "${hit.items.map(title).join('", "')}"`, hit.via ? `, because ${hit.via}` : ''),
      );
    }
    testerResultEl.append(h('p', {}, 'Rules that match:'), list);
  } else {
    testerResultEl.append(h('p', {}, 'No rule matches.'));
  }

  if (call.tool === 'Bash' || call.tool === 'PowerShell') {
    if (sim.hookHits.length > 0) {
      const list = h('ul');
      for (const hit of sim.hookHits) list.append(h('li', {}, `"${hit.title}" (${hit.mode === 'deny' ? 'block' : 'ask'}): ${hit.reason}`));
      const heading = hookOn
        ? 'The hook catches it:'
        : sim.ruleDecision !== 'allow'
          ? 'The hook would catch it too. It is off, and the rules already cover this:'
          : h('span', {}, h('strong', {}, 'Only the hook would catch this, and it is off. '), 'Switch to "Rules plus hook" in step 1 to add it:');
      testerResultEl.append(h('p', {}, heading), list);
    } else {
      const none = hookOn ? 'The hook does not catch it.' : sim.ruleDecision !== 'allow' ? 'The hook would add nothing here.' : 'The hook would not catch it either.';
      testerResultEl.append(h('p', {}, none));
    }
  } else {
    testerResultEl.append(h('p', { class: 'muted' }, 'The hook only looks at shell commands, so it plays no part here.'));
  }
}

function renderTester(): HTMLElement {
  const input = h('input', {
    type: 'text',
    class: 'tester-input',
    spellcheck: false,
    autocapitalize: 'off',
    'aria-label': 'What Claude tries',
    oninput: () => {
      tester.text = input.value;
      renderTesterResult();
    },
  });

  const shell = segmented(
    'Shell',
    [
      ['Bash', 'Bash'],
      ['PowerShell', 'PowerShell'],
    ] as const,
    tester.shell,
    (value) => {
      tester.shell = value;
      renderTesterResult();
    },
    true,
  );
  testerShell = shell;
  const branch = h('input', {
    type: 'text',
    class: 'branch-input',
    value: tester.branch,
    size: 16,
    spellcheck: false,
    oninput: () => {
      tester.branch = branch.value;
      renderTesterResult();
    },
  });
  const shellOptions = h('div', { class: 'tester-options' }, 'in', shell.el, h('label', {}, 'on git branch ', branch));

  const example = h('button', {
    type: 'button',
    class: 'link',
    onclick: () => {
      input.value = tester.text = input.placeholder;
      renderTesterResult();
      input.focus();
    },
  });
  const sync = () => {
    input.placeholder = TESTER_KINDS.find((k) => k.id === tester.kind)!.placeholder;
    example.replaceChildren('Try ', h('code', {}, input.placeholder));
    shellOptions.hidden = tester.kind !== 'shell';
  };
  const kind = segmented(
    'Claude tries to',
    TESTER_KINDS.map((k) => [k.id, k.label] as const),
    tester.kind,
    (value) => {
      tester.kind = value;
      sync();
      renderTesterResult();
    },
  );
  sync();

  return step(
    'try',
    'Try it',
    'Type something Claude might do and see whether your selections would stop it, and which rule does.',
    h('div', { class: 'card tester' }, h('div', { class: 'field-label' }, 'Claude tries to'), kind.el, input, h('div', { class: 'tester-meta' }, shellOptions, example), testerResultEl),
    h(
      'p',
      { class: 'muted fine' },
      'This follows the matching behaviour Claude Code documents; it is not Claude Code itself, so a real session is the final word. ',
      'Paths are judged as if the project is your current folder. A path under your home folder can be typed as ~/... or in full.',
    ),
  );
}

// ------------------------------------------------------------ step navigation

const navLinks = new Map<StepId, { link: HTMLAnchorElement; badge: HTMLElement }>();

function renderNav(): void {
  const nav = document.getElementById('steps')!;
  STEPS.forEach((s, i) => {
    const badge = h('span', { class: 'badge', hidden: true });
    const link = h('a', { href: `#${s.id}` }, h('span', { class: 'nav-num', 'aria-hidden': 'true' }, String(i + 1)), s.label, badge);
    navLinks.set(s.id, { link, badge });
    nav.append(link);
  });
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const [id, { link }] of navLinks) {
          if (id === entry.target.id) link.setAttribute('aria-current', 'step');
          else link.removeAttribute('aria-current');
        }
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  );
  for (const s of STEPS) spy.observe(document.getElementById(s.id)!);
}

/** The bar shows how far along the user is: what is picked, and what still needs filling in. */
function syncNav(): void {
  const setBadge = (id: StepId, text: string, warn = false) => {
    const { badge } = navLinks.get(id)!;
    badge.hidden = text === '';
    badge.textContent = text;
    badge.classList.toggle('warn', warn);
  };
  const count = Object.keys(state.selected).length;
  const missing = neededInputs(state.selected).filter(isMissing).length;
  setBadge('protect', count > 0 ? String(count) : '');
  setBadge('details', missing > 0 ? `${missing} to fill in` : '', true);
}

app.append(
  renderEnvironment(),
  renderProtections(),
  step('details', 'Your details', 'The few things only you know, such as which branches and paths matter.', detailsBody),
  step('rules', 'Your rules', 'Updated as you choose. Copy them in when you are happy.', outputBody),
  renderTester(),
);
document.body.append(toastEl);
renderNav();
renderDetails();
renderOutput();
syncNav();
