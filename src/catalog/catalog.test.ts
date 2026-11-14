import { describe, expect, it } from 'vitest';
import { catalog, categories, inputs } from './index';
import type { CatalogItem, Condition, HookCheck, PathSpec, Rule } from './schema';

/**
 * Structural checks only. Whether a rule or hook check actually catches a
 * test case is verified once the matcher simulator and hook exist.
 */

const inputById = new Map(inputs.map((i) => [i.id, i]));

function pathSpecs(item: CatalogItem): PathSpec[] {
  const fromRules = item.rules.flatMap((r) => (r.kind === 'path' ? r.paths : []));
  const fromHook = (item.hook ?? []).flatMap((h) => (h.type === 'touchesPath' ? h.paths : []));
  return [...fromRules, ...fromHook];
}

function commandPatterns(item: CatalogItem): string[] {
  return item.rules.flatMap((r) =>
    r.kind === 'command' ? [...(r.any ?? []), ...(r.bash ?? []), ...(r.powershell ?? [])] : [],
  );
}

/** Every input id an item refers to anywhere, with the kind it must have. */
function inputRefs(item: CatalogItem): { id: string; kinds: string[] }[] {
  const refs: { id: string; kinds: string[] }[] = [];
  const cond = (c?: Condition) => c && refs.push({ id: c.input, kinds: ['boolean'] });
  const rule = (r: Rule) => {
    if (r.kind === 'path') {
      if (r.exceptInput) refs.push({ id: r.exceptInput, kinds: ['filename-list'] });
    } else if (r.kind === 'command') {
      cond(r.when);
    } else if (r.kind === 'domain') {
      refs.push({ id: r.input, kinds: ['domain-list'] });
    } else {
      refs.push({ id: r.input, kinds: ['mcp-tool-list'] });
    }
  };
  const hook = (h: HookCheck) => {
    cond(h.when);
    if (h.type === 'touchesPath' && h.exceptInput) refs.push({ id: h.exceptInput, kinds: ['filename-list'] });
    if (h.type === 'mentionsDomain') refs.push({ id: h.input, kinds: ['domain-list'] });
    if (h.type === 'builtin' && h.name !== 'recursive-delete-outside-project') {
      refs.push({ id: 'protectedBranches', kinds: ['string-list'] });
    }
  };
  item.rules.forEach(rule);
  (item.hook ?? []).forEach(hook);
  for (const p of pathSpecs(item)) if ('input' in p) refs.push({ id: p.input, kinds: ['path-list'] });
  for (const pat of commandPatterns(item)) {
    for (const m of pat.matchAll(/\{(\w+)\}/g)) refs.push({ id: m[1]!, kinds: ['string-list'] });
  }
  return refs;
}

describe('input registry', () => {
  it('has unique ids', () => {
    expect(new Set(inputs.map((i) => i.id)).size).toBe(inputs.length);
  });

  it('gives each input a default of the right shape', () => {
    for (const i of inputs) {
      if (i.default === undefined) continue;
      expect(typeof i.default === 'boolean', i.id).toBe(i.kind === 'boolean');
    }
  });

  it('has no input that no item uses', () => {
    const used = new Set(catalog.flatMap((item) => item.inputs ?? []));
    expect(inputs.filter((i) => !used.has(i.id)).map((i) => i.id)).toEqual([]);
  });
});

describe('catalog', () => {
  it('has unique ids', () => {
    expect(new Set(catalog.map((i) => i.id)).size).toBe(catalog.length);
  });

  it('covers every category', () => {
    for (const c of categories) expect(catalog.some((i) => i.category === c.id), c.id).toBe(true);
  });
});

describe.each(catalog.map((item) => [item.id, item] as const))('%s', (_id, item) => {
  it('has an id prefixed with its category', () => {
    expect(item.id).toMatch(new RegExp(`^${item.category}\\.[a-z0-9-]+$`));
  });

  it('emits something and states its gaps', () => {
    expect(item.rules.length + (item.hook?.length ?? 0)).toBeGreaterThan(0);
    expect(item.gaps.length).toBeGreaterThan(0);
    for (const text of [item.title, item.stops, item.why, ...item.gaps]) expect(text.trim()).not.toBe('');
  });

  it('declares every input it refers to, with the right kind', () => {
    const declared = new Set(item.inputs ?? []);
    for (const ref of inputRefs(item)) {
      expect(declared.has(ref.id), `${ref.id} not listed in inputs`).toBe(true);
      const def = inputById.get(ref.id);
      expect(def, `${ref.id} not in registry`).toBeDefined();
      expect(ref.kinds, `${ref.id} has kind ${def!.kind}`).toContain(def!.kind);
    }
    const referenced = new Set(inputRefs(item).map((r) => r.id));
    for (const id of declared) expect(referenced.has(id), `${id} listed but unused`).toBe(true);
  });

  it('provides sample values for required inputs', () => {
    for (const id of item.inputs ?? []) {
      const def = inputById.get(id)!;
      if (def.required && def.default === undefined) {
        const sample = item.sampleInputs?.[id];
        expect(Array.isArray(sample) && sample.length > 0, `sampleInputs.${id}`).toBe(true);
      }
    }
    for (const id of Object.keys(item.sampleInputs ?? {})) {
      expect(item.inputs ?? [], `sampleInputs.${id} is not an input of this item`).toContain(id);
    }
  });

  it('writes well-formed path globs', () => {
    for (const p of pathSpecs(item)) {
      if ('input' in p) continue;
      expect(p.glob, 'no leading slash or ~').not.toMatch(/^[/~]/);
      expect(p.glob, 'forward slashes only').not.toContain('\\');
      expect(p.glob.trim()).not.toBe('');
    }
  });

  it('only carves exceptions out of anywhere-anchored paths', () => {
    const withExcept = [
      ...item.rules.flatMap((r) => (r.kind === 'path' && r.exceptInput ? [r.paths] : [])),
      ...(item.hook ?? []).flatMap((h) => (h.type === 'touchesPath' && h.exceptInput ? [h.paths] : [])),
    ];
    for (const paths of withExcept) {
      for (const p of paths) expect('anchor' in p && p.anchor === 'anywhere').toBe(true);
    }
  });

  it('writes well-formed command patterns', () => {
    // The same pattern may appear once per shell, but not twice for one shell.
    for (const shell of ['bash', 'powershell'] as const) {
      const perShell = item.rules.flatMap((r) => (r.kind === 'command' ? [...(r.any ?? []), ...(r[shell] ?? [])] : []));
      expect(new Set(perShell).size, `duplicate ${shell} pattern`).toBe(perShell.length);
    }
    for (const pat of commandPatterns(item)) {
      expect(pat, 'untrimmed').toBe(pat.trim());
      expect(pat, 'empty').not.toBe('');
      // Claude Code reads a trailing `:*` as another spelling of ` *`, so `Env:*` would mean `Env *`.
      expect(pat.endsWith(':*'), `"${pat}" ends with :*`).toBe(false);
      // A leading wildcard would match every program.
      // The one allowed exception is `*{input}*`: any command containing a value the user gave.
      if (/^\*\{\w+\}\*$/.test(pat)) continue;
      expect(pat.startsWith('*'), `"${pat}" starts with *`).toBe(false);
      // The words before the first * are what limit the rule; require a real program name.
      expect(pat.split('*')[0]!.trim().length, `"${pat}" has no fixed prefix`).toBeGreaterThan(1);
    }
  });

  it('has hook regexes that compile', () => {
    for (const h of item.hook ?? []) {
      if (h.type === 'regex') expect(() => new RegExp(h.pattern, h.flags)).not.toThrow();
      expect(h.message.trim(), 'hook message').not.toBe('');
    }
  });

  it('has tests that show both what it stops and what it leaves alone', () => {
    expect(item.tests.some((t) => t.expect === 'block')).toBe(true);
    expect(item.tests.some((t) => t.expect === 'allow' && !t.gap)).toBe(true);
    const keys = item.tests.map((t) => `${t.tool}\u0000${t.input}`);
    expect(new Set(keys).size, 'duplicate test').toBe(keys.length);
  });

  it('labels each test consistently', () => {
    const hasCommandRules = item.rules.some((r) => r.kind === 'command');
    const canHookCatch = (item.hook?.length ?? 0) > 0 || hasCommandRules;
    for (const t of item.tests) {
      if (t.expect === 'block') {
        expect(t.by, `"${t.input}" needs by`).toBeDefined();
        expect(t.gap, `"${t.input}" is a block, not a gap`).toBeUndefined();
        if (t.by === 'rule') expect(item.rules.length, `"${t.input}" by rule`).toBeGreaterThan(0);
        if (t.by === 'hook') {
          expect(canHookCatch, `"${t.input}" by hook but item has nothing for the hook`).toBe(true);
          // The hook only sees shell commands.
          expect(['Bash', 'PowerShell'], `"${t.input}" by hook`).toContain(t.tool);
        }
      } else {
        expect(t.by, `"${t.input}" is allowed, so no by`).toBeUndefined();
      }
    }
  });

  it('tests PowerShell when it has PowerShell patterns', () => {
    const hasPs = item.rules.some((r) => r.kind === 'command' && (r.powershell?.length ?? 0) > 0);
    if (hasPs) expect(item.tests.some((t) => t.tool === 'PowerShell')).toBe(true);
  });
});
