const { copyFileSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  developmentConfigFiles,
  productionConfigFiles,
  rdsBundleFile,
} = require('./config-files');

const mode = process.argv[2];
const validModes = new Set(['development', 'production']);

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function printUsage() {
  console.error('Usage: node scripts/check-config.js <development|production>');
}

if (!validModes.has(mode)) {
  printUsage();
  process.exit(1);
}

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

  if (result.error) {
    console.error(
      `Failed to run backstage-cli config:check: ${formatError(result.error)}`,
    );
    return 1;
  }

  if (result.signal) {
    console.error(
      `backstage-cli config:check was terminated by signal ${result.signal}`,
    );
    return 1;
  }

  return result.status ?? 1;
}

function createTempConfigDir() {
  try {
    return mkdtempSync(join(tmpdir(), 'backstage-config-check-'));
  } catch (error) {
    console.error(
      `Failed to create temporary config directory: ${formatError(error)}`,
    );
    process.exit(1);
  }
}

function copyConfigFile(source, configDir) {
  const target = join(configDir, basename(source));

  try {
    copyFileSync(source, target);
    return target;
  } catch (error) {
    console.error(`Failed to copy ${source}: ${formatError(error)}`);
    throw error;
  }
}

function writePlaceholderFile(target, description) {
  try {
    writeFileSync(target, '');
  } catch (error) {
    console.error(`Failed to create ${description}: ${formatError(error)}`);
    throw error;
  }
}

if (mode === 'development') {
  process.exit(runConfigCheck(developmentConfigFiles));
}

if (mode === 'production') {
  const configDir = createTempConfigDir();
  let status = 1;

  try {
    const copiedConfigs = productionConfigFiles.map(config =>
      copyConfigFile(config, configDir),
    );
    writePlaceholderFile(join(configDir, rdsBundleFile), rdsBundleFile);

    status = runConfigCheck(copiedConfigs);
  } catch {
    status = 1;
  } finally {
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `Failed to remove temporary config directory ${configDir}: ${formatError(error)}`,
      );
      status = 1;
    }
  }

  process.exit(status);
}
