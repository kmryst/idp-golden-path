const { join } = require('node:path');

const backstageRoot = join(__dirname, '..');
const baseConfigFile = 'app-config.yaml';
const developmentConfigFile = 'app-config.development.yaml';
const productionConfigFile = 'app-config.production.yaml';
const localConfigFile = 'app-config.local.yaml';
const rdsBundleFile = 'rds-global-bundle.pem';

function fromBackstageRoot(file) {
  return join(backstageRoot, file);
}

module.exports = {
  developmentConfigPaths: [
    fromBackstageRoot(baseConfigFile),
    fromBackstageRoot(developmentConfigFile),
  ],
  localConfigPath: fromBackstageRoot(localConfigFile),
  productionConfigPaths: [
    fromBackstageRoot(baseConfigFile),
    fromBackstageRoot(productionConfigFile),
  ],
  rdsBundleFile,
};
