# Threat model: Interactive artifact previews (Phase 19, INV-51)

A reply can capture a file (Phase 13c). Today every captured file is shown only as inert source. Phase 19 adds an optional **preview** that runs a captured `.html` or `.svg` file, so that a generated visualization (a parabola with sliders, a small chart) works. The file's content comes from the model and must be treated as **hostile code** (INV-22, INV-41). Anyone who can put text in front of the model can write it.

## Options considered

| Option                                                         | What it allows                                                   | Risk                                                                      | Decision                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| A. Declarative widgets only                                    | The `ui` blocks of Phase 14b: cards, tabs, charts, quizzes       | None beyond Phase 14b; no code runs                                       | **Kept**, and still the default for model-made visuals |
| B. Scripted preview in a sandboxed frame on the app origin URL | The file's own HTML, CSS and JavaScript                          | The script runs; it must not reach the session, storage, APIs or the page | **Chosen**, with the controls below                    |
| C. Same as B on a separate preview origin                      | As B, plus a different site, so browsers give it its own process | Needs a second hostname and TLS on the proxy                              | **Supported** as an operator option (`PREVIEW_ORIGIN`) |
| D. `srcdoc` on the app origin                                  | As B                                                             | Inherits the app's origin unless sandboxed, and the app's CSP             | **Rejected** (the spec forbids it as a shortcut)       |

## Assets

- The session cookie, the CSRF token and every API reachable with them.
- Other chats, files and memories; other accounts.
- The app's own interface and the browser tab's responsiveness.
- The user's privacy: no request leaves for another origin.

## Adversary

Whoever controls the file's content: the model, or anyone who can put text in front of it. They know how previews work. They do not control ChatUI's code, its headers or the server.

## Controls

1. **Off by default and explicit.** Previews run only if the user turned on Settings → Appearance → "Run file previews". Even then, each preview starts only when the user clicks "Run preview" on a file. The inert source view, Copy and Download always stay available.
2. **Capability URL instead of cookies.** Clicking "Run preview" asks the API, with the session and CSRF token, for a **single-use token**. The token is an HMAC over the user, the file and an expiry 60 s ahead, keyed with a per-process secret. The frame loads `/api/preview/<token>`. That route authenticates by the token only, so the preview needs no cookie. The token is consumed on first use, and a token for another user's file can't be minted.
3. **Opaque origin.** The frame has `sandbox="allow-scripts"`, without `allow-same-origin`, and the response carries the CSP `sandbox allow-scripts`, so the document is sandboxed even when opened directly. The script runs in a unique opaque origin: `document.cookie` and `localStorage` throw, and the parent page is cross-origin (no DOM, no globals).
4. **No network.** The preview's own CSP:
   - `default-src 'none'`;
   - inline scripts and styles allowed, but only inside this sandboxed document;
   - `img-src data: blob:`, `font-src data:`, `media-src data: blob:`;
   - `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`, `worker-src 'none'`.
     Nothing can be fetched, beaconed, submitted or loaded from anywhere, the app included.
5. **No escape from the frame.** The sandbox has no `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals` or `allow-downloads`. The `Permissions-Policy` disables every powerful feature, and the frame's `allow` attribute grants none.
6. **No message protocol.** The app never reads messages from the frame: a forged `postMessage` has no listener to reach. The frame receives nothing from the app either.
7. **Framing limited to the app.** The preview response is `frame-ancestors 'self'`, plus `PREVIEW_ORIGIN`'s embedder when one is configured. App pages keep `frame-ancestors 'none'`. The app's own CSP adds only the preview's source to `frame-src`.
8. **Bounds.** Only `.html`/`.htm`/`.svg` captured files up to 512 KB are previewable. The frame has a fixed size and its content cannot draw outside it. The dialog's Stop/Close removes the frame: closing it, leaving the chat or signing out tears the preview down completely.
9. **CPU and memory.** A preview that spins or allocates without end can slow the tab. Browsers with site isolation run sandboxed opaque-origin frames in their own process; `PREVIEW_ORIGIN` guarantees that through a separate site. The close button stays usable whenever the frame runs out of process. See Residual risks.
10. **No secrets inside.** The preview document is exactly the captured file: no session data, user names or tokens are injected, and nothing about it is logged except the file id.

## Residual risks

- **Same-process frames.** On a browser without sandboxed-frame process isolation and without `PREVIEW_ORIGIN`, a script that spins forever freezes the tab until the browser offers to stop it. The data stays safe; only availability is affected. Operators who enable previews for untrusted content should set `PREVIEW_ORIGIN`.
- **Phishing-looking content.** A preview can draw anything inside its frame, including a fake sign-in form. It cannot submit one (`form-action 'none'`, no network), and the frame is labelled "Preview of a file from a reply".

## Tests

- `tests/server/preview.test.ts`:
  - the token is minted only for the owner and only with the setting on;
  - it is single-use and expires;
  - a forged or altered token is refused;
  - the size and type limits hold;
  - the preview response headers (sandbox CSP, no network, framing, nosniff, no-store);
  - the token route carries no cookie dependency.
- `tests/e2e/preview.spec.ts`: a hostile file tries cookies, `localStorage`, the parent DOM, `fetch` to the API, a popup, top navigation, a form post, a data: URL navigation and a forged `postMessage`. All of them fail, and the page and other chats are untouched. A legitimate slider preview works with the keyboard. Turning the setting off removes Run preview, and the inert source view still works.
