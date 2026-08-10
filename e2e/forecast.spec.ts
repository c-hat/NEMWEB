import { expect, test } from '@playwright/test';

test('renders the forecast tracker from the configured data source', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'NEMWEB Forecast Tracker' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Forecast tracker' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /Meteorological context/i })).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#date-select')).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole('region', { name: /NEM — Demand forecast chart/i })).toBeVisible();
  await expect(page.getByRole('region', { name: /NEM — Rooftop PV forecast chart/i })).toBeVisible();
  await expect(
    page.getByRole('region', { name: /NEM demand and rooftop forecast error comparison chart/i }),
  ).toBeVisible();

  const firstRankedDay = page.locator('#errors-select option').nth(1);
  await expect(firstRankedDay).toHaveText(/^1\. \d{2}\/\d{2}\/\d{4} · [\d,]+ MW avg$/);
  const rankedDate = await firstRankedDay.getAttribute('value');
  expect(rankedDate).not.toBeNull();

  await page.locator('#errors-select').selectOption(rankedDate!);
  await expect(page.locator('#date-select')).toHaveValue(rankedDate!);
  await expect(page.locator('.forecast-issued')).toHaveText(
    /^Day-ahead POE forecast issued\d{2}\/\d{2}\/\d{4} · \d{2}:\d{2} AESTPOE50 line · POE10–POE90 band$/,
  );
});
