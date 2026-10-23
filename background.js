// Open the URL of the triggered slot.
browser.commands.onCommand.addListener(async (name) => {
  try {
    if (name === OPTIONS_CMD) return await browser.runtime.openOptionsPage();
    if (!/^slot-\d+$/.test(name)) return;
    const url = (await loadRows())[slotIndex(name)]?.u;
    if (url) await browser.tabs.create({ url: normalizeUrl(url) });
  } catch (err) { console.error(`URL Shortcuts: ${name} failed`, err); }
});

// After a storage loss, rebuild from the sync mirror and re-apply shortcuts
async function init() {
  if (await restore()) await applyShortcuts(await loadRows(), await loadExtras());
}
browser.runtime.onInstalled.addListener(() => init().catch(console.error));
browser.runtime.onStartup.addListener(() => init().catch(console.error));
