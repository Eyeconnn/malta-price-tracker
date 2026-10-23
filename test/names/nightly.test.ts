// The nightly name run: scripts/run-names-nightly.ps1 and its scheduled task in scripts/install-tasks.ps1.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const run = await readFile('scripts/run-names-nightly.ps1', 'utf8').catch(() => '');
const install = await readFile('scripts/install-tasks.ps1', 'utf8');

describe('run-names-nightly.ps1', () => {
  it('runs the capped Haiku low run from the checkout, logs per date and passes on the exit code', () => {
    expect(run).toContain('pnpm normalise-names --model haiku --effort low --max-batches 400 --max-cost 5 --parallel 3');
    expect(run).not.toMatch(/--dry-run|--bare|ANTHROPIC_API_KEY/);
    expect(run).toContain('$repo = Split-Path -Parent $PSScriptRoot');
    expect(run).toContain('("out\\names\\nightly-" + (Get-Date -Format ' + "'yyyy-MM-dd'" + ')');
    expect(run).toMatch(/exit \$code/);
  });
});

describe('install-tasks.ps1', () => {
  it('installs "MTP Name Normaliser" daily at 05:00, hidden, IgnoreNew, 4 hour limit, and the Remove line names it', () => {
    expect(install).toMatch(/Install 'MTP Name Normaliser' 'run-names-nightly\.ps1' \(New-ScheduledTaskTrigger -Daily -At '05:00'\) \(New-TimeSpan -Hours 4\)/);
    expect(install).toMatch(/-Hidden/);
    expect(install).toMatch(/-MultipleInstances IgnoreNew/);
    expect(install).toMatch(/Remove: Unregister-ScheduledTask -TaskName [^\n]*'MTP Name Normaliser'/);
  });
});
