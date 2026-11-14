import { catalog, inputs as inputDefs, itemApplies, toolIds, type ToolId } from '../catalog';
import type { InputDef, Mode } from '../catalog/schema';
import type { Environment, InputValues, Os, Selection, Shell } from '../generator/generate';

/** Everything the page remembers. List inputs are kept as the raw textarea text. */
export interface AppState {
  env: Environment;
  /** Selected item id -> chosen mode. */
  selected: Record<string, Mode>;
  inputs: Record<string, string | boolean>;
}

/** Git Bash is the usual shell for Claude Code on Windows, with the PowerShell tool alongside it. */
export function defaultShells(os: Os): Shell[] {
  return os === 'windows' ? ['bash', 'powershell'] : ['bash'];
}

/** PowerShell is only offered on native Windows. Claude Code's PowerShell tool does not run on macOS, Linux or WSL2. */
export function shellAllowed(os: Os, shell: Shell): boolean {
  return shell === 'bash' || os === 'windows';
}

/** Drops choices that cannot happen on the chosen OS, so stale saved settings never reach the output. */
export function normalizeEnv(env: Environment): Environment {
  return {
    ...env,
    shells: env.shells.filter((s) => shellAllowed(env.os, s)),
    // Native Windows has no sandbox, so the control is disabled there and must not stay on.
    sandbox: env.os === 'windows' ? 'off' : env.sandbox,
  };
}

export function guessOs(platform: string): Os {
  const p = platform.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'macos';
  return 'linux';
}

export function initialState(os: Os): AppState {
  const state: AppState = {
    // Rules only by default: pasting JSON is the simpler install. The hook is opt-in.
    env: { os, shells: defaultShells(os), scope: 'project', sandbox: 'off', hook: false, hookFailClosed: true, tools: [] },
    selected: {},
    inputs: {},
  };
  for (const def of inputDefs) {
    if (def.kind === 'boolean') state.inputs[def.id] = def.default === true;
    else state.inputs[def.id] = Array.isArray(def.default) ? def.default.join('\n') : '';
  }
  return state;
}

/** One entry per line. Commas are left alone because paths may contain them. */
export function parseList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toInputValues(raw: AppState['inputs'], defs: InputDef[] = inputDefs): InputValues {
  const out: InputValues = {};
  for (const def of defs) {
    const v = raw[def.id];
    if (def.kind === 'boolean') out[def.id] = v === true;
    else out[def.id] = parseList(typeof v === 'string' ? v : '');
  }
  return out;
}

export function toSelections(selected: AppState['selected']): Selection[] {
  // Catalog order, so the output does not depend on the order boxes were ticked.
  return catalog.filter((item) => item.id in selected).map((item) => ({ id: item.id, mode: selected[item.id] }));
}

/** Input ids needed by the current selection, in registry order. */
export function neededInputs(selected: AppState['selected']): InputDef[] {
  const ids = new Set(catalog.filter((item) => item.id in selected).flatMap((item) => item.inputs ?? []));
  return inputDefs.filter((def) => ids.has(def.id));
}

const essentialIds = () => catalog.filter((i) => i.essential).map((i) => i.id);
const teamIds = () => [
  ...essentialIds(),
  'secrets.key-files',
  'secrets.package-tokens',
  'local.git-history-loss',
  'remote.delete-remote-refs',
  'remote.github-destructive',
];
const productionIds = () => [...teamIds(), ...catalog.filter((i) => i.category === 'infra').map((i) => i.id)];

export const presets: { id: string; label: string; hint: string; ids: () => string[] }[] = [
  { id: 'essentials', label: 'Essentials', hint: 'Secrets, lost work, force push and publishing. A sensible start for anyone.', ids: essentialIds },
  { id: 'team', label: 'Team repo', hint: 'Essentials, plus shared-repo damage: deleting branches, repos and releases, and publish tokens.', ids: teamIds },
  {
    id: 'production',
    label: 'Production access',
    hint: 'Team repo, plus databases, clusters, cloud accounts and the machine itself. For a computer that can reach real systems.',
    ids: productionIds,
  },
  { id: 'all', label: 'Everything', hint: 'Every item. Expect to fill in several details and to be asked often.', ids: () => catalog.map((i) => i.id) },
  { id: 'none', label: 'Clear', hint: 'Untick everything.', ids: () => [] },
];

/** A preset's items, minus any that none of the picked tools use. */
export function presetIds(preset: (typeof presets)[number], tools: readonly ToolId[] = []): string[] {
  const ids = new Set(preset.ids());
  return catalog.filter((i) => ids.has(i.id) && itemApplies(i, tools)).map((i) => i.id);
}

export function applyPreset(ids: string[]): AppState['selected'] {
  const out: AppState['selected'] = {};
  for (const item of catalog) if (ids.includes(item.id)) out[item.id] = item.defaultMode;
  return out;
}

const STORAGE_KEY = 'deny-rule-builder:v1';

/** Stored in this browser only. Nothing typed here is sent anywhere. */
export function saveState(state: AppState, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the page still works, it just forgets on reload.
  }
}

export function loadState(storage: Pick<Storage, 'getItem'>, fallback: AppState): AppState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<AppState>;
    const known = new Set(catalog.map((i) => i.id));
    const selected: AppState['selected'] = {};
    for (const [id, mode] of Object.entries(saved.selected ?? {})) {
      if (known.has(id) && (mode === 'deny' || mode === 'ask')) selected[id] = mode;
    }
    const knownTools = new Set<string>(toolIds);
    const tools = (Array.isArray(saved.env?.tools) ? saved.env.tools : []).filter((t): t is ToolId => knownTools.has(t));
    return {
      env: normalizeEnv({ ...fallback.env, ...(saved.env ?? {}), tools }),
      selected,
      inputs: { ...fallback.inputs, ...(saved.inputs ?? {}) },
    };
  } catch {
    return fallback;
  }
}
