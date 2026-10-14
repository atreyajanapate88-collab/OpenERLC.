# OpenERLC: all-in-one HTML

One file: `index.html` (chat page + the API logic that used to be api/chat). No server, no build.

## Host on Vercel
Put `index.html` at the root of a repo (or drag the folder into Vercel), deploy as "Other". Nothing else is needed.

## Keys
Click Settings on the page and paste your Groq key (and optionally the ER:LC server key). They are saved only in that browser.
Do NOT paste keys into the file: everything in a static page is visible to every visitor.
`CONFIG.GROQ_KEY` exists for convenience but anyone could copy a key placed there.

## Limits
- Each visitor needs their own free Groq key (a static page can't hide one). For a public site where visitors need no key, use the Vercel version with the api/ folder.
- Live stats call api.erlc.gg from the browser; if it blocks browser requests (CORS) they won't work without a backend.
