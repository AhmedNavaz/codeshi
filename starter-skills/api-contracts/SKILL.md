---
name: api-contracts
description: Design or change an API so that its callers and its implementation agree before either is built. Use for new endpoints, changed request or response shapes, and work split between frontend and backend.
license: MIT
metadata:
  author: codeshi
  version: "1"
---

1. Find who calls this API today, and read how similar endpoints in the project handle naming, errors and pagination. Follow those conventions.
2. Write the contract before the code: method and path, request fields, response fields, each error and when it happens, and which fields can be missing or null.
3. A change to an existing API must not break current callers. Add fields rather than renaming or removing them. If a break is unavoidable, say so plainly and list the callers it affects.
4. Validate input at the boundary, and never return more than the caller needs. Check who is allowed to make this call.
5. Add or update tests for the contract itself: one success, each error, and the edge of each limit.
6. Report the final contract, so whoever builds the other side can work from it.
