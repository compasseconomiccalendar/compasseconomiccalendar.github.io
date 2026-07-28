# Chrome Extension — Phase 2 (not started)

Placeholder. Nothing here yet.

The extension is a thin client: it fetches the published `calendar.json` from
GitHub Pages and renders it. It performs no direct calls to government sites —
that is the whole point of the architecture in `docs/RESEARCH.md` §4.2.

## Planned shape

- MV3 manifest, React popup: upcoming events, timezone selector, event detail
- `chrome.alarms` + notifications for 30-minute and 5-minute warnings
- Cache the fetched JSON in `chrome.storage`
- `host_permissions` limited to the Pages origin only — one entry, easy to
  justify in Web Store review
- FRED attribution and the "not investment advice" disclaimer visible on
  every view

## Constraints to design around (RESEARCH.md §4.1)

- Service worker terminates after 30s idle; `chrome.alarms` floor is 30s
- Remote **code** is banned in MV3; fetching remote **data** is fine
- A privacy policy at a real URL is required for submission
