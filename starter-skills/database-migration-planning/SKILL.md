---
name: database-migration-planning
description: Plan a database schema or data migration so it can run safely against real data and be undone. Use for new tables or columns, changed types, backfills, indexes and anything that alters stored data.
license: MIT
metadata:
  author: codeshi
  version: "1"
---

1. Read the current schema and the code that uses this data. Find out how much data there is, if you can, because that decides what is safe.
2. Plan in steps that each leave the system working: add the new shape, write to both, backfill, read from the new one, and only then remove the old one.
3. For each step, say whether it locks a table, how long it might take at this size, and what happens to requests while it runs.
4. Write how to undo each step. If a step can't be undone, such as dropping a column, say so and put it last.
5. Do not run a migration against any shared or production database. Test it on a copy, and leave running it for real to the person.
6. Report the steps in order, what each one risks, and how you tested it.
