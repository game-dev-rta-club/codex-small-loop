# Sonner Project Reader Builds

`sonner-project-reader` is Sonner's packaged, read-only macOS helper. It
receives the already verified project Root as fd 3, walks descendants only with
descriptor-relative no-follow operations, and returns bounded file-prefix and
`WORK_NODE.xml` bytes. Neither its request nor its arguments contain the Root
pathname. Protocol v2 first runs the exact `git-ls-files` mode from the retained
Root cwd, then uses the same Root handle for framed content and Work reads. The
installed plugin does not compile this helper at runtime.

Build a universal macOS 13-or-later binary from the adjacent source:

```sh
clang -arch arm64 -mmacosx-version-min=13.0 -Os -std=c11 \
  -Wall -Wextra -Werror sonner-project-reader.c -o reader-arm64
clang -arch x86_64 -mmacosx-version-min=13.0 -Os -std=c11 \
  -Wall -Wextra -Werror sonner-project-reader.c -o reader-x86_64
lipo -create reader-arm64 reader-x86_64 -output sonner-project-reader
codesign --force --sign - sonner-project-reader
chmod 755 sonner-project-reader
```

The packaged output is ad-hoc signed and contains arm64 and x86_64 slices.
Its SHA-256 is
`581b4f8e5366dc5f0761486e179183af53472adb7620194681a3396861c6dc7d`.
Tests compile a temporary current-architecture helper with
`SONNER_PROJECT_READER_TEST_HOOKS`; its control fd 4 pauses descriptor
transitions so replacement and mutation races can be exercised without adding
test behavior to production.

## Runtime readers

`sonner-runtime-reader` reads only the fixed project ledger or Recovery
Supervisor diagnostic beneath an inherited verified Root fd. Build it with the
adjacent shared safe-I/O source for both architectures, then merge and sign:

```sh
clang -arch arm64 -mmacosx-version-min=13.0 -Os -std=c11 -Wall -Wextra -Werror \
  sonner-runtime-reader.c sonner-safe-io.c -o runtime-arm64
clang -arch x86_64 -mmacosx-version-min=13.0 -Os -std=c11 -Wall -Wextra -Werror \
  sonner-runtime-reader.c sonner-safe-io.c -o runtime-x86_64
lipo -create runtime-arm64 runtime-x86_64 -output sonner-runtime-reader
codesign --force --sign - sonner-runtime-reader
chmod 755 sonner-runtime-reader
```

Its SHA-256 is
`4e40434461cc8a96405453b91bc8a138a58bd89ec2bd5d990055de284f8e3a04`.

`sonner-task-history-reader` retains active and archive session-root fds,
discovers requested histories, and streams at most the final 2 MiB per history
after discarding its first partial JSONL record. Protocol v2 marks a returned
window as truncated so Node accepts only a provable latest Turn boundary. It
uses the same build procedure, substituting
`sonner-task-history-reader.c` and the output names. Its SHA-256 is
`36ea085033ca13a10c4253fdd76116711ce9a660b35173631b24219a1b7647a8`.
Both packaged outputs are ad-hoc signed universal arm64/x86_64 binaries. The
installed plugin never compiles them at runtime.
