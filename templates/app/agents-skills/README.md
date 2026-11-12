# Skills for developing __title__

Skills in this folder are for people and agents working **on this repository**: how to add a feature the way this
code does it, how to run its agent test, how to release. They are not part of the product: nothing here is served or
offered to its users. The skills the product ships for its users live in `guide/skills/`.

- `__name__-agent-test/` comes with the app: how to prove a route, tool or guide page works for an agent that has
  never seen it. Run it after every change an agent will use.
- One folder per skill, `__name__-<what-it-does>/SKILL.md`, so typing the prefix lists them all.
- Each carries `metadata:` with `internal: true` in its frontmatter. Without it, `npx skills add <this repository>`
  would offer the developer skills and hide the product's own.
- `.claude/skills` links here, so every coding agent finds them.
- Write one only for know-how that is not obvious and not already in `AGENTS.md`. The kit's `api-kit-skills` skill
  (`npx skills add escalay/api-kit`) walks through writing both kinds.
