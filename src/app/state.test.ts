import { describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import { generate } from '../generator/generate';
import {
  applyPreset,
  guessOs,
  initialState,
  loadState,
  neededInputs,
  parseList,
  presets,
  saveState,
  toInputValues,
  toSelections,
} from './state';

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe('page state', () => {
  it('guesses the OS from the browser platform', () => {
    expect(guessOs('Win32')).toBe('windows');
    expect(guessOs('MacIntel')).toBe('macos');
    expect(guessOs('Linux x86_64')).toBe('linux');
  });

  it('starts with defaults filled in so the user can see and edit them', () => {
    const s = initialState('windows');
    expect(s.env.shells).toEqual(['bash', 'powershell']);
    expect(s.inputs.protectedBranches).toBe('main\nmaster');
    expect(s.inputs.allowForceWithLease).toBe(true);
    expect(s.inputs.secretPaths).toBe('');
  });

  it('reads one entry per line and keeps commas', () => {
    expect(parseList(' a \r\n\n b,c \n')).toEqual(['a', 'b,c']);
  });

  it('asks only for inputs the selection needs', () => {
    expect(neededInputs({})).toEqual([]);
    expect(neededInputs({ 'secrets.env-files': 'deny', 'remote.force-push': 'deny' }).map((d) => d.id)).toEqual([
      'envExceptions',
      'allowForceWithLease',
    ]);
  });

  it('keeps selections in catalog order with their modes', () => {
    const sel = toSelections({ 'remote.publish': 'deny', 'secrets.ssh-keys': 'deny' });
    expect(sel).toEqual([
      { id: 'secrets.ssh-keys', mode: 'deny' },
      { id: 'remote.publish', mode: 'deny' },
    ]);
  });

  it('offers presets that select real items with their default modes', () => {
    const essentials = applyPreset(presets.find((p) => p.id === 'essentials')!.ids());
    expect(Object.keys(essentials).length).toBeGreaterThan(5);
    expect(essentials['remote.protected-branches']).toBe('ask');
    expect(Object.keys(applyPreset(presets.find((p) => p.id === 'all')!.ids()))).toHaveLength(catalog.length);
    expect(applyPreset(presets.find((p) => p.id === 'none')!.ids())).toEqual({});
  });

  it('produces output for the essentials preset with no typing', () => {
    const s = initialState('macos');
    s.selected = applyPreset(presets.find((p) => p.id === 'essentials')!.ids());
    const r = generate({ env: s.env, selections: toSelections(s.selected), inputs: toInputValues(s.inputs) });
    expect(r.items.filter((i) => i.skipped)).toEqual([]);
    expect(r.settings.permissions.deny!.length).toBeGreaterThan(20);
    expect(r.hook).toBeDefined();
  });

  it('round-trips through storage and drops what it does not recognise', () => {
    const storage = memoryStorage();
    const s = initialState('linux');
    s.selected = { 'secrets.env-files': 'ask' };
    s.inputs.secretPaths = '~/vault';
    s.env.scope = 'user';
    saveState(s, storage);
    expect(loadState(storage, initialState('linux'))).toEqual(s);

    storage.data.set('deny-rule-builder:v1', JSON.stringify({ selected: { 'gone.item': 'deny', 'secrets.ssh-keys': 'nope' } }));
    expect(loadState(storage, initialState('linux')).selected).toEqual({});
    storage.data.set('deny-rule-builder:v1', '{not json');
    expect(loadState(storage, initialState('linux'))).toEqual(initialState('linux'));
  });
});
