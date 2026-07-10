# Chrome Web Store — Privacy practices answers

Paste each block into the matching field in the Developer Dashboard
(Privacy practices tab). Wording is kept minimal and tied to the single purpose,
which is what reviewers look for.

## Single purpose

Recursive Find lets the user search for text on the current web page and, to a
user-chosen depth, on the pages that page links to. It reads the current page's
text and links, fetches the linked pages, searches them for the user's query,
and shows the matches — a recursive version of the browser's built-in Find.

## Permission justifications

### activeTab
Used only when the user starts a search. It grants temporary access to the tab
the user is viewing so the extension can read that page's visible text and its
hyperlinks — the starting point of the search.

### scripting
Used for two things: (1) to read the active tab's visible text and links when a
search starts, and (2) when the user clicks a result, to scroll to and highlight
the matched text in the page that opens. No script is loaded from a remote
source; the injected functions are part of the extension package.

### storage
Used to remember the user's last-used search settings (query, depth, max pages,
match mode, and the checkbox options) between sessions. Everything is stored
locally with chrome.storage.local; nothing is sent anywhere.

### sidePanel
The extension's entire user interface is a side panel. This permission is
required to open and display that panel when the toolbar icon is clicked.

### Host permissions (<all_urls>)
The whole point of the extension is to follow the links on the user's current
page and search those pages. Those links can point to any website, and which
sites they are is not known ahead of time — it depends entirely on the page the
user is viewing — so access cannot be scoped to a fixed list of domains. Access
is used only to (a) fetch the text of pages reachable from the user's current
page during a search the user explicitly starts, and (b) highlight the match in
a result page the user chooses to open. All fetched content is processed locally
in the browser and is never transmitted to us or any third party.

## Are you using remote code?

No. All code is included in the extension package. The extension fetches HTML
from linked pages, but treats it purely as text/data to search — it never
executes it.

## Data usage / disclosures

This extension does not collect, store off-device, or transmit any user data.
Page content is read and searched locally in the browser to produce results and
is discarded when the search ends. No analytics, no tracking, no external
servers.

Data types collected: none.

Certifications (all true — check each box):
- I do not sell or transfer user data to third parties, outside of the approved
  use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.
