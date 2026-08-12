# Board Native Helper Builds

`activity-signal-reader` is a packaged, narrowly scoped macOS helper for the
Activity's descriptor-anchored read-only Signal traversal. It is not compiled at
startup and the installed plugin does not require Xcode.

The checked-in binary was built on 2026-08-05 with Apple clang 17.0.0 from
`activity-signal-reader.c`, targeting macOS 13 or later:

```sh
clang -arch arm64 -mmacosx-version-min=13.0 -Os -std=c11 \
  -Wall -Wextra -Werror activity-signal-reader.c -o reader-arm64
clang -arch x86_64 -mmacosx-version-min=13.0 -Os -std=c11 \
  -Wall -Wextra -Werror activity-signal-reader.c -o reader-x86_64
lipo -create reader-arm64 reader-x86_64 -output activity-signal-reader
codesign --force --sign - activity-signal-reader
chmod 755 activity-signal-reader
```

The packaged output is an ad-hoc-signed universal Mach-O containing `arm64`
and `x86_64`. Protocol v2 receives the already verified project Root as child
fd 3 plus its device/inode identity; neither the request nor process arguments
contain the Root pathname. Snapshot and Signal-name arrays are capped before
growth/sort at the request's hard-bounded Signal limit, and the native filename
grammar is mirrored by the Node frame validator. Its SHA-256 is:

```text
9be1eb5e1360fa7a79352d49e71ac02e033720adb4608bd6ae0ff01a35b75079
```

Tests compile a temporary current-architecture build with
`ACTIVITY_SIGNAL_READER_TEST_HOOKS` to exercise descriptor-transition races. That
test-only control descriptor is fd 4 and is never supplied during production
reads.

Board Host lifecycle is implemented entirely in Node.

`sonner-open-file` is the Board-owned Open-only helper. It is linked to the
CoreFoundation and CoreServices frameworks and receives the verified project
Root as fd 3. It traverses relative components with no-follow descriptor
operations, retains the indexed regular-file or validated Work-directory
descriptor, creates a Core Foundation file-reference URL, binds that reference
back to the same type, device, and inode, and passes the reference object itself
to `LSOpenCFURLRef`. Neither
the project Root pathname nor a resolved verification pathname becomes a
launch argument.

The checked-in binary was built with the same Apple clang and macOS 13 target:

```sh
clang -arch arm64 -mmacosx-version-min=13.0 -Os -std=c11 -Wall -Wextra -Werror \
  sonner-open-file.c -framework CoreFoundation -framework CoreServices -o opener-arm64
clang -arch x86_64 -mmacosx-version-min=13.0 -Os -std=c11 -Wall -Wextra -Werror \
  sonner-open-file.c -framework CoreFoundation -framework CoreServices -o opener-x86_64
lipo -create opener-arm64 opener-x86_64 -output sonner-open-file
codesign --force --sign - sonner-open-file
chmod 755 sonner-open-file
```

Its SHA-256 is:

```text
520a6ab9d53a1674a3c9949831da59d6fefa1083fc1a2152a31943290d05f973
```

Tests compile a current-architecture build with
`SONNER_OPEN_FILE_TEST_HOOKS`. That build replaces the LaunchServices call
with an identity-checking adapter and exposes transition fd 4; neither seam is
present in the production binary.
