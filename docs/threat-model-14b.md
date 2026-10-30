# Threat model: Intelligent UI blocks (Phase 14b, decision D3)

A model reply may contain a fenced block with the info string `ui`. ChatUI turns it into a small interactive view (callout, card, steps, tabs, stats, chart, quiz, progress). The block's text comes from the model and must be treated exactly like any other untrusted model output (INV-22). A prompt-injected document, search result or earlier chat can make the model produce any block.

## Assets

- The user's session and CSRF token, and every API reachable with them.
- The user's data shown in the app (other chats, files, memories).
- The integrity of the app's own interface: what looks like ChatUI's controls must be ChatUI's.
- The browser tab's responsiveness.
- The user's privacy: no request may leave for another origin, and nothing may leak what the user does.

## Adversary

Whoever controls the reply text: the model, or anyone who can put text in front of it (a file, a pasted page, an earlier chat, a tool result). They know the block format. They do not control the app's code, its CSP or the server.

## Threats and mitigations

| #   | Threat                                                                                      | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Script execution (XSS): markup, `javascript:` URLs, event handlers, `eval`-able expressions | The block is **parsed, never evaluated**: a hand-written parser builds a tree of nine allowlisted node types whose fields are plain strings and numbers. Nothing is passed to `eval`, `Function`, `innerHTML`, `dangerouslySetInnerHTML` or a template engine. Every string is rendered as a React text node. The strict CSP (no inline scripts without the nonce, `style-src-attr 'none'`) still applies. |
| T2  | Style injection and layout attacks (covering the page, invisible overlays)                  | No styles or class names come from the block. Tones are an enum (`info`, `tip`, `warning`, `success`) that maps to fixed classes. Chart geometry is computed by ChatUI from clamped numbers. The block is laid out inside the message column with `overflow: hidden` and `contain: content`, so it cannot draw outside it.                                                                                 |
| T3  | Interface spoofing: fake sign-in forms, "Approve" buttons, system notices                   | No text fields, password fields, forms or links. The only controls are quiz options, a Check button and tab buttons, which change local state only. Every block sits in a frame labelled "Interactive block" that never looks like the app's own dialogs or notices.                                                                                                                                       |
| T4  | Network access: tracking pixels, beacons, data exfiltration through URLs                    | Blocks have no URLs, images, fonts or embeds. Nothing in a block can cause a request. The CSP `connect-src`/`img-src 'self'` would block one anyway.                                                                                                                                                                                                                                                       |
| T5  | Resource exhaustion: huge or deeply nested blocks, pathological charts                      | Hard bounds: 20,000 characters of source, 300 nodes, nesting depth 4, 1,000 characters per string, 12 tabs, 8 quiz options, 40 chart points, 24 stats. Over a bound, the block is shown as plain code. The parser is linear in the input, with no backtracking regular expressions over user text. Parsing is memoized per source string.                                                                  |
| T6  | Streaming abuse: a half-written block that flickers or throws                               | Only complete lines are parsed while a block is still streaming; a parse error shows the source as code instead of throwing. Rendering errors are caught by the message's error boundary.                                                                                                                                                                                                                  |
| T7  | Data leakage through interaction (a quiz that reports answers)                              | Interaction state lives in the component only. It is never sent, stored or put into later prompts.                                                                                                                                                                                                                                                                                                         |
| T8  | Confusing the stored record                                                                 | Canonical Markdown keeps the original fenced block byte for byte. Rendering never changes it, and exports carry the source.                                                                                                                                                                                                                                                                                |
| T9  | A user who does not want any of this                                                        | Settings → Appearance → "Interactive blocks" (on by default) turns rendering off; blocks then show as code.                                                                                                                                                                                                                                                                                                |

## Out of scope

- Running model-supplied programs of any kind (Phase 19, optional, separate approval).
- Links inside blocks. Markdown links stay in normal Markdown, where `safeUrl` filters them.

## Format (statement form and JSON form)

Statement form: one statement per line, children indented by two spaces.

```text
callout tip Drink water before you run.
card Morning plan
  text Start slow; the first kilometre is a warm-up.
  steps
    - Warm up for 5 minutes
    - Run 3 km
stats
  stat Distance = 5 km
  stat Pace = 6:10 /km | steady
chart bar Weekly kilometres
  Mon = 5
  Wed = 8
quiz Which muscle does a squat work most?
  option Biceps
  option* Quadriceps
  explain Squats load the quadriceps and glutes.
tabs
  tab Beginner
    text Three runs a week.
  tab Advanced
    text Five runs a week.
progress Training block = 40
divider
```

JSON form: a block whose content starts with `{` or `[` is parsed with `JSON.parse` and validated into the same tree (`{"type": "card", "title": "…", "children": […]}`).

## Tests

`tests/client/ui-blocks.test.tsx` covers parsing of every node type, the bounds, hostile input (markup, `javascript:`, prototype keys, deep nesting, huge numbers), partial streaming input, the setting, and rendering through text nodes only. `tests/e2e/ui-blocks.spec.ts` covers the browser: rendered blocks, no requests, keyboard tabs and quiz, and the setting.
