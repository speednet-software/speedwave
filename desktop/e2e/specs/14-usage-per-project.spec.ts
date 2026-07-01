/**
 * Per-Project Usage Isolation E2E test.
 *
 * The LLM usage dashboard (get_llm_usage) is scoped per project. e2e-test has
 * chat activity (specs 08-13) so it shows usage cards; e2e-second never chatted
 * (no provider) so it shows the empty state. This proves projects do not bleed
 * usage into each other.
 *
 * Runs after spec 13 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { openUsage } from '../helpers/llm';

const FIRST_PROJECT = 'e2e-test';
const SECOND_PROJECT = 'e2e-second';

describe('Per-Project Usage Isolation', function () {
  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== FIRST_PROJECT) {
      await switchToProject(FIRST_PROJECT);
    }
  });

  it('shows usage cards for the project that chatted', async function () {
    this.timeout(30_000);
    await openUsage();
    await $('[data-testid="llm-usage-cards"]').waitForExist({ timeout: 15_000 });
    expect(await $('[data-testid="llm-usage-empty"]').isExisting()).toBe(false);
  });

  it('shows the empty state for a project that never chatted', async function () {
    this.timeout(180_000);
    await switchToProject(SECOND_PROJECT);
    await openUsage();
    await $('[data-testid="llm-usage-empty"]').waitForExist({ timeout: 15_000 });
    expect(await $('[data-testid="llm-usage-cards"]').isExisting()).toBe(false);
  });
});
