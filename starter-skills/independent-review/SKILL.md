---
name: independent-review
description: Review someone else's change as a skeptical reader, looking for real defects rather than style. Use when asked to review a diff, a pull request, or work another agent finished.
license: MIT
metadata:
  author: codeshi
  version: "1"
---

1. Read what the change was meant to do first, then read the change itself, and then the code around it. Don't trust the description of what it does.
2. Look for what would actually go wrong: wrong behavior, unhandled failures, data loss, security holes, broken callers, race conditions, and tests that pass without proving anything.
3. Try to confirm each problem. Trace the path, or run it if you are allowed to. Say how you confirmed it, or that you couldn't.
4. For each finding give the file and line, what goes wrong and when, and how serious it is. Leave out matters of taste.
5. Say what you checked and found fine, and what you did not check. "No problems found" means little without that.
6. Don't change anything unless you were asked to.
