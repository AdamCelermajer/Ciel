import { test, expect } from '@playwright/test';

test('opening a long session lands on its latest message and preserves manual scrolling', async ({ page }) => {
  await page.route(/\/api\/v1\/h\/[^/]+\/tasks\/[^/?]+$/, async route => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.messages.push(...Array.from({length:60},(_,index)=>({id:`scroll-${index}`,taskId:detail.task.id,role:'system',text:`Message ${index}: ${'long conversation '.repeat(12)}`,createdAt:new Date(Date.now()+index).toISOString()})));
    await route.fulfill({response,json:detail});
  });
  await page.goto('/');
  const scroll=page.locator('.conversation-scroll');
  await expect(page.getByText(/Message 59:/)).toBeVisible();
  await expect.poll(()=>scroll.evaluate(element=>element.scrollHeight-element.scrollTop-element.clientHeight)).toBeLessThan(85);
  await scroll.evaluate(element=>{element.scrollTop=0;});
  await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBe(0);
  await page.getByRole('button',{name:'Open session Alpha session'}).click();
  await expect.poll(()=>scroll.evaluate(element=>element.scrollHeight-element.scrollTop-element.clientHeight)).toBeLessThan(85);
});

test('a pasted image is sent to Codex and a running turn can be steered or queued', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button',{name:'New session in Alpha other'}).click();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nKQAAAAASUVORK5CYII=','base64');
  await page.getByRole('textbox',{name:'Message'}).evaluate((element,bytes)=>{
    const file=new File([new Uint8Array(bytes)],'pasted.png',{type:'image/png'});
    const transfer=new DataTransfer();transfer.items.add(file);
    element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  },[...png]);
  await expect(page.getByRole('img',{name:'Attached image 1'})).toBeVisible();
  await page.getByRole('textbox',{name:'Message'}).fill('A slow image task');
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByRole('button',{name:'View attached image'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Steer Codex'})).toBeVisible();
  await page.getByRole('textbox',{name:'Message'}).fill('Please focus on the image');
  await page.getByRole('button',{name:'Steer Codex'}).click();
  await expect(page.getByText('Please focus on the image',{exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Message'}).fill('Follow up after this');
  await page.getByRole('button',{name:'Queue',exact:true}).click();
  await expect(page.getByText('Follow up after this',{exact:true})).toBeVisible();
  await expect(page.locator('.conversation-turn')).toHaveCount(2);
  const host=await page.getByRole('combobox',{name:'Host'}).inputValue();
  await page.evaluate(async id=>{
    const state=await(await fetch(`/api/v1/h/${id}/state`)).json();
    const task=state.tasks.find((item:{title:string})=>item.title==='A slow image task');
    await fetch(`/api/v1/h/${id}/tasks/${task.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived:true})});
  },host);
});

test('generated images open in a closable viewer without leaving the session', async ({ page }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nKQAAAAASUVORK5CYII=', 'base64');
  await page.route('**/images/viewer-fixture', route => route.fulfill({ contentType: 'image/png', body: png }));
  await page.route(/\/api\/v1\/h\/[^/]+\/tasks\/[^/?]+$/, async route => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.messages.push({ id: 'viewer-message', taskId: detail.task.id, role: 'assistant', text: 'Generated image', createdAt: new Date().toISOString(), engine: 'codex', images: [{ id: 'viewer-fixture', mimeType: 'image/png' }] });
    await route.fulfill({ response, json: detail });
  });
  await page.goto('/');
  const sessionUrl = page.url();
  await page.getByRole('button', { name: 'View generated image' }).click();
  const viewer = page.getByRole('dialog', { name: 'Image viewer' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('img', { name: 'Generated image' })).toHaveJSProperty('naturalWidth', 1);
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toHaveText('125%');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  expect(page.url()).toBe(sessionUrl);
  await page.getByRole('button', { name: 'View generated image' }).click();
  await page.getByRole('button', { name: 'Close image viewer' }).click();
  await expect(viewer).toHaveCount(0);
});

test('a newer published CIEL release appears as a discreet button beside the logo', async ({ page }) => {
  await page.route('**/updates', route => route.fulfill({ json: { currentVersion: '0.1.4', latestVersion: '0.1.5', releaseUrl: 'https://github.com/example/ciel/releases/tag/v0.1.5', available: true, supported: true, busy: false } }));
  await page.goto('/');
  const badge = page.locator('.brand-title').getByRole('button', { name: 'Update', exact: true });
  await expect(badge).toBeVisible();
  await page.screenshot({ path: '.cache/ciel-update-indicator.png', fullPage: true, animations: 'disabled' });
  await badge.click();
  await expect(page.getByRole('dialog', { name: 'CIEL update available' })).toContainText('Version 0.1.5');
  await expect(page.getByRole('button', { name: 'Update and restart' })).toBeEnabled();
  await page.getByRole('button', { name: 'Later' }).click();
  await expect(page.getByRole('dialog', { name: 'CIEL update available' })).toHaveCount(0);
});

test('installer-based CIEL updates link to the published release', async ({ page }) => {
  await page.route('**/updates', route => route.fulfill({ json: { currentVersion: '0.1.4', latestVersion: '0.1.5', releaseUrl: 'https://github.com/example/ciel/releases/tag/v0.1.5', available: true, supported: false, busy: false } }));
  await page.goto('/');
  await page.locator('.brand-title').getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open GitHub release' })).toHaveAttribute('href', 'https://github.com/example/ciel/releases/tag/v0.1.5');
  await expect(page.getByRole('button', { name: 'Update and restart' })).toHaveCount(0);
});

test('switching hosts removes the old workspace immediately, including its draft', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Alpha session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Project Alpha project', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Project Alpha other', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Active|Queued|Completed|All)$/ })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Private Alpha draft');
  const beta = await page.getByRole('combobox', { name: 'Host', exact: true }).evaluate(select => Array.from((select as HTMLSelectElement).options).find(option => option.textContent?.startsWith('Beta'))?.value);
  expect(beta).toBeTruthy();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/h/${beta}/state`, async route => { await blocked; await route.continue(); });
  await page.getByRole('combobox', { name: 'Host', exact: true }).selectOption(beta!);
  await expect(page.getByRole('heading', { name: /Loading Beta/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alpha session', exact: true })).toHaveCount(0);
  await expect(page.getByText('Alpha project', { exact: true })).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { name: 'Beta session', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await page.unroute(`**/h/${beta}/state`);
});

test('two tabs retain independent computers after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Alpha session', exact: true })).toBeVisible();
  const remote = await page.context().newPage();
  try {
    await remote.goto('/');
    const beta = await remote.getByRole('combobox', { name: 'Host', exact: true }).evaluate(select => Array.from((select as HTMLSelectElement).options).find(option => option.textContent?.startsWith('Beta'))?.value);
    expect(beta).toBeTruthy();
    await remote.getByRole('combobox', { name: 'Host', exact: true }).selectOption(beta!);
    await expect(remote.getByRole('heading', { name: 'Beta session', exact: true })).toBeVisible();
    await page.reload();
    await remote.reload();
    await expect(page.getByRole('heading', { name: 'Alpha session', exact: true })).toBeVisible();
    await expect(remote.getByRole('heading', { name: 'Beta session', exact: true })).toBeVisible();
  } finally { await remote.close(); }
});

test('a submitted run continues after switching hosts and its result survives reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Alpha session', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A slow background test');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation-head').getByText('Running', { exact: true })).toBeVisible();
  const options = await page.getByRole('combobox', { name: 'Host', exact: true }).evaluate(select => Array.from((select as HTMLSelectElement).options).map(option => ({ id: option.value, text: option.textContent! })));
  await page.getByRole('combobox', { name: 'Host', exact: true }).selectOption(options.find(option => option.text.startsWith('Beta'))!.id);
  await expect(page.getByRole('heading', { name: 'Beta session', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A quick independent test');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Working asynchronously. Task complete.', { exact: true })).toBeVisible();
  await expect(page.getByText('A slow background test', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Host', exact: true }).selectOption(options.find(option => option.text.startsWith('Alpha'))!.id);
  await expect(page.getByText('Working asynchronously. Task complete.', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.reload();
  await expect(page.getByText('Working asynchronously. Task complete.', { exact: true })).toBeVisible();
});

test('a remote reply appears when the event stream is unavailable', async ({ page }) => {
  await page.route(/\/api\/v1\/h\/[^/]+\/events(?:\?|$)/, route => route.abort());
  await page.goto('/');
  const beta = await page.getByRole('combobox', { name: 'Host', exact: true }).evaluate(select =>
    Array.from((select as HTMLSelectElement).options).find(option => option.textContent?.startsWith('Beta'))?.value);
  await page.getByRole('combobox', { name: 'Host', exact: true }).selectOption(beta!);
  await page.getByRole('button', { name: 'New session in Beta other' }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Reply without a live event stream');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Working asynchronously. Task complete.', { exact: true })).toBeVisible({ timeout: 15000 });
});

test('the workspace fits a narrow display and navigation remains available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Agents & accounts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agents & accounts', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.cache/ciel-ui-mobile.png', fullPage: true, animations: 'disabled' });
});

test('a second session is usable while another runs and hidden results remain unread', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Alpha session', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Another slow task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation-head').getByText('Running', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open session Alpha session', exact: true }).locator('.compact-status .spin')).toBeVisible();
  await page.getByRole('button', { name: 'New session in Alpha other', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible();
  await expect(page.locator('.session-tags').getByText('Alpha other', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A quick task in a different folder');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Working asynchronously. Task complete.', { exact: true })).toBeVisible();
  const host = await page.getByRole('combobox', { name: 'Host', exact: true }).inputValue();
  await expect.poll(async () => page.evaluate(async id => {
    const state = await (await fetch(`/api/v1/h/${id}/state`)).json();
    const task = state.tasks.find((item: { title: string }) => item.title === 'Alpha session');
    return { completed: task.status === 'completed', unread: task.attentionSeq > task.lastReadSeq };
  }, host)).toEqual({ completed: true, unread: true });
  await expect(page.getByRole('button', { name: 'Open session Alpha session', exact: true }).locator('.compact-status')).toHaveClass(/completed/);
  await expect(page.getByRole('heading', { name: 'A quick task in a different folder', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open session Alpha session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open session A quick task in a different folder', exact: true })).toBeVisible();
  await page.screenshot({ path: '.cache/ciel-ui-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Open session Alpha session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Alpha session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open session Alpha session', exact: true }).locator('.compact-status svg')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open session Alpha session', exact: true }).locator('.session-unread')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open session A quick task in a different folder', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Project Alpha other', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Alpha session', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible();
  await expect(page.locator('.session-tags').getByText('Alpha other', { exact: true })).toBeVisible();
});

test('an approval shows attention without blocking other projects, then finishes green', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New session in Alpha project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible();
  await expect(page.locator('.session-tags').getByText('Alpha project', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Please ask for approval');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Continue this test?', { exact: true }).first()).toBeVisible();
  const waiting = page.getByRole('button', { name: 'Open session Please ask for approval', exact: true });
  await expect(waiting.locator('.compact-status')).toHaveClass(/attention/);
  await page.getByRole('button', { name: 'New session in Alpha other', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible();
  await expect(waiting.locator('.compact-status')).toHaveClass(/attention/);
  await waiting.click();
  await page.locator('.approval-card').getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(waiting.locator('.compact-status')).toHaveClass(/completed/);
  await expect(page.getByText('Working asynchronously. Task complete.', { exact: true })).toBeVisible();
});

test('skills open for reading and setup lives under Settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skills Library', exact: true }).click();
  await page.getByRole('button', { name: 'Read Alpha coding guide', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project conventions', exact: true })).toBeVisible();
  await expect(page.getByText('Explain the checks you ran.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Content', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Alpha coding guide', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Content', exact: true })).toHaveValue(/# Project conventions/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Reading must stay separate from the editor; leave the reader if it is a dialog.
  const close = page.getByRole('dialog').getByRole('button', { name: /Close/ });
  if (await close.count()) await close.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Computers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Computers', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agents & accounts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agents & accounts', exact: true })).toBeVisible();
});

test('activity pairs real tool calls, hides bookkeeping and stays with the selected turn', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New session in Alpha other', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible();
  await expect(page.locator('.session-tags').getByText('Alpha other', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('activity-check');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation-head').getByText('Completed', { exact: true })).toBeVisible();
  const inspector = page.getByRole('region', { name: 'Selected turn activity', exact: true });
  await expect(inspector.locator('.tool-entry')).toHaveCount(1);
  await expect(inspector.getByText('Web search', { exact: true })).toBeVisible();
  for (const noise of ['task read', 'changes captured', 'userMessage', 'tool completed', 'run queued']) await expect(page.getByText(noise, { exact: true })).toHaveCount(0);
  const first = page.getByRole('region', { name: 'Turn 1 activity', exact: true });
  await expect(first.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await first.getByRole('button').click();
  await expect(first.locator('.tool-entry')).toHaveCount(1);
  await first.locator('.tool-entry > summary').click();
  await expect(first.getByText('webSearch', { exact: true })).toBeVisible();
  await expect(first.getByText(/Malus domestica Wikipedia/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('activity-check activity follow-up');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(inspector.getByText('Run command', { exact: true })).toBeVisible();
  await expect(page.locator('.conversation-head').getByText('Completed', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Web search', { exact: true })).toHaveCount(0);
  const turns = page.getByRole('combobox', { name: 'Changes turn', exact: true });
  const previous = await turns.evaluate(select => (select as HTMLSelectElement).options[0]!.value);
  await turns.selectOption(previous);
  await expect(inspector.getByText('Web search', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Run command', { exact: true })).toHaveCount(0);
  await inspector.locator('.tool-entry > summary').click();
  await page.screenshot({ path: '.cache/ciel-activity-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(first.getByRole('button')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.cache/ciel-activity-mobile.png', fullPage: true, animations: 'disabled' });
});
