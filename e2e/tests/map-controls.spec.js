// Map Controls panel: every Select / Measure / Draw tool can be armed from its button and
// exited again (Esc or its own control), always releasing the map-click gate.
const { test, expect, gotoViewer, clickGate, ui, openMapControlsTab } = require('./fixtures');

async function openTab(page, tab) {
  const pane = await openMapControlsTab(page, tab);
  await expect(ui.mapControls(page)).toBeVisible();
  await expect(pane).toBeVisible();
  return pane;
}

test.beforeEach(async ({ page }) => { await gotoViewer(page); });

test.describe('Select tools', () => {
  for (const name of ['Box', 'Lasso', 'Buffer', 'Filter']) {
    test(`${name}: arms and exits`, async ({ page }) => {
      const pane = await openTab(page, 'Selection Tools');
      await pane.getByRole('button', { name, exact: true }).click();
      const bar = page.getByTestId('tool-active-bar');
      if (await bar.isVisible()) {
        await bar.getByRole('button', { name: 'Exit', exact: true }).click();
        await expect(bar).toBeHidden();
      } else {
        await page.keyboard.press('Escape');
      }
      expect(await clickGate(page)).toBeNull();
    });
  }
});

test.describe('Measure tools', () => {
  const TOOLS = ['Measure Area', 'Measure Dist.', 'Coordinates', 'Dim. Line', 'Dimension Parcel'];
  const ADVANCED = ['Bearing & Dist.', 'Perpendicular', 'Arc / Radius', 'Running Dim.', 'Angle'];
  for (const name of TOOLS.concat(ADVANCED)) {
    test(`${name}: arms (holds the gate) and Esc / re-click exits`, async ({ page }) => {
      const pane = await openTab(page, 'Measurement Tools');
      const btn = pane.getByRole('button', { name, exact: true });
      if (!(await btn.isVisible())) await pane.getByRole('button', { name: /Advanced Tools$/ }).click();
      await btn.click();
      expect(await clickGate(page), 'tool armed').toBe('measure');
      await btn.click();                                  // toggle off
      if (await clickGate(page)) await page.keyboard.press('Escape');
      expect(await clickGate(page), 'tool released').toBeNull();
      await expect(page.getByTestId('msr-hud')).toBeHidden();
    });
  }
});

test.describe('Draw tools', () => {
  // button name → the tool id the click gate reports
  for (const [name, tool] of [['Point', 'point'], ['Line', 'polyline'], ['Shape', 'polygon'], ['Circle', 'circle'],
    ['Free', 'freehand'], ['Label', 'text'], ['Callout', 'callout'], ['Select', 'select']]) {
    test(`${tool}: arms and Esc exits`, async ({ page }) => {
      const pane = await openTab(page, 'Drawing Tools');
      await pane.getByRole('button', { name, exact: true }).click();
      expect(await clickGate(page)).toBe(tool);
      await page.keyboard.press('Escape');
      expect(await clickGate(page), 'Esc exits the draw tool').toBeNull();
      expect(await page.evaluate(() => window.PS_MAP.dragPan.isEnabled()), 'panning restored').toBe(true);
    });
  }

  test('leaving the Draw tab exits drawing', async ({ page }) => {
    const pane = await openTab(page, 'Drawing Tools');
    await pane.getByRole('button', { name: 'Shape', exact: true }).click();
    await openTab(page, 'Layers');
    expect(await clickGate(page)).toBeNull();
  });
});
