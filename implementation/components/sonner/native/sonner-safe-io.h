#ifndef SONNER_SAFE_IO_H
#define SONNER_SAFE_IO_H

#include <stddef.h>
#include <stdint.h>

enum sonner_safe_result {
  SONNER_SAFE_PRESENT = 0,
  SONNER_SAFE_MISSING = 1,
  SONNER_SAFE_UNSAFE = 2
};

int sonner_safe_adopt_root(int source_fd, uint64_t expected_dev,
                           uint64_t expected_ino, int *root_fd);
enum sonner_safe_result sonner_safe_read_fixed(
    int root_fd, const char *const *components, size_t component_count,
    size_t maximum, unsigned char **bytes, size_t *length);
enum sonner_safe_result sonner_safe_read_tail(
    int root_fd, const char *const *components, size_t component_count,
    size_t maximum, unsigned char **bytes, size_t *length, int *truncated);

#endif
