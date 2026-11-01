import { spawnSync } from 'node:child_process';

/** The Python 3 a worker would find: python3 (Linux, macOS), python or the py launcher (Windows, where python3 can be a Store stub). */
export const PYTHON = (() => {
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    const r = spawnSync(cmd[0]!, [...cmd.slice(1), '-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.stdout?.trim() === '3') return cmd;
  }
  throw new Error('no Python 3 found (tried python3, python, py -3)');
})();
