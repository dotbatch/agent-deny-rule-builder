import type { CatalogItem } from './schema';

/**
 * Tools a person may have on the machine. Command rules and hook checks that
 * only matter for one tool are tagged with its id, so someone who uses only
 * Azure does not get AWS and Google Cloud rules, and presets skip items that
 * would add nothing for them.
 */
export const toolGroups = [
  { id: 'cloud', title: 'Clouds and hosts' },
  { id: 'infra', title: 'Clusters and infrastructure as code' },
  { id: 'data', title: 'Databases' },
  { id: 'migrations', title: 'Migration tools' },
  { id: 'containers', title: 'Containers' },
] as const;

export type ToolGroup = (typeof toolGroups)[number]['id'];

export const tools = [
  { id: 'azure', label: 'Azure', group: 'cloud', hint: 'az and Azure PowerShell' },
  { id: 'aws', label: 'AWS', group: 'cloud', hint: 'aws' },
  { id: 'gcp', label: 'Google Cloud', group: 'cloud', hint: 'gcloud and gsutil' },
  { id: 'vercel', label: 'Vercel', group: 'cloud', hint: 'vercel' },
  { id: 'cloudflare', label: 'Cloudflare', group: 'cloud', hint: 'wrangler' },
  { id: 'netlify', label: 'Netlify', group: 'cloud', hint: 'netlify' },
  { id: 'fly', label: 'Fly.io', group: 'cloud', hint: 'fly and flyctl' },
  { id: 'heroku', label: 'Heroku', group: 'cloud', hint: 'heroku' },
  { id: 'railway', label: 'Railway', group: 'cloud', hint: 'railway' },
  { id: 'digitalocean', label: 'DigitalOcean', group: 'cloud', hint: 'doctl' },
  { id: 'kubernetes', label: 'Kubernetes', group: 'infra', hint: 'kubectl and oc' },
  { id: 'helm', label: 'Helm', group: 'infra', hint: 'helm' },
  { id: 'terraform', label: 'Terraform / OpenTofu', group: 'infra', hint: 'terraform, tofu and terragrunt' },
  { id: 'pulumi', label: 'Pulumi', group: 'infra', hint: 'pulumi' },
  { id: 'cdk', label: 'AWS CDK', group: 'infra', hint: 'cdk' },
  { id: 'serverless', label: 'Serverless Framework', group: 'infra', hint: 'serverless and sls' },
  { id: 'postgres', label: 'PostgreSQL', group: 'data', hint: 'psql and dropdb' },
  { id: 'mysql', label: 'MySQL / MariaDB', group: 'data', hint: 'mysql, mariadb and mysqladmin' },
  { id: 'sqlserver', label: 'SQL Server', group: 'data', hint: 'sqlcmd' },
  { id: 'sqlite', label: 'SQLite', group: 'data', hint: 'sqlite3' },
  { id: 'mongodb', label: 'MongoDB', group: 'data', hint: 'mongosh' },
  { id: 'redis', label: 'Redis', group: 'data', hint: 'redis-cli' },
  { id: 'warehouse', label: 'Other SQL engines', group: 'data', hint: 'ClickHouse, CockroachDB, DuckDB, BigQuery, Snowflake' },
  { id: 'prisma', label: 'Prisma', group: 'migrations', hint: 'prisma' },
  { id: 'drizzle', label: 'Drizzle', group: 'migrations', hint: 'drizzle-kit' },
  { id: 'supabase', label: 'Supabase', group: 'migrations', hint: 'supabase' },
  { id: 'knex', label: 'Knex', group: 'migrations', hint: 'knex' },
  { id: 'rails', label: 'Rails', group: 'migrations', hint: 'rails and rake' },
  { id: 'django', label: 'Django', group: 'migrations', hint: 'manage.py' },
  { id: 'laravel', label: 'Laravel', group: 'migrations', hint: 'artisan' },
  { id: 'efcore', label: 'EF Core', group: 'migrations', hint: 'dotnet ef' },
  { id: 'docker', label: 'Docker', group: 'containers', hint: 'docker and docker compose' },
  { id: 'podman', label: 'Podman', group: 'containers', hint: 'podman' },
] as const satisfies readonly { id: string; label: string; group: ToolGroup; hint: string }[];

export type ToolId = (typeof tools)[number]['id'];

export const toolIds: readonly ToolId[] = tools.map((t) => t.id);

/** True when `tool` is in play: untagged, no tool filter, or the tool was picked. */
export function toolOn(tool: ToolId | undefined, picked: readonly ToolId[] | undefined): boolean {
  return !tool || !picked || picked.length === 0 || picked.includes(tool);
}

/** Every tool an item has tagged rules or checks for, in tool-list order. */
export function itemTools(item: CatalogItem): ToolId[] {
  const used = new Set<ToolId>();
  for (const r of item.rules) if (r.kind === 'command' && r.tool) used.add(r.tool);
  for (const c of item.hook ?? []) if (c.tool) used.add(c.tool);
  return toolIds.filter((t) => used.has(t));
}

/**
 * False when every rule and check of the item is tagged with tools that were
 * not picked, so turning the item on would add nothing.
 */
export function itemApplies(item: CatalogItem, picked: readonly ToolId[] | undefined): boolean {
  if (!picked || picked.length === 0) return true;
  const rules = item.rules.some((r) => r.kind !== 'command' || toolOn(r.tool, picked));
  const checks = (item.hook ?? []).some((c) => toolOn(c.tool, picked));
  return rules || checks;
}

/** Program name -> tool, for telling which tool an example command belongs to. */
const PROGRAMS: Record<string, ToolId> = {
  az: 'azure',
  aws: 'aws',
  gcloud: 'gcp',
  gsutil: 'gcp',
  vercel: 'vercel',
  wrangler: 'cloudflare',
  netlify: 'netlify',
  fly: 'fly',
  flyctl: 'fly',
  heroku: 'heroku',
  railway: 'railway',
  doctl: 'digitalocean',
  kubectl: 'kubernetes',
  oc: 'kubernetes',
  helm: 'helm',
  terraform: 'terraform',
  tofu: 'terraform',
  terragrunt: 'terraform',
  pulumi: 'pulumi',
  cdk: 'cdk',
  serverless: 'serverless',
  sls: 'serverless',
  psql: 'postgres',
  dropdb: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  mysqladmin: 'mysql',
  sqlcmd: 'sqlserver',
  sqlite3: 'sqlite',
  mongosh: 'mongodb',
  mongo: 'mongodb',
  'redis-cli': 'redis',
  'clickhouse-client': 'warehouse',
  cockroach: 'warehouse',
  duckdb: 'warehouse',
  bq: 'warehouse',
  snowsql: 'warehouse',
  prisma: 'prisma',
  'drizzle-kit': 'drizzle',
  supabase: 'supabase',
  knex: 'knex',
  rails: 'rails',
  rake: 'rails',
  docker: 'docker',
  'docker-compose': 'docker',
  podman: 'podman',
  'podman-compose': 'podman',
};

/** The tool an example command runs, judged from its first word. Undefined when it is not tool-specific. */
export function commandTool(command: string): ToolId | undefined {
  const words = command.trim().split(/\s+/);
  if (words[0] === 'npx') words.shift();
  const first = (words[0] ?? '').replace(/^.*[\/]/, '').replace(/\.(exe|cmd)$/i, '');
  if (/^[a-z]+-az[a-z]/i.test(first)) return 'azure';
  if (first === 'php' && words[1] === 'artisan') return 'laravel';
  if (/^python3?$/.test(first) && words[1] === 'manage.py') return 'django';
  if (first === 'dotnet' && words[1] === 'ef') return 'efcore';
  return PROGRAMS[first];
}
