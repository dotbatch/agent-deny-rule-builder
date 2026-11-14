import type { InputDef } from './schema';

/**
 * Shared input registry. An input is asked once and reused by every selected
 * item that lists it.
 */
export const inputs: InputDef[] = [
  {
    id: 'envExceptions',
    kind: 'filename-list',
    label: 'Env files Claude may read',
    help: 'Template files with no real values. Everything else named .env or .env.* stays blocked.',
    default: ['.env.example', '.env.sample', '.env.template'],
  },
  {
    id: 'secretPaths',
    kind: 'path-list',
    label: 'Your secret files and folders',
    help: 'Anything holding keys or credentials that is not in a standard location. Paste paths as they appear on your machine.',
    placeholder: 'C:\\keys\\prod.pem, ~/vault-export, secrets/',
    required: true,
  },
  {
    id: 'protectedPaths',
    kind: 'path-list',
    label: 'Files and folders Claude must never change',
    help: 'Relative to the project root. Claude can still read them.',
    placeholder: 'config/production/, db/migrations/, package-lock.json',
    required: true,
  },
  {
    id: 'protectedBranches',
    kind: 'string-list',
    label: 'Protected branches',
    help: 'Branches Claude should not push to without you.',
    default: ['main', 'master'],
    required: true,
  },
  {
    id: 'blockCommitsOnProtected',
    kind: 'boolean',
    label: 'Also stop commits made while on a protected branch',
    help: 'Forces work onto a feature branch. Leave off if you commit to main locally.',
    default: false,
  },
  {
    id: 'allowForceWithLease',
    kind: 'boolean',
    label: 'Allow --force-with-lease',
    help: 'The safer force push: it fails if someone else pushed first.',
    default: true,
  },
  {
    id: 'blockedDomains',
    kind: 'domain-list',
    label: 'Domains Claude must never contact',
    help: 'Hostnames only. Subdomains are included automatically.',
    placeholder: 'pastebin.com, transfer.sh',
    required: true,
  },
  {
    id: 'mcpTools',
    kind: 'mcp-tool-list',
    label: 'MCP tools to block',
    help: 'A full tool name, or just the server name to block every tool on it. Tool names are shown in the transcript when Claude calls them.',
    placeholder: 'mcp__slack__send_message, gmail',
    required: true,
  },
];
