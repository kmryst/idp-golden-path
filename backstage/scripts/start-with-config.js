const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');

const { developmentConfigFiles, localConfigFile } = require('./config-files');

const args = [
  'repo',
  'start',
  ...developmentConfigFiles.flatMap(config => ['--config', config]),
];

if (existsSync(localConfigFile)) {
  args.push('--config', localConfigFile);
}

args.push(...process.argv.slice(2));

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
