const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');

const args = [
  'repo',
  'start',
  '--config',
  'app-config.yaml',
  '--config',
  'app-config.development.yaml',
];

if (existsSync('app-config.local.yaml')) {
  args.push('--config', 'app-config.local.yaml');
}

args.push(...process.argv.slice(2));

const child = spawn('backstage-cli', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', code => {
  process.exit(code ?? 1);
});
