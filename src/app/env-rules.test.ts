import { describe, expect, it } from 'vitest';
import { normalizeEnv, shellAllowed } from './state';
import type { Environment } from '../generator/generate';

const base: Environment = { os: 'windows', shells: ['bash', 'powershell'], scope: 'project', sandbox: 'off', hook: false };

describe('shellAllowed', () => {
  it('offers PowerShell only on native Windows', () => {
    expect(shellAllowed('windows', 'powershell')).toBe(true);
    expect(shellAllowed('macos', 'powershell')).toBe(false);
    expect(shellAllowed('linux', 'powershell')).toBe(false);
    expect(shellAllowed('wsl', 'powershell')).toBe(false);
  });

  it('always allows Bash', () => {
    for (const os of ['windows', 'macos', 'linux', 'wsl'] as const) expect(shellAllowed(os, 'bash')).toBe(true);
  });
});

describe('normalizeEnv', () => {
  it('drops PowerShell from a macOS, Linux or WSL setup', () => {
    for (const os of ['macos', 'linux', 'wsl'] as const) {
      expect(normalizeEnv({ ...base, os, sandbox: 'on' }).shells).toEqual(['bash']);
    }
  });

  it('keeps PowerShell on Windows', () => {
    expect(normalizeEnv(base).shells).toEqual(['bash', 'powershell']);
  });

  it('turns the sandbox off on native Windows, where it is not available', () => {
    expect(normalizeEnv({ ...base, sandbox: 'strict' }).sandbox).toBe('off');
  });

  it('leaves the sandbox alone on other systems', () => {
    expect(normalizeEnv({ ...base, os: 'macos', sandbox: 'on' }).sandbox).toBe('on');
  });
});
