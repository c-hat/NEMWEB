import { expect, test } from '@playwright/test';

test('renders the forecast tracker from the configured data source', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'NEMWEB Forecast Tracker' })).toBeVisible();
  await expect(page.locator('#date-select')).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole('region', { name: /NEM — Demand forecast chart/i })).toBeVisible();
  await expect(page.getByRole('region', { name: /NEM — Rooftop PV forecast chart/i })).toBeVisible();
  await expect(
    page.getByRole('region', { name: /NEM forecast error decomposition chart/i }),
  ).toBeVisible();
});
