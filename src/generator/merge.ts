import type { HookHandler, SettingsFragment } from './generate';

/**
 * Merges generated settings into a settings file the person already has.
 *
 * Only `permissions`, `hooks` and `sandbox` are touched. Every other key is
 * copied through unchanged and in its original order, so things like `env`
 * (which often holds API keys) come out exactly as they went in.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export type PastedKind = 'file' | 'permissions';

export type MergeResult =
  | {
      ok: true;
      /** `file`: a whole settings.json. `permissions`: just the value of its `permissions` key. */
      kind: PastedKind;
      merged: Obj;
      added: number;
      /** Rules and hook entries that were already there. */
      skipped: number;
      /** Rules taken out of `ask` because they are now blocked. */
      moved: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys that only appear at the top of a `permissions` value, not at the top of settings.json. */
const PERMISSION_KEYS = new Set(['allow', 'deny', 'ask', 'defaultMode', 'additionalDirectories', 'disableBypassPermissionsMode']);

/**
 * Parses what was pasted. Also accepts a bare `"permissions": { ... }` line
 * copied out of a file, with or without a trailing comma.
 */
export function parsePasted(text: string): { ok: true; value: Obj } | { ok: false; error: string } {
  const trimmed = text.trim();
  let first: unknown;
  try {
    first = JSON.parse(trimmed);
  } catch (e) {
    // `"permissions": { ... },` is not JSON on its own, but wrapping it makes it so.
    if (trimmed.startsWith('"')) {
      try {
        const wrapped: unknown = JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`);
        if (isObj(wrapped)) return { ok: true, value: wrapped };
      } catch {
        // Fall through to the original error, which points at the real problem.
      }
    }
    const message = e instanceof Error ? e.message : String(e);
    const hint = /\/\/|\/\*/.test(trimmed) ? ' It looks like it has comments, which settings.json does not allow. Remove them and paste again.' : '';
    return { ok: false, error: `That is not valid JSON: ${message}.${hint}` };
  }
  if (!isObj(first)) return { ok: false, error: 'Paste a JSON object: the whole settings.json, or the part inside "permissions".' };
  return { ok: true, value: first };
}

export function detectKind(value: Obj): PastedKind {
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((k) => PERMISSION_KEYS.has(k))) return 'permissions';
  return 'file';
}

const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

interface PermissionMerge {
  value: Obj;
  added: number;
  skipped: number;
  moved: string[];
  warnings: string[];
}

function mergePermissions(existing: Obj, ours: SettingsFragment['permissions']): PermissionMerge {
  const value: Obj = { ...existing };
  const warnings: string[] = [];
  const moved: string[] = [];
  let added = 0;
  let skipped = 0;

  const deny = strings(existing.deny);
  const ask = strings(existing.ask);
  const allow = new Set(strings(existing.allow));
  const denySet = new Set(deny);
  const askSet = new Set(ask);

  for (const rule of ours.deny ?? []) {
    if (denySet.has(rule)) {
      skipped++;
      continue;
    }
    deny.push(rule);
    denySet.add(rule);
    added++;
    if (askSet.delete(rule)) moved.push(rule);
  }
  for (const rule of ours.ask ?? []) {
    // Already blocked is stricter than asking, so leave it blocked.
    if (askSet.has(rule) || denySet.has(rule)) {
      skipped++;
      continue;
    }
    ask.push(rule);
    askSet.add(rule);
    added++;
  }

  const overlap = [...(ours.deny ?? []), ...(ours.ask ?? [])].filter((r) => allow.has(r));
  if (overlap.length > 0) {
    warnings.push(
      `Your allow list also has ${overlap.length === 1 ? 'this rule' : 'these rules'}: ${overlap.join(', ')}. Block and ask rules win over allow, so the protection still works, but you may want to remove ${overlap.length === 1 ? 'it' : 'them'} from allow.`,
    );
  }

  // A `!` carve-out of ours lands after everything already in the list, so it
  // would also lift a block the person wrote themselves for the same path.
  const lifted = (ours.deny ?? []).filter((r) => r.includes('(!') && denySet.has(r.replace('(!', '(')) && !(ours.deny ?? []).includes(r.replace('(!', '(')));
  if (lifted.length > 0) {
    warnings.push(`These exceptions now come after your own rule for the same path and undo it: ${lifted.join(', ')}. Remove the exception if you want your rule to keep blocking.`);
  }

  if (existing.deny !== undefined || deny.length > 0) value.deny = deny;
  if (existing.ask !== undefined || ask.length > 0) value.ask = ask.filter((r) => askSet.has(r));
  return { value, added, skipped, moved, warnings };
}

const sameHandler = (a: Json, b: HookHandler): boolean => isObj(a) && a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);

function mergeHooks(existing: Obj, ours: NonNullable<SettingsFragment['hooks']>): { value: Obj; added: number; skipped: number } {
  const value: Obj = { ...existing };
  const groups: Json[] = Array.isArray(existing.PreToolUse) ? existing.PreToolUse.map((g) => (isObj(g) ? { ...g, hooks: Array.isArray(g.hooks) ? [...g.hooks] : [] } : g)) : [];
  let added = 0;
  let skipped = 0;
  for (const group of ours.PreToolUse) {
    for (const handler of group.hooks) {
      const present = groups.some((g) => isObj(g) && g.matcher === group.matcher && Array.isArray(g.hooks) && g.hooks.some((x) => sameHandler(x, handler)));
      if (present) {
        skipped++;
        continue;
      }
      const target = groups.find((g): g is Obj => isObj(g) && g.matcher === group.matcher && Array.isArray(g.hooks));
      if (target) (target.hooks as Json[]).push(handler as unknown as Json);
      else groups.push({ matcher: group.matcher, hooks: [handler as unknown as Json] });
      added++;
    }
  }
  value.PreToolUse = groups;
  return { value, added, skipped };
}

function mergeSandbox(existing: Obj, ours: NonNullable<SettingsFragment['sandbox']>, warnings: string[]): Obj {
  const value: Obj = { ...existing };
  const changed: string[] = [];
  for (const [key, v] of Object.entries(ours) as [string, Json][]) {
    if (key in existing && existing[key] !== v) changed.push(`${key} (was ${JSON.stringify(existing[key])})`);
    value[key] = v;
  }
  if (changed.length > 0) warnings.push(`These sandbox settings were changed to match what you chose: ${changed.join(', ')}.`);
  return value;
}

/** Merges `ours` into the pasted text. Nothing here is stored or sent anywhere. */
export function mergeSettings(pasted: string, ours: SettingsFragment): MergeResult {
  const parsed = parsePasted(pasted);
  if (!parsed.ok) return parsed;
  const kind = detectKind(parsed.value);
  const warnings: string[] = [];

  if (kind === 'permissions') {
    const p = mergePermissions(parsed.value, ours.permissions);
    warnings.push(...p.warnings);
    const merged: Obj = { permissions: p.value };
    if (ours.hooks) merged.hooks = ours.hooks as unknown as Json;
    if (ours.sandbox) merged.sandbox = ours.sandbox as unknown as Json;
    if (ours.hooks || ours.sandbox) {
      warnings.push('You pasted only the permissions section, so hooks and sandbox are shown as new. If your file already has either, add these entries to it by hand, or paste the whole file instead.');
    }
    return { ok: true, kind, merged, added: p.added, skipped: p.skipped, moved: p.moved, warnings };
  }

  const file = parsed.value;
  for (const key of ['permissions', 'hooks', 'sandbox'] as const) {
    if (key in file && !isObj(file[key])) return { ok: false, error: `"${key}" in your file is not an object, so it cannot be merged. Fix it and paste again.` };
  }

  const p = mergePermissions((file.permissions as Obj | undefined) ?? {}, ours.permissions);
  warnings.push(...p.warnings);
  let added = p.added;
  let skipped = p.skipped;

  // Rebuild in the original key order, adding new keys at the end.
  const merged: Obj = {};
  const replacements: Obj = { permissions: p.value };
  if (ours.hooks) {
    const hk = mergeHooks((file.hooks as Obj | undefined) ?? {}, ours.hooks);
    replacements.hooks = hk.value;
    added += hk.added;
    skipped += hk.skipped;
    if (file.disableAllHooks === true) warnings.push('Your file sets "disableAllHooks": true, which turns the hook off. Remove it or set it to false.');
  }
  if (ours.sandbox) replacements.sandbox = mergeSandbox((file.sandbox as Obj | undefined) ?? {}, ours.sandbox, warnings);

  for (const [key, v] of Object.entries(file)) merged[key] = replacements[key] ?? v;
  for (const [key, v] of Object.entries(replacements)) if (!(key in merged)) merged[key] = v;

  return { ok: true, kind, merged, added, skipped, moved: p.moved, warnings };
}
