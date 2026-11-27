---
name: chrome-browser
description: Drive the user's own Chrome through the chrome service (chrome plugin). Use when the user asks to open a page in their browser, read what is on a page they are logged into, click through a web app, fill a form, or take a screenshot of their browser.
---

# Chrome browser

The `chrome` service controls the user's real Chrome through the Speedwave extension, with the user's logins and cookies. Call it from `execute_code` as `chrome.<tool>(...)`.

Loop:

1. `chrome.openTab({ url, newWindow })` or `chrome.listTabs()` to get a `tabId`. Always pass `tabId` afterwards; without it the tool acts on whatever tab the user has in front.
2. `chrome.readPage({ tabId })` lists links, buttons and fields with refs like `[e12]`. `mode: 'all'` adds text, `mode: 'text'` returns the visible text only.
3. `chrome.click({ tabId, ref })`, `chrome.type({ tabId, ref, text, clear, submit })`, `chrome.pressKey({ tabId, key })`, `chrome.scroll({ tabId, dy })`.
4. Read the page again after every action that changes it; refs of re-rendered elements change.
5. `chrome.screenshot({ tabId })` when layout matters; return its result from `execute_code` to see the image.
6. `chrome.evalJs({ tabId, code })` for anything the tools above do not cover. It runs in the page with the user's session.

Errors with `NOT_CONNECTED` mean the extension is not paired: tell the user to open the Speedwave extension popup in Chrome and check its status.

Do not enter passwords, payment data or personal data of other people, do not buy anything and do not send messages on the user's behalf without the user confirming it in the chat first.
