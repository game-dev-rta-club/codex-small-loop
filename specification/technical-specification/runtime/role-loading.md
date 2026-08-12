---
summary: >-
  role.mjs reads one explicitly named installed Role in full without inferring
  identity from the current Task or changing runtime state.
---

# Role Loading

The public Role command has one deliberately small form:

```text
node <plugin-root>/components/commands/role.mjs <role>
```

The command validates a bounded kebab-case Role name, reads the complete
`components/roles/<role>/role.md` file, and writes its Markdown unchanged to
standard output. The calling agent reads that complete output and applies it as
the active Role.

Role loading is explicit. The command does not inspect the current Task,
Conversation, ledger, or message history to infer a Role. It does not mutate
project state. An invalid or missing Role fails closed with a machine-readable
error on standard error.

## Implementation And Proof

- [Role command](/implementation/components/commands/role.mjs)
- [Role loader](/implementation/components/runtime/source/role-loader.mjs)
- [Role CLI tests](/implementation/components/runtime/tests/role-cli.test.mjs)
