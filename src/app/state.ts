import { catalog, inputs as inputDefs } from '../catalog';
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

export function guessOs(platform: string): Os {
  const p = platform.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'macos';
  return 'linux';
}

export function initialState(os: Os): AppState {
  const state: AppState = {
    env: { os, shells: defaultShells(os), scope: 'project', sandbox: 'off', hookFailClosed: true },
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

export const presets: { id: string; label: string; ids: () => string[] }[] = [
  { id: 'essentials', label: 'Essentials', ids: () => catalog.filter((i) => i.essential).map((i) => i.id) },
  { id: 'all', label: 'Everything', ids: () => catalog.map((i) => i.id) },
  { id: 'none', label: 'Clear', ids: () => [] },
];

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
    return {
      env: { ...fallback.env, ...(saved.env ?? {}) },
      selected,
      inputs: { ...fallback.inputs, ...(saved.inputs ?? {}) },
    };
  } catch {
    return fallback;
  }
}
