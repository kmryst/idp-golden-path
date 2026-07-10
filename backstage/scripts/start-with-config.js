const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');

const { developmentConfigPaths, localConfigPath } = require('./config-files');

const inputArgs = process.argv.slice(2);
const hasExplicitCommand =
  inputArgs[0] === 'repo' || inputArgs[0] === 'package';
const commandArgs = hasExplicitCommand
  ? inputArgs
  : ['repo', 'start', ...inputArgs];
const [commandScope, commandName, ...restArgs] = commandArgs;

if (commandName !== 'start') {
  console.error(
    `start-with-config.js only supports "start" commands (got: ${commandName ?? '<missing>'})`,
  );
  process.exit(1);
}

const args = [commandScope, commandName];
args.push(...developmentConfigPaths.flatMap(config => ['--config', config]));

if (existsSync(localConfigPath)) {
  args.push('--config', localConfigPath);
}

args.push(...restArgs);

const child = spawn('backstage-cli', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', error => {
  console.error(`Failed to start backstage-cli: ${error.message}`);
  process.exit(1);
});

child.on('exit', code => {
  process.exit(code ?? 1);
});
