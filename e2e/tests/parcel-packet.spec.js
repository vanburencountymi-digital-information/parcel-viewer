// The Parcel Packet window (a sample preview): what it shows for the selected parcel, and
// its interactive parts — Share / Embed, the "What this means" Q&A panels, the Parcel
// Ledger's list, filters and timeline, and Monitor. By role, label and text only.
const { test, expect, gotoViewer, selectParcelViaSearch, ui } = require('./fixtures');

const packet = (page) => page.getByRole('dialog', { name: 'Parcel Packet', exact: true });
const openPacket = (page) => ui.parcelPanel(page).getByRole('button', { name: 'Generate Parcel Packet', exact: true }).first().click();

test('with no parcel selected, it says to pick one', async ({ page }) => {
  await gotoViewer(page);
  await page.evaluate(() => { window.PV_TOOLS.open('packet'); });
  await expect(packet(page)).toContainText('Select a parcel first, then open its Packet.');
});

test.describe('for the selected parcel', () => {
  let parcel;
  test.beforeEach(async ({ page }) => {
    await gotoViewer(page);
    await selectParcelViaSearch(page);
    parcel = await page.evaluate(() => {
      const p = window.PS_STATE.parcel;
      return { pin: p.pin, address: p.site_address, acres: p.acres };
    });
    await openPacket(page);
    await expect(packet(page)).toBeVisible();
  });

  test('shows the parcel, its facts and every section', async ({ page }) => {
    const dlg = packet(page);
    await expect(dlg).toContainText(parcel.pin);
    if (parcel.address) await expect(dlg).toContainText(parcel.address);
    await expect(dlg).toContainText(`${parcel.acres.toFixed(2)} ac`);
    await expect(dlg.getByRole('heading', { level: 3 })).toHaveText(['Parcel Ledger', 'Assessment & Tax', 'Ownership',
      'Tax Description', 'Environmental', '70-Year Aerial History', 'Documents & Survey Notes']);
    await expect(dlg.getByRole('img', { name: /^Section diagram/ })).toBeVisible();
    await expect(dlg.getByRole('img', { name: /^Timeline of recorded events/ })).toBeVisible();
  });

  test('Share / Embed opens a panel with a link for this parcel, and Copy confirms', async ({ page }) => {
    const dlg = packet(page);
    const share = dlg.getByRole('button', { name: /Share \/ Embed/ });
    await expect(share).toHaveAttribute('aria-expanded', 'false');
    await share.click();
    await expect(share).toHaveAttribute('aria-expanded', 'true');
    const link = dlg.getByRole('textbox', { name: 'Shareable link' });
    await expect(link).toHaveValue(`https://packet.dicelabs.org/p/${parcel.pin}?s=ab12cd`);
    await expect(dlg.getByRole('textbox', { name: 'Embed snippet' })).toHaveValue(/packet\.dicelabs\.org\/embed\//);
    await expect(dlg.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(2);
    await dlg.getByRole('button', { name: 'Copy', exact: true }).first().click();
    await expect(dlg.getByRole('button', { name: 'Copied ✓' })).toHaveCount(1);
    await expect(dlg.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(2);   // and back
    await share.click();
    await expect(share).toHaveAttribute('aria-expanded', 'false');
    await expect(link).toBeHidden();
  });

  test('a "What this means" panel answers its suggested questions and anything typed', async ({ page }) => {
    const dlg = packet(page);
    await dlg.getByRole('button', { name: 'Why is taxable value lower than assessed?' }).click();
    await expect(dlg.getByText(/^Because of Michigan's Proposal A cap\./)).toBeVisible();
    // Each panel has its own ask box; the Environmental one is the fourth (ledger, assess, owner, taxdesc, env…).
    const ask = dlg.getByRole('textbox', { name: 'Ask a question about this section' });
    await expect(ask).toHaveCount(7);
    await ask.nth(4).fill('Is this a good septic site?');
    await ask.nth(4).press('Enter');
    await expect(dlg.getByText(/^Likely yes\. Oshtemo sandy loam percolates quickly/)).toBeVisible();
    await expect(ask.nth(4)).toHaveValue('');
    await ask.nth(1).fill('Can I put a fence on the line?');
    await ask.nth(1).press('Enter');
    await expect(dlg.getByText(/^That's exactly what the live Packet answers/)).toBeVisible();
  });

  test('the Parcel Ledger lists events newest first, expands one, and filters by kind', async ({ page }) => {
    const dlg = packet(page);
    const events = dlg.getByRole('button', { name: /^\d{4} (Ownership|Tax|Land|Survey|Permit|Imagery) / });
    await expect(events).toHaveCount(11);
    await expect(events.first()).toHaveText(/^2025\s*Imagery\s*Aerial imagery captured$/);
    await expect(events.last()).toHaveText(/^1871\s*Imagery\s*Section first platted$/);
    const deed = dlg.getByRole('button', { name: '2014 Ownership Conveyed to Smith, John & Jane' });
    await deed.click();
    await expect(deed).toHaveAttribute('aria-expanded', 'true');
    await expect(dlg.getByText('Warranty deed — Liber 1444, Page 933.', { exact: true })).toBeVisible();
    await expect(dlg.getByText(/^Parcel as of 2014 — Conveyed to Smith, John & Jane\./)).toBeVisible();
    await deed.click();
    await expect(deed).toHaveAttribute('aria-expanded', 'false');
    // Filters: turning Ownership off hides its two events; All toggles every kind.
    await dlg.getByRole('button', { name: 'Ownership', exact: true }).click();
    await expect(events.filter({ visible: true })).toHaveCount(9);
    await dlg.getByRole('button', { name: 'All', exact: true }).click();   // not all on → all on
    await expect(events.filter({ visible: true })).toHaveCount(11);
    await dlg.getByRole('button', { name: 'All', exact: true }).click();   // all on → all off
    await expect(events.filter({ visible: true })).toHaveCount(0);
  });

  test('Monitor says it is on the roadmap', async ({ page }) => {
    const btn = packet(page).getByRole('button', { name: 'Subscribe to monitoring' });
    await btn.click();
    await expect(packet(page).getByRole('button', { name: 'On the roadmap ✓' })).toBeDisabled();
  });
});

test('past a Protected county\'s daily limit, the owner shows as withheld', async ({ page }) => {
  await gotoViewer(page);
  await selectParcelViaSearch(page);
  await page.evaluate(() => {
    window.PS_STATE.parcel = Object.assign({}, window.PS_STATE.parcel, { owner_name: null });
    window.PV_ACCESS.getState = () => ({ withheld: true });
    window.PV_TOOLS.open('packet');
  });
  await expect(packet(page)).toContainText('Withheld today (daily detail limit)');
});
