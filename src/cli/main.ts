import { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compile } from '../compiler/compile.js';
import { loadAdminConfig } from '../config/admin.js';
import { loadDefinitionText } from '../definition/load.js';
import { packageFromDirectory, type PackageSource } from '../definition/package.js';
import { staticCatalog, type ToolCatalog } from '../gateway/types.js';
import { bold, green, printDiagnostics, red } from './output.js';

const program = new Command('azhi').description('Azhi Flow: governed, durable agent workflows').version('0.1.0');

export function loadPackage(path: string): PackageSource {
  const dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  return packageFromDirectory(dir);
}

export function localCatalog(configPath?: string): ToolCatalog | undefined {
  const path = configPath ?? (existsSync('azhi.config.yaml') ? 'azhi.config.yaml' : undefined);
  if (!path) return undefined;
  return staticCatalog(loadAdminConfig(path).tools ?? []);
}

program
  .command('validate')
  .description('Validate a workflow package and print diagnostics')
  .argument('[path]', 'package directory or workflow.yaml', '.')
  .option('-c, --config <file>', 'admin config with the tool catalog (default: ./azhi.config.yaml)')
  .option('--json', 'print the execution plan as JSON')
  .action((path: string, opts: { config?: string; json?: boolean }) => {
    const pkg = loadPackage(path);
    const loaded = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!);
    if (!loaded.definition) {
      printDiagnostics(loaded.diagnostics);
      process.exitCode = 1;
      return;
    }
    const result = compile(loaded.definition, { pkg, catalog: localCatalog(opts.config) });
    printDiagnostics(result.diagnostics);
    if (!result.ok) {
      console.log(red(`\n${loaded.definition.id}: invalid`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) console.log(JSON.stringify(result.plan, null, 2));
    else console.log(`${green('valid')} ${bold(loaded.definition.id)}: ${result.plan!.nodes.length} nodes, package ${pkg.hash.slice(0, 19)}`);
  });

await program.parseAsync(process.argv);
