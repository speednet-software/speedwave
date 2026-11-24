/** Dirty-state self-heal: planted engine debris must not survive a backend restart.
 *  Runs after spec 18 (e2e-second active) and before 07. */
import {
  composePrefix,
  plantGhost,
  storeSnapshot,
  assertStoreHealed,
  assertLiveEntriesIntact,
} from '../helpers/engine';
import { waitForHealthy } from '../helpers/health';
import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { requestBackendRestart, RESTART_WAIT_MS } from '../helpers/shell';

const PROJECT = 'e2e-test';
const HUB = `${composePrefix()}_${PROJECT}_mcp_hub`;
const CLAUDE = `${composePrefix()}_${PROJECT}_claude`;
const PROJECT_PREFIX = `${composePrefix()}_${PROJECT}_`;

function projectEntries(snapshot: Map<string, string>): Map<string, string> {
  return new Map([...snapshot].filter(([name]) => name.startsWith(PROJECT_PREFIX)));
}

describe('Dirty-state self-heal', function () {
  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== PROJECT) {
      await switchToProject(PROJECT);
    }
  });

  it('heals a planted name-store ghost and keeps every live entry', async function () {
    this.timeout(RESTART_WAIT_MS + 120_000);
    const before = projectEntries(storeSnapshot());
    plantGhost(HUB);
    await requestBackendRestart();
    await waitForHealthy(PROJECT);
    assertStoreHealed([HUB]);
    assertLiveEntriesIntact(before, [HUB]);
  });

  it('heals multiple ghosts in one pass', async function () {
    this.timeout(RESTART_WAIT_MS + 120_000);
    const before = projectEntries(storeSnapshot());
    plantGhost(HUB);
    plantGhost(CLAUDE);
    await requestBackendRestart();
    await waitForHealthy(PROJECT);
    assertStoreHealed([HUB, CLAUDE]);
    assertLiveEntriesIntact(before, [HUB, CLAUDE]);
  });
});
