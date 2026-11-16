// electron-builder afterPack hook. electron-builder never copies a folder named node_modules when it copies
// an extraResources folder (app-builder-lib/out/fileMatcher.js inserts "!**/node_modules/**", whatever the
// filter says). The backend's production dependencies live in build/app/node_modules, so copy them into
// resources/app/node_modules here. Without them the backend only appears to start when the package sits
// inside a source checkout, because Node then finds the checkout's own node_modules.
const { cpSync, existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function copyBackendModules(context) {
  const resources =
    context.packager.platform.name === 'mac'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
  const from = join(__dirname, '..', '..', 'build', 'app', 'node_modules');
  const to = join(resources, 'app', 'node_modules');
  if (!existsSync(from)) throw new Error(`${from} is missing; run npm run build:app first`);
  if (!existsSync(join(resources, 'app'))) throw new Error(`${join(resources, 'app')} is missing: extraResources did not copy the backend`);
  console.log(`  • copying the backend's node_modules to ${to}`);
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  if (!existsSync(join(to, '@temporalio', 'worker'))) throw new Error('the backend modules were not copied');
};
