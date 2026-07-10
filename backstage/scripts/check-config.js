const { copyFileSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2];
const defaultEnv = {
  GITHUB_TOKEN: 'dummy-github-token',
  BACKEND_SECRET: 'dummy-backend-secret',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: 'postgres',
  AUTH_SESSION_SECRET: 'dummy-auth-session-secret',
  AUTH_GITHUB_CLIENT_ID: 'dummy-github-client-id',
  AUTH_GITHUB_CLIENT_SECRET: 'dummy-github-client-secret',
  TECHDOCS_S3_BUCKET_NAME: 'dummy-techdocs-bucket',
  AWS_REGION: 'us-east-1',
};

function runConfigCheck(configs) {
  const result = spawnSync(
    'backstage-cli',
    ['config:check', ...configs.flatMap(config => ['--config', config])],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...defaultEnv, ...process.env },
    },
  );

  return result.status ?? 1;
}

if (mode === 'development') {
  process.exit(
    runConfigCheck(['app-config.yaml', 'app-config.development.yaml']),
  );
}

if (mode === 'production') {
  const configDir = mkdtempSync(join(tmpdir(), 'backstage-config-check-'));
  let status = 1;

  try {
    const baseConfig = join(configDir, 'app-config.yaml');
    const productionConfig = join(configDir, 'app-config.production.yaml');

    copyFileSync('app-config.yaml', baseConfig);
    copyFileSync('app-config.production.yaml', productionConfig);
    writeFileSync(join(configDir, 'rds-global-bundle.pem'), '');

    status = runConfigCheck([baseConfig, productionConfig]);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }

  process.exit(status);
}

console.error('Usage: node scripts/check-config.js <development|production>');
process.exit(1);
