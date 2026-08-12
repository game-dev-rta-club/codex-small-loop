#define _DARWIN_C_SOURCE
#include "sonner-safe-io.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int same_stat(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_nlink == right->st_nlink &&
         left->st_size == right->st_size &&
         left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
         left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
         left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
         left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

int sonner_safe_adopt_root(int source_fd, uint64_t expected_dev,
                           uint64_t expected_ino, int *root_fd) {
  struct stat status;
  if (root_fd == NULL || fstat(source_fd, &status) != 0 ||
      !S_ISDIR(status.st_mode) || (uint64_t)status.st_dev != expected_dev ||
      (uint64_t)status.st_ino != expected_ino) return -1;
  *root_fd = fcntl(source_fd, F_DUPFD_CLOEXEC, 5);
  return *root_fd < 0 ? -1 : 0;
}

static enum sonner_safe_result sonner_safe_read(
    int root_fd, const char *const *components, size_t component_count,
    size_t maximum, int tail, unsigned char **bytes, size_t *length,
    int *truncated) {
  int current = fcntl(root_fd, F_DUPFD_CLOEXEC, 5);
  int final_fd = -1;
  enum sonner_safe_result result = SONNER_SAFE_UNSAFE;
  struct stat inspected, opened, before, after;
  unsigned char *buffer = NULL;
  if (current < 0 || components == NULL || component_count == 0 ||
      bytes == NULL || length == NULL || truncated == NULL || maximum == 0) goto done;
  *bytes = NULL;
  *length = 0;
  *truncated = 0;
  for (size_t index = 0; index + 1 < component_count; index++) {
    if (fstatat(current, components[index], &inspected, AT_SYMLINK_NOFOLLOW) != 0) {
      result = errno == ENOENT ? SONNER_SAFE_MISSING : SONNER_SAFE_UNSAFE;
      goto done;
    }
    if (!S_ISDIR(inspected.st_mode)) goto done;
    int next = openat(current, components[index],
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0 || fstat(next, &opened) != 0 ||
        !same_stat(&inspected, &opened)) {
      if (next >= 0) close(next);
      goto done;
    }
    close(current);
    current = next;
  }
  const char *name = components[component_count - 1];
  if (fstatat(current, name, &inspected, AT_SYMLINK_NOFOLLOW) != 0) {
    result = errno == ENOENT ? SONNER_SAFE_MISSING : SONNER_SAFE_UNSAFE;
    goto done;
  }
  if (!S_ISREG(inspected.st_mode) || inspected.st_nlink == 0 ||
      inspected.st_size < 0 || (!tail && (uint64_t)inspected.st_size > maximum)) goto done;
  final_fd = openat(current, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (final_fd < 0 || fstat(final_fd, &opened) != 0 ||
      !same_stat(&inspected, &opened) || fstat(final_fd, &before) != 0) goto done;
  size_t size = tail && (uint64_t)before.st_size > maximum
      ? maximum : (size_t)before.st_size;
  off_t start = before.st_size - (off_t)size;
  buffer = malloc(size == 0 ? 1 : size);
  if (buffer == NULL) goto done;
  size_t offset = 0;
  while (offset < size) {
    ssize_t count = pread(final_fd, buffer + offset, size - offset,
                          start + (off_t)offset);
    if (count <= 0) goto done;
    offset += (size_t)count;
  }
  unsigned char extra;
  if (pread(final_fd, &extra, 1, before.st_size) != 0 ||
      fstat(final_fd, &after) != 0 || !same_stat(&before, &after)) goto done;
  if (tail && start > 0) {
    unsigned char *newline = memchr(buffer, '\n', size);
    if (newline == NULL) goto done;
    size_t prefix = (size_t)(newline - buffer) + 1;
    memmove(buffer, buffer + prefix, size - prefix);
    size -= prefix;
    *truncated = 1;
  }
  *bytes = buffer;
  *length = size;
  buffer = NULL;
  result = SONNER_SAFE_PRESENT;
done:
  free(buffer);
  if (final_fd >= 0) close(final_fd);
  if (current >= 0) close(current);
  return result;
}

enum sonner_safe_result sonner_safe_read_fixed(
    int root_fd, const char *const *components, size_t component_count,
    size_t maximum, unsigned char **bytes, size_t *length) {
  int truncated = 0;
  return sonner_safe_read(root_fd, components, component_count, maximum, 0,
                          bytes, length, &truncated);
}

enum sonner_safe_result sonner_safe_read_tail(
    int root_fd, const char *const *components, size_t component_count,
    size_t maximum, unsigned char **bytes, size_t *length, int *truncated) {
  return sonner_safe_read(root_fd, components, component_count, maximum, 1,
                          bytes, length, truncated);
}
