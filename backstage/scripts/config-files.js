const baseConfigFile = 'app-config.yaml';
const developmentConfigFile = 'app-config.development.yaml';
const productionConfigFile = 'app-config.production.yaml';
const localConfigFile = 'app-config.local.yaml';
const rdsBundleFile = 'rds-global-bundle.pem';

module.exports = {
  developmentConfigFiles: [baseConfigFile, developmentConfigFile],
  localConfigFile,
  productionConfigFiles: [baseConfigFile, productionConfigFile],
  rdsBundleFile,
};
