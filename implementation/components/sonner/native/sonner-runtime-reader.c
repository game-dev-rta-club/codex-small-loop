#include "sonner-safe-io.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PROTOCOL_VERSION 1
#define MODE_LEDGER 1
#define MODE_DIAGNOSTIC 2
#define FRAME_HELLO 1
#define FRAME_PRESENT 2
#define FRAME_MISSING 3
#define FRAME_UNSAFE 4
#define FRAME_FINAL 5

static uint32_t be32(const unsigned char *value) {
  return ((uint32_t)value[0] << 24) | ((uint32_t)value[1] << 16) |
         ((uint32_t)value[2] << 8) | value[3];
}
static uint64_t be64(const unsigned char *value) {
  uint64_t result = 0;
  for (int index = 0; index < 8; index++) result = (result << 8) | value[index];
  return result;
}
static int read_exact(int fd, void *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(fd, (unsigned char *)buffer + offset, length - offset);
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}
static int write_exact(const void *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(STDOUT_FILENO, (const unsigned char *)buffer + offset,
                          length - offset);
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}
static int frame(const unsigned char *payload, uint32_t length) {
  unsigned char prefix[4] = {(unsigned char)(length >> 24),
                             (unsigned char)(length >> 16),
                             (unsigned char)(length >> 8),
                             (unsigned char)length};
  return write_exact(prefix, 4) || write_exact(payload, length) ? -1 : 0;
}

int main(void) {
  unsigned char prefix[4], request[22], extra;
  if (read_exact(STDIN_FILENO, prefix, 4) != 0 || be32(prefix) != sizeof(request) ||
      read_exact(STDIN_FILENO, request, sizeof(request)) != 0 ||
      read(STDIN_FILENO, &extra, 1) != 0 || request[0] != PROTOCOL_VERSION ||
      (request[1] != MODE_LEDGER && request[1] != MODE_DIAGNOSTIC)) return 2;
  uint32_t maximum = be32(request + 18);
  uint32_t declared = request[1] == MODE_LEDGER ? 32U * 1024U * 1024U : 64U * 1024U;
  if (maximum != declared) return 2;
  int root_fd = -1;
  if (sonner_safe_adopt_root(3, be64(request + 2), be64(request + 10), &root_fd) != 0) return 2;
  close(3);
  unsigned char hello[2] = {FRAME_HELLO, PROTOCOL_VERSION};
  if (frame(hello, sizeof(hello)) != 0) { close(root_fd); return 3; }
  const char *ledger[] = {".codex-small-loop", "state.json"};
  const char *diagnostic[] = {".codex-small-loop", "recovery-supervisor-error.json"};
  unsigned char *bytes = NULL;
  size_t length = 0;
  enum sonner_safe_result result = sonner_safe_read_fixed(
      root_fd, request[1] == MODE_LEDGER ? ledger : diagnostic, 2,
      maximum, &bytes, &length);
  close(root_fd);
  unsigned char status = result == SONNER_SAFE_PRESENT ? FRAME_PRESENT :
                         result == SONNER_SAFE_MISSING ? FRAME_MISSING : FRAME_UNSAFE;
  if (status == FRAME_PRESENT) {
    if (length > UINT32_MAX) { free(bytes); return 2; }
    unsigned char *payload = malloc(length + 5);
    if (payload == NULL) { free(bytes); return 2; }
    payload[0] = status;
    payload[1] = (unsigned char)(length >> 24); payload[2] = (unsigned char)(length >> 16);
    payload[3] = (unsigned char)(length >> 8); payload[4] = (unsigned char)length;
    memcpy(payload + 5, bytes, length);
    free(bytes);
    if (frame(payload, (uint32_t)length + 5) != 0) { free(payload); return 3; }
    free(payload);
  } else if (frame(&status, 1) != 0) return 3;
  unsigned char final[2] = {FRAME_FINAL, status};
  return frame(final, sizeof(final)) == 0 ? 0 : 3;
}
