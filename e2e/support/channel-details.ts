import type { Page } from '@playwright/test';

/** Opens the channel details menu (the channel name in the header, P21-06) if it is not open; the star, Integrations and notification items live in it. */
export async function openChannelDetails(page: Page): Promise<void> {
  if (await page.getByTestId('channel-details').isVisible()) return;
  await page.getByTestId('channel-details-button').click();
  await page.getByTestId('channel-details').waitFor();
}
