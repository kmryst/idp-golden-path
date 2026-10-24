/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from '@playwright/test';

test('Guest sign-in shows the catalog page and the sidebar navigation', async ({
  page,
}) => {
  await page.goto('/');

  const enterButton = page.getByRole('button', { name: 'Enter' });
  await expect(enterButton).toBeVisible();
  await enterButton.click();

  // サインインが完了し、入口画面のカタログが表示されること
  await expect(enterButton).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Catalog', level: 1 }),
  ).toBeVisible();

  // サイドバーの主要導線を検証する。ページヘッダーの breadcrumb も
  // navigation ランドマークのため、サイドバーの nav に名前で絞る
  const sidebar = page.getByRole('navigation', { name: 'sidebar nav' });

  const catalogLink = sidebar.getByRole('link', {
    name: 'Catalog',
    exact: true,
  });
  await expect(catalogLink).toBeVisible();
  await expect(catalogLink).toHaveAttribute('href', '/');

  const apisLink = sidebar.getByRole('link', { name: 'APIs', exact: true });
  await expect(apisLink).toBeVisible();
  await expect(apisLink).toHaveAttribute('href', '/api-docs');

  // 通知への導線は NotificationsSidebarItem の 1 つだけにする。
  // page:notifications の自動ナビ項目と二重に表示されないこと
  await expect(
    sidebar.getByRole('link', { name: 'Notifications' }),
  ).toHaveCount(1);
});
