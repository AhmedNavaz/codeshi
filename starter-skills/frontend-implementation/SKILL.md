---
name: frontend-implementation
description: Build or change user interface components so they match the project's existing patterns and hold up in every state. Use for frontend, component, page, layout or styling work.
license: MIT
metadata:
  author: codeshi
  version: "1"
---

1. Before writing anything, read two or three nearby components and copy how they handle structure, naming, styling and data. Reuse existing components and design tokens rather than adding new ones.
2. List the states this interface can be in: loading, empty, error, disabled, very long text, and small screens. Handle each one, or say which you left out and why.
3. Keep the change small enough to review. Don't reformat or restructure code you aren't changing.
4. Check it the way a person would use it. Run the project's own checks, and if you can open it, try the main path and at least one failure.
5. Report what you changed, which states you checked, and anything you could not verify. Don't claim something looks right if you didn't see it.
