// The nightly name run: scripts/run-names-nightly.ps1 and its scheduled task in scripts/install-tasks.ps1.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const run = await readFile('scripts/run-names-nightly.ps1', 'utf8').catch(() => '');
const install = await readFile('scripts/install-tasks.ps1', 'utf8');

describe('run-names-nightly.ps1', () => {
  it('runs the capped Haiku high-effort run from the checkout, logs per date and passes on the exit code', () => {
    expect(run).toContain('pnpm normalise-names --model haiku --effort high --max-batches 400 --max-cost 5 --parallel 3');
    expect(run).not.toMatch(/--dry-run|--bare|ANTHROPIC_API_KEY/);
    expect(run).toContain('$repo = Split-Path -Parent $PSScriptRoot');
    expect(run).toContain('("out\\names\\nightly-" + (Get-Date -Format ' + "'yyyy-MM-dd'" + ')');
    expect(run).toMatch(/exit \$code/);
  });
});

describe('install-tasks.ps1', () => {
  it('installs "MTP Name Normaliser" daily at 05:00, hidden window, no wake, IgnoreNew, 4 hours, next to main\'s tasks', () => {
    expect(install).toMatch(/Install 'MTP Name Normaliser' 'run-names-nightly\.ps1' \(New-ScheduledTaskTrigger -Daily -At '05:00'\) \(New-TimeSpan -Hours 4\) -Hidden -NoWake/);
    expect(install).toContain("'-WindowStyle Hidden '");
    expect(install).toContain("MultipleInstances = 'IgnoreNew'");
    expect(install).toMatch(/Install 'MTP Shop Requests' 'run-shop-requests\.ps1'/);
    expect(install).toMatch(/Remove: Unregister-ScheduledTask -TaskName [^\n]*'MTP Shop Requests','MTP Name Normaliser'/);
    expect(install).toMatch(/-Description \$description/);
  });
});
