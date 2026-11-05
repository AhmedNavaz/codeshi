---
name: test-authoring
description: Write tests that fail for the right reason and protect behavior rather than implementation. Use when adding tests, fixing a bug that needs a regression test, or checking a change you can't otherwise verify.
license: MIT
metadata:
  author: codeshi
  version: "1"
---

1. Read how this project's tests are set up, and match their style, helpers and location. Don't add a new test tool without asking.
2. Test what a user or caller can observe, not how the code is arranged inside.
3. For a bug, write the test first and watch it fail for the reason you expect. Then fix the code. A test you have never seen fail proves little.
4. Cover the main path, the edges (empty, limits, wrong input) and the way this could realistically break. Skip tests that only repeat the code.
5. Keep tests independent and repeatable, with no reliance on order, the current time, the network or leftover files.
6. Never weaken, skip or delete an existing test to make something pass. If one seems wrong, say why and let the person decide.
7. Report which tests you added, that they ran, and what they still don't cover.
