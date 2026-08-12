# agent-skills interview-me

- Upstream repository: https://github.com/addyosmani/agent-skills
- Upstream path: `skills/interview-me`
- Pinned upstream commit: `7829ffd90d973b6325f5f12f1b1226dcace74443`
- Synthetic split commit: `f95948f0118af7f4c067784ddab693c25cd9ec9f`
- License: MIT; see [LICENSE](/implementation/third_party/agent-skills/LICENSE)

Only the upstream `skills/interview-me` directory is imported. Its synthetic
history is maintained as a Git subtree at
`implementation/third_party/agent-skills/interview-me`; the rest of the upstream skill
collection is not bundled.

## Update

1. Run `node implementation/third_party/agent-skills/update-interview-me.mjs --check`.
2. Review the upstream diff from the pinned commit to the reported commit,
   including `skills/interview-me/SKILL.md` and `LICENSE`.
3. If the license changed, review it and update the vendored
   `implementation/third_party/agent-skills/LICENSE` before applying.
4. Apply the exact reviewed commit with
   `node implementation/third_party/agent-skills/update-interview-me.mjs --apply <commit>`.
5. Run the contract tests and the documented manual Codex Small Loop check.

The update command requires a clean worktree and an exact reviewed commit. It
creates and amends the Git subtree merge commit so the source and split pins
stay attached to the imported content.
