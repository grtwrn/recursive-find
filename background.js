// Service worker: nothing to orchestrate anymore — the side panel owns the
// Web Worker pool and the crawl. We only configure the panel to open (and
// toggle closed) when the toolbar icon is clicked. Unlike a popup, the panel
// stays open until dismissed.

chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch(() => {});
