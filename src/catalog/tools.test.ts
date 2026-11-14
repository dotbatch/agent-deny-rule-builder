import { describe, expect, it } from 'vitest';
import { generate, type Environment } from '../generator/generate';
import { catalog } from './index';
import { commandTool, itemApplies, itemTools, toolGroups, tools } from './tools';

const env: Environment = { os: 'linux', shells: ['bash', 'powershell'], scope: 'project', sandbox: 'off', hook: true };
const item = (id: string) => catalog.find((i) => i.id === id)!;

describe('tool list', () => {
  it('has unique ids, and every group is used', () => {
    expect(new Set(tools.map((t) => t.id)).size).toBe(tools.length);
    for (const g of toolGroups) expect(tools.some((t) => t.group === g.id), g.id).toBe(true);
  });

  it('every tool is used by at least one catalog item', () => {
    const used = new Set(catalog.flatMap(itemTools));
    for (const t of tools) expect(used.has(t.id), t.id).toBe(true);
  });

  it('knows which tool an example command runs', () => {
    expect(commandTool('az --subscription dev group delete -n rg')).toBe('azure');
    expect(commandTool('Remove-AzResourceGroup -Name rg')).toBe('azure');
    expect(commandTool('/usr/bin/dropdb app')).toBe('postgres');
    expect(commandTool('npx prisma migrate reset')).toBe('prisma');
    expect(commandTool('./mvnw help:effective-settings')).toBe('maven');
    expect(commandTool('mvn.cmd clean')).toBe('maven');
    expect(commandTool('php artisan db:wipe')).toBe('laravel');
    expect(commandTool('git push --force')).toBeUndefined();
  });

  it('each tagged item test case runs a tool the item has rules or checks for', () => {
    for (const i of catalog) {
      const own = new Set(itemTools(i));
      // Only items made entirely of tagged rules: an untagged rule covers any tool.
      if (own.size === 0 || i.rules.some((r) => r.kind !== 'command' || !r.tool)) continue;
      for (const t of i.tests) {
        const tool = commandTool(t.input);
        if (tool && t.expect === 'block') expect(own.has(tool), `${i.id}: ${t.input}`).toBe(true);
      }
    }
  });
});

describe('picking tools', () => {
  it('with nothing picked, every tool is covered', () => {
    const all = generate({ env, selections: [{ id: 'infra.cloud-cli' }] });
    const none = generate({ env: { ...env, tools: [] }, selections: [{ id: 'infra.cloud-cli' }] });
    expect(none.rules).toEqual(all.rules);
    expect(all.rules.some((r) => r.rule.startsWith('Bash(aws '))).toBe(true);
  });

  it('Azure only: Azure CLI and Azure PowerShell rules, nothing for AWS or Google Cloud', () => {
    const r = generate({ env: { ...env, tools: ['azure'] }, selections: [{ id: 'infra.cloud-cli' }] });
    const rules = r.rules.map((x) => x.rule);
    expect(rules).toContain('Bash(az group delete *)');
    expect(rules).toContain('PowerShell(Remove-AzResourceGroup*)');
    expect(rules.some((x) => /\((aws|gcloud|gsutil|vercel) /.test(x))).toBe(false);
    const checks = r.hook!.rules.items[0]!.checks;
    expect(checks.every((c) => c.type !== 'regex' || !c.program || c.program.includes('az'))).toBe(true);
    // Hook-only examples are only ones for the picked tool.
    expect(r.items[0]!.hookOnly.every((c) => commandTool(c) === 'azure')).toBe(true);
    expect(r.items[0]!.hookOnly.length).toBeGreaterThan(0);
  });

  it('an item none of the picked tools use is skipped and adds nothing', () => {
    expect(itemApplies(item('infra.kubernetes'), ['azure'])).toBe(false);
    expect(itemApplies(item('infra.production-targets'), ['azure'])).toBe(true);
    expect(itemApplies(item('infra.system'), ['azure'])).toBe(true);
    const r = generate({ env: { ...env, tools: ['azure'] }, selections: [{ id: 'infra.kubernetes' }] });
    expect(r.rules).toEqual([]);
    expect(r.hook).toBeUndefined();
    expect(r.items[0]!.skipped).toBe('None of the tools you picked use this.');
  });

  it('Maven: the settings file is blocked whatever is picked, the print command only with Maven', () => {
    const sel = [{ id: 'secrets.maven-settings' }];
    const withMaven = generate({ env: { ...env, tools: ['maven'] }, selections: sel }).rules.map((x) => x.rule);
    const withoutMaven = generate({ env: { ...env, tools: ['aws'] }, selections: sel }).rules.map((x) => x.rule);
    expect(withMaven).toContain('Bash(mvn help:effective-settings *)');
    expect(withoutMaven.some((x) => x.includes('effective-settings'))).toBe(false);
    expect(withoutMaven.some((x) => x.includes('.m2/settings.xml'))).toBe(true);
  });

  it('the Azure subscription check is left out when Azure is not picked', () => {
    const inputs = { prodIdentifiers: ['acme-prod'] };
    const sel = [{ id: 'infra.production-targets' }];
    const withAzure = generate({ env: { ...env, tools: ['azure'] }, selections: sel, inputs });
    const withoutAzure = generate({ env: { ...env, tools: ['aws'] }, selections: sel, inputs });
    const names = (r: typeof withAzure) => r.hook!.rules.items[0]!.checks.map((c) => (c.type === 'builtin' ? c.name : c.type));
    expect(names(withAzure)).toEqual(['azure-default-subscription']);
    expect(names(withoutAzure)).toEqual([]);
    expect(withAzure.hook!.rules.items[0]!.checks[0]).toMatchObject({ values: ['acme-prod'] });
  });
});
