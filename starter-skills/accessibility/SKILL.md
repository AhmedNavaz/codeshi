---
name: accessibility
description: Check and fix interface changes so they work with a keyboard and a screen reader, and with low vision. Use when building or reviewing controls, forms, dialogs, menus, or anything interactive.
license: MIT
metadata:
  author: codeshi
  version: "1"
---

Check each of these for what you changed, and fix what fails:

1. **Keyboard.** Everything clickable can be reached and used with the keyboard alone, in a sensible order, and focus is visible. A dialog keeps focus inside it and returns it when closed.
2. **Names.** Every control has a name a screen reader can read. An icon-only button needs a label. Use real buttons, links and headings before adding ARIA roles.
3. **Forms.** Every input has a label. Errors say what is wrong and how to fix it, and are tied to their input.
4. **Status.** Changes that appear without a click, such as a saved message or a new result, are announced.
5. **Sight.** Text and controls have enough contrast. Color is never the only signal. Layout survives 200% zoom. Motion respects the reduced-motion setting.

Report what you checked and how. Say plainly what needs testing with a real screen reader, since reading the code can't confirm it.
