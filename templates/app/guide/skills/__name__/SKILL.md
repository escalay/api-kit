---
name: __name__
description: Use when a task needs __title__. Replace this line with the situations, words and tool names that should bring an agent here.
---

# __title__

You use __title__ for the user. Use its MCP tools when you are connected to it; otherwise call its API at the
deployment's address with `Authorization: Bearer <key>`. Everything it offers is listed in `/llms.txt`.

## Pick the playbook

| The user wants to… | Playbook |
|---|---|
| know what this service can do | [find-your-way](references/find-your-way.md) |

## Rules

- Follow the `_links` in an answer instead of building addresses yourself.
- On an error, read `detail`: it says what to change.
