import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { SignInPage } from '@backstage/core-components';
import {
  configApiRef,
  githubAuthApiRef,
  useApi,
} from '@backstage/core-plugin-api';

/**
 * サインインページ。
 *
 * - 本番（app-config.production.yaml で auth.providers.github が定義されている場合）: GitHub OAuth
 * - ローカル開発（app-config.development.yaml の guest のみ）: guest で自動サインイン
 *
 * 設計判断は ADR 0009 を参照。
 */
const githubProvider = {
  id: 'github-auth-provider',
  title: 'GitHub',
  message: 'GitHub アカウントでサインインします',
  apiRef: githubAuthApiRef,
};

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props => {
      const configApi = useApi(configApiRef);
      const hasGithub = configApi.has('auth.providers.github');
      return (
        <SignInPage
          {...props}
          auto
          providers={hasGithub ? [githubProvider] : ['guest']}
        />
      );
    },
  },
});

export const signInPageModule = createFrontendModule({
  pluginId: 'app',
  extensions: [signInPage],
});
