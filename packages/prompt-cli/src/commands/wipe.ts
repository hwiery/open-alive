import { rmSync } from 'node:fs';
import { getPaths } from '@open-alive/prompt-core';
import pc from 'picocolors';
import { stop } from '../daemon.js';
import { removeHooksFromSettings } from '../settings-merge.js';

export async function wipeCmd(opts: { yes?: boolean }): Promise<void> {
  if (!opts.yes) {
    console.log(
      pc.red('⚠') +
        ' This will delete all open-alive prompt data and remove hooks. Pass --yes to confirm.'
    );
    return;
  }
  stop('agent');
  stop('worker');
  const paths = getPaths();
  removeHooksFromSettings(paths.claudeSettings);
  rmSync(paths.root, { recursive: true, force: true });
  console.log(pc.green('✓') + ' open-alive prompt wiped');
}
