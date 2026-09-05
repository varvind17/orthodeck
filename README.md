# OrthoDeck — install and use on your iPhone

OrthoDeck is a Progressive Web App: a small website that your iPhone installs like an app. Once it's on your home screen it opens full-screen, works offline, and keeps all study data on the phone.

Files in this folder:

| File | What it is |
|---|---|
| `index.html` | the app screen and styling |
| `app.js` | spaced-repetition engine, sessions, editing, AI chat |
| `db.js` | on-device storage (IndexedDB) |
| `cards.js` | the seed deck (1,891 granular cards, one fact each; spine includes Miller's ch. 8) |
| `sw.js` | service worker — makes it work offline |
| `manifest.json`, `icons/` | lets iOS install it as an app |
| `vendor/` | pdf.js — reads PDFs on the phone for the chapter importer |

---

## Part 1 — Put it online with GitHub Pages (one time, ~10 minutes, easiest from a computer)

1. Go to https://github.com and sign in (create a free account if needed).
2. Click **+** (top right) → **New repository**. Name it `orthodeck`, leave it **Public**, click **Create repository**.
3. On the empty repository page click **uploading an existing file**.
4. Drag all six files/folders from this folder into the upload box (`index.html`, `app.js`, `db.js`, `cards.js`, `sw.js`, `manifest.json`, and the `icons` folder). Click **Commit changes**.
   - If the browser won't take the `icons` folder, upload the three PNGs inside it first, then use **Add file → Upload files** again; GitHub keeps the folder name if you drag the folder itself.
5. Click **Settings** (repository tab) → **Pages** (left sidebar).
6. Under **Build and deployment → Branch**, choose `main` and `/ (root)`, click **Save**.
7. Wait a minute, refresh the Pages screen. It shows your address, e.g. `https://YOURNAME.github.io/orthodeck/`. Open it in a browser to check it loads.

Public repository means the *app code* is public. Your study progress, edits, images, chats and API key never leave your phone.

## Part 2 — Install on your iPhone

1. Open **Safari** (it must be Safari, not Chrome) and go to `https://YOURNAME.github.io/orthodeck/`.
2. Tap the **Share** button (square with an arrow, bottom of the screen).
3. Scroll the sheet and tap **Add to Home Screen**, then **Add**.
4. Open **OrthoDeck** from your home screen. Open it once while online so it caches itself; after that it works in airplane mode.

## Part 3 — Turn on AI chat (optional)

1. Get an API key at https://console.anthropic.com → **API Keys** → **Create Key**. Copy it.
2. In OrthoDeck tap the gear → **AI chat** → paste the key. It's stored only on the phone (and is not included in backups).
3. On any card tap **Ask AI**. The quick chips (Mechanism, Why not X?, Mnemonic, Quiz me, Related) are one-tap prompts.

Chat needs a signal; studying does not. Usage is billed to your key at Anthropic's normal API rates; a typical question costs well under a cent. The default model is set in Settings and can be changed to any current Claude model name.

## Part 4 — Studying

- **Home** shows what's due. **Start studying** runs everything due; tapping a domain runs just that domain; **Quick 10** grabs ten cards (including cards not yet due) for a 2-minute gap.
- **Tap** the card or **Show answer** to reveal. Rate with **Again / Hard / Good / Easy** — the little number under each is when you'll see the card next. **Swipe right = Good, swipe left = Again.**
- **Undo** (curved arrow) takes back the last rating. **Skip** sends the card to the end of the session.
- Cards are deliberately granular — one fact per card, a phrase per side — so expect fast reviews and a large daily count. Scheduling is an SM-2 variant with Anki-style learning steps (1 min → 10 min → 1 day; Easy jumps to 4 days). Lapses drop the ease factor. Default 20 new cards/day, adjustable in Settings.
- New cards are drawn in proportion to the AAOS OITE blueprint (Hip & knee 19%, Pediatrics 12%, Trauma 11%, Basic science 10%, Foot & ankle 9%, Spine 9%, Shoulder & elbow 8%, Hand 7%, Oncology 7%, Sports 7%). Note the blueprint is anatomic: hip/femur/knee fractures and arthroplasty are in "Hip & knee".

## Part 5 — Editing cards and adding images

- **Edit** on any card: rewrite the front/back and add your own photos (de-identified). Photos are resized and stored on the phone only. **Revert to built-in card** undoes your edits.
- **Browse cards** (search box + domain chips) to find any card; **+** adds your own card.
- **Export backup** in Settings downloads a JSON file with progress, edits, your cards and chats. **Import backup** restores it on another phone.

## Part 6 — Make cards from a textbook chapter

1. On your phone, save the chapter PDF somewhere you can reach from the Files app (iCloud Drive, Downloads, or AirDrop it).
2. In OrthoDeck tap **Make cards from a chapter** (home screen) or Settings → Import.
3. Choose the PDF (or paste text), pick the domain (or let the model decide per card) and a density, then **Read and make cards**. The PDF is read on the phone; the text goes to Claude in sections of ~4,500 words, one request each. A 50-page chapter is about 8–10 requests and takes a few minutes — keep the app in the foreground.
4. Every generated card lands in a **review queue**. Tap a card to edit the front/back/domain, then **Accept** (adds it to your deck as your own card), **Discard**, or **Skip for now**. **Accept all** exists but the point of the queue is that you check numbers and classifications against the book first.
5. Accepted cards show under Browse → **Mine** and enter the normal study rotation.

Notes: scanned PDFs with no text layer will not work (you need a PDF where you can select text). The importer needs a signal and uses your API key; cost is roughly a few cents per chapter. The queue survives closing the app and is included in backups.

## Part 7 — Updating the app later

If you change any file (e.g. add cards to `cards.js`), also change `CACHE_VERSION` in `sw.js` (e.g. `orthodeck-v2`) before uploading to GitHub, or installed phones will keep the old cached copy. The app shows "Update ready — close and reopen" when it downloads the new version.

When adding cards to `cards.js`, add them at the **end** of a domain block. Card IDs come from their position, so inserting in the middle would shift progress onto the wrong cards.

## Caveats

- The seed deck was written as a study aid, not a clinical reference. Numbers and thresholds drift between sources and years — verify anything you'd act on.
- iOS can evict a PWA's stored data if the app isn't opened for several weeks and the phone runs low on space. Export a backup now and then.
- Built: study engine + seed deck (1,891 one-fact cards), per-card editing/images, AI chat, chapter importer with review queue. Not built: subspecialty "advanced" tiers and the curated "What's new" PubMed feed.
