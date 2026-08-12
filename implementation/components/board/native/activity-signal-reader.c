#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define PROTOCOL_VERSION 2
#define MAX_REQUEST_BYTES (64U * 1024U)
#define MAX_COMPONENT_BYTES 512U
#define MAX_PRIMARY_IDS 256U
#define MAX_SIGNAL_BYTES (256U * 1024U)
#define MAX_SIGNALS 1000U
#define MAX_SNAPSHOT_ENTRIES MAX_SIGNALS
#define MAX_SIGNAL_ENTRIES MAX_SIGNALS
#define MAX_OUTPUT_BYTES (8U * 1024U * 1024U)

#define FRAME_HELLO 1
#define FRAME_SIGNAL 2
#define FRAME_OMISSION 3
#define FRAME_FINAL 4

struct request {
  uint64_t expected_dev;
  uint64_t expected_ino;
  char **primary_ids;
  uint16_t primary_count;
  uint32_t max_signals;
  uint32_t max_signal_bytes;
  uint32_t max_output_bytes;
};

struct names {
  char **items;
  size_t count;
  size_t capacity;
};

struct output_state {
  uint32_t bytes;
  uint32_t signals;
  uint32_t omissions;
  uint32_t max_bytes;
};

static uint16_t read_u16(const unsigned char *value) {
  return (uint16_t)(((uint16_t)value[0] << 8) | value[1]);
}

static uint32_t read_u32(const unsigned char *value) {
  return ((uint32_t)value[0] << 24) | ((uint32_t)value[1] << 16)
    | ((uint32_t)value[2] << 8) | value[3];
}

static uint64_t read_u64(const unsigned char *value) {
  uint64_t result = 0;
  for (size_t index = 0; index < 8; index++) result = (result << 8) | value[index];
  return result;
}

static void write_u16(unsigned char *target, uint16_t value) {
  target[0] = (unsigned char)(value >> 8);
  target[1] = (unsigned char)value;
}

static void write_u32(unsigned char *target, uint32_t value) {
  target[0] = (unsigned char)(value >> 24);
  target[1] = (unsigned char)(value >> 16);
  target[2] = (unsigned char)(value >> 8);
  target[3] = (unsigned char)value;
}

static void write_u64(unsigned char *target, uint64_t value) {
  for (int index = 7; index >= 0; index--) {
    target[index] = (unsigned char)value;
    value >>= 8;
  }
}

static int read_exact(int fd, void *target, size_t length) {
  unsigned char *bytes = target;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(fd, bytes + offset, length - offset);
    if (count == 0) return -1;
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)count;
  }
  return 0;
}

static int write_exact(int fd, const void *source, size_t length) {
  const unsigned char *bytes = source;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)count;
  }
  return 0;
}

static int valid_component(const char *name, size_t length) {
  if (length == 0 || length > MAX_COMPONENT_BYTES) return 0;
  if ((length == 1 && name[0] == '.')
      || (length == 2 && name[0] == '.' && name[1] == '.')) return 0;
  for (size_t index = 0; index < length; index++) {
    if (name[index] == '/' || name[index] == '\0') return 0;
  }
  return 1;
}

static int valid_snapshot(const char *name) {
  size_t length = strlen(name);
  if (length < 40 || length > 64) return 0;
  for (size_t index = 0; index < length; index++) {
    if (!((name[index] >= '0' && name[index] <= '9')
          || (name[index] >= 'a' && name[index] <= 'f'))) return 0;
  }
  return 1;
}

static int valid_signal_name(const char *name) {
  size_t length = strlen(name);
  if (length < 4 || length > MAX_COMPONENT_BYTES || strcmp(name + length - 3, ".md") != 0) return 0;
  int previous_hyphen = 0;
  for (size_t index = 0; index < length - 3; index++) {
    char value = name[index];
    if (!((value >= 'a' && value <= 'z') || (value >= '0' && value <= '9') || value == '-')) return 0;
    if (value == '-') {
      if (index == 0 || previous_hyphen) return 0;
      previous_hyphen = 1;
    } else {
      previous_hyphen = 0;
    }
  }
  return !previous_hyphen;
}

static int is_authorized(const struct request *request, const char *name) {
  size_t low = 0;
  size_t high = request->primary_count;
  while (low < high) {
    size_t middle = low + (high - low) / 2;
    int compared = strcmp(name, request->primary_ids[middle]);
    if (compared == 0) return 1;
    if (compared < 0) high = middle;
    else low = middle + 1;
  }
  return 0;
}

static int compare_names(const void *left, const void *right) {
  return strcmp(*(const char *const *)left, *(const char *const *)right);
}

static int add_name(struct names *names, const char *name, size_t maximum) {
  if (names->count >= maximum) return -1;
  if (names->count == names->capacity) {
    size_t capacity = names->capacity == 0 ? 16 : names->capacity * 2;
    if (capacity > maximum) capacity = maximum;
    char **items = realloc(names->items, capacity * sizeof(char *));
    if (!items) return -1;
    names->items = items;
    names->capacity = capacity;
  }
  names->items[names->count] = strdup(name);
  if (!names->items[names->count]) return -1;
  names->count += 1;
  return 0;
}

static void free_names(struct names *names) {
  for (size_t index = 0; index < names->count; index++) free(names->items[index]);
  free(names->items);
  memset(names, 0, sizeof(*names));
}

static void transition(const char *name);

static int list_names(int directory_fd, struct names *names, int kind, const struct request *request,
    size_t maximum, int *overflow) {
  int duplicate_fd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate_fd < 0) return -1;
  DIR *directory = fdopendir(duplicate_fd);
  if (!directory) {
    close(duplicate_fd);
    return -1;
  }
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    const char *name = entry->d_name;
    size_t length = strlen(name);
    if (!valid_component(name, length)) continue;
    int accepted = kind == 1 ? is_authorized(request, name)
      : kind == 2 ? valid_snapshot(name)
      : valid_signal_name(name);
    if (accepted) {
      if (names->count >= maximum) {
        *overflow = 1;
        break;
      }
      if (add_name(names, name, maximum) != 0) {
        closedir(directory);
        return -1;
      }
      transition(kind == 1 ? "primary-name-retained"
        : kind == 2 ? "snapshot-name-retained" : "signal-name-retained");
    }
  }
  int saved_errno = errno;
  closedir(directory);
  if (saved_errno != 0) return -1;
  qsort(names->items, names->count, sizeof(char *), compare_names);
  return 0;
}

static int open_directory_at(int parent_fd, const char *name) {
  return openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

#ifdef ACTIVITY_SIGNAL_READER_TEST_HOOKS
static void transition(const char *name) {
  const char *raw_fd = getenv("ACTIVITY_SIGNAL_READER_CONTROL_FD");
  if (!raw_fd) return;
  int fd = atoi(raw_fd);
  if (fd < 3 || fcntl(fd, F_GETFD) < 0) return;
  write_exact(fd, name, strlen(name));
  write_exact(fd, "\n", 1);
  unsigned char acknowledged;
  read_exact(fd, &acknowledged, 1);
}
#else
static void transition(const char *name) { (void)name; }
#endif

static int emit_frame(struct output_state *output, const unsigned char *payload, uint32_t length) {
  uint32_t framed = length + 4U;
  if (length > MAX_SIGNAL_BYTES + 4096U || framed > output->max_bytes
      || output->bytes > output->max_bytes - framed) return -1;
  unsigned char prefix[4];
  write_u32(prefix, length);
  if (write_exact(STDOUT_FILENO, prefix, sizeof(prefix)) != 0
      || write_exact(STDOUT_FILENO, payload, length) != 0) return -1;
  output->bytes += framed;
  return 0;
}

static int emit_hello(struct output_state *output) {
  unsigned char payload[] = { FRAME_HELLO, PROTOCOL_VERSION };
  return emit_frame(output, payload, sizeof(payload));
}

static int emit_omission(struct output_state *output, const char *primary, const char *code) {
  size_t primary_length = strlen(primary);
  size_t code_length = strlen(code);
  if (primary_length > UINT16_MAX || code_length > UINT16_MAX) return -1;
  uint32_t length = (uint32_t)(1 + 2 + primary_length + 2 + code_length);
  unsigned char *payload = malloc(length);
  if (!payload) return -1;
  size_t offset = 0;
  payload[offset++] = FRAME_OMISSION;
  write_u16(payload + offset, (uint16_t)primary_length); offset += 2;
  memcpy(payload + offset, primary, primary_length); offset += primary_length;
  write_u16(payload + offset, (uint16_t)code_length); offset += 2;
  memcpy(payload + offset, code, code_length);
  int result = emit_frame(output, payload, length);
  free(payload);
  if (result == 0) output->omissions += 1;
  return result;
}

static int emit_signal(struct output_state *output, const char *primary, const char *snapshot,
    const char *name, const struct stat *status, const unsigned char *raw, uint32_t raw_length) {
  size_t primary_length = strlen(primary);
  size_t snapshot_length = strlen(snapshot);
  size_t name_length = strlen(name);
  if (primary_length > UINT16_MAX || snapshot_length > UINT16_MAX || name_length > UINT16_MAX) return -1;
  uint32_t length = (uint32_t)(1 + 2 + primary_length + 2 + snapshot_length + 2 + name_length
    + 8 + 8 + 8 + 4 + raw_length);
  unsigned char *payload = malloc(length);
  if (!payload) return -1;
  size_t offset = 0;
  payload[offset++] = FRAME_SIGNAL;
  write_u16(payload + offset, (uint16_t)primary_length); offset += 2;
  memcpy(payload + offset, primary, primary_length); offset += primary_length;
  write_u16(payload + offset, (uint16_t)snapshot_length); offset += 2;
  memcpy(payload + offset, snapshot, snapshot_length); offset += snapshot_length;
  write_u16(payload + offset, (uint16_t)name_length); offset += 2;
  memcpy(payload + offset, name, name_length); offset += name_length;
  write_u64(payload + offset, (uint64_t)status->st_size); offset += 8;
  write_u64(payload + offset, (uint64_t)status->st_mtimespec.tv_sec); offset += 8;
  write_u64(payload + offset, (uint64_t)status->st_mtimespec.tv_nsec); offset += 8;
  write_u32(payload + offset, raw_length); offset += 4;
  memcpy(payload + offset, raw, raw_length);
  int result = emit_frame(output, payload, length);
  free(payload);
  if (result == 0) output->signals += 1;
  return result;
}

static int emit_final(struct output_state *output) {
  unsigned char payload[9];
  payload[0] = FRAME_FINAL;
  write_u32(payload + 1, output->signals);
  write_u32(payload + 5, output->omissions);
  return emit_frame(output, payload, sizeof(payload));
}

static int same_file(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino
    && left->st_mode == right->st_mode && left->st_nlink == right->st_nlink
    && left->st_size == right->st_size
    && left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec
    && left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec
    && left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec
    && left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static int inspect_file(int snapshot_fd, const char *primary, const char *snapshot, const char *name,
    const struct request *request, struct output_state *output) {
  transition("before-file-open");
  int file_fd = openat(snapshot_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file_fd < 0) return emit_omission(output, primary,
    errno == ELOOP ? "ACTIVITY_SIGNAL_NON_REGULAR" : "ACTIVITY_SIGNAL_UNREADABLE");
  struct stat first;
  if (fstat(file_fd, &first) != 0) {
    close(file_fd);
    return emit_omission(output, primary, "ACTIVITY_SIGNAL_UNREADABLE");
  }
  if (!S_ISREG(first.st_mode) || first.st_nlink != 1) {
    close(file_fd);
    return emit_omission(output, primary, "ACTIVITY_SIGNAL_NON_REGULAR");
  }
  if (first.st_size < 0 || (uint64_t)first.st_size > request->max_signal_bytes) {
    close(file_fd);
    return emit_omission(output, primary, "ACTIVITY_SIGNAL_OVERSIZED");
  }
  transition("after-file-open");
  size_t size = (size_t)first.st_size;
  unsigned char *raw = malloc(size == 0 ? 1 : size);
  if (!raw) {
    close(file_fd);
    return -1;
  }
  size_t offset = 0;
  int changed = 0;
  while (offset < size) {
    ssize_t count = pread(file_fd, raw + offset, size - offset, (off_t)offset);
    if (count == 0) { changed = 1; break; }
    if (count < 0) {
      if (errno == EINTR) continue;
      free(raw);
      close(file_fd);
      return emit_omission(output, primary, "ACTIVITY_SIGNAL_UNREADABLE");
    }
    offset += (size_t)count;
  }
  transition("after-file-read");
  struct stat final;
  if (fstat(file_fd, &final) != 0) changed = 1;
  else if (!same_file(&first, &final)) changed = 1;
  close(file_fd);
  if (changed) {
    free(raw);
    return emit_omission(output, primary, "ACTIVITY_SIGNAL_CHANGED");
  }
  int result = emit_signal(output, primary, snapshot, name, &first, raw, (uint32_t)size);
  free(raw);
  return result;
}

static int inspect_snapshot(int primary_fd, const char *primary, const char *snapshot,
    const struct request *request, struct output_state *output, uint32_t *encountered, int *bounded) {
  transition("before-snapshot-open");
  int snapshot_fd = open_directory_at(primary_fd, snapshot);
  if (snapshot_fd < 0) return emit_omission(output, primary, "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE");
  struct names files = {0};
  int overflow = 0;
  if (list_names(snapshot_fd, &files, 3, request,
      request->max_signals < MAX_SIGNAL_ENTRIES ? request->max_signals : MAX_SIGNAL_ENTRIES, &overflow) != 0) {
    close(snapshot_fd);
    return emit_omission(output, primary, "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE");
  }
  int result = overflow
    ? emit_omission(output, primary, "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED") : 0;
  for (size_t index = 0; index < files.count && result == 0; index++) {
    *encountered += 1;
    if (*encountered > request->max_signals) {
      if (!*bounded) {
        result = emit_omission(output, primary, "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED");
        *bounded = 1;
      }
      break;
    }
    if (inspect_file(snapshot_fd, primary, snapshot, files.items[index], request, output) != 0) {
      result = -1;
      break;
    }
  }
  if (overflow) *bounded = 1;
  free_names(&files);
  close(snapshot_fd);
  return result;
}

static int inspect_primary(int signals_fd, const char *primary, const struct request *request,
    struct output_state *output, uint32_t *encountered, int *bounded) {
  transition("before-primary-open");
  int primary_fd = open_directory_at(signals_fd, primary);
  if (primary_fd < 0) return emit_omission(output, primary, "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE");
  struct names snapshots = {0};
  int overflow = 0;
  if (list_names(primary_fd, &snapshots, 2, request,
      request->max_signals < MAX_SNAPSHOT_ENTRIES ? request->max_signals : MAX_SNAPSHOT_ENTRIES, &overflow) != 0) {
    close(primary_fd);
    return emit_omission(output, primary, "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE");
  }
  int result = overflow
    ? emit_omission(output, primary, "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED") : 0;
  for (size_t index = 0; index < snapshots.count && !*bounded && result == 0; index++) {
    if (inspect_snapshot(primary_fd, primary, snapshots.items[index], request, output, encountered, bounded) != 0) {
      result = -1;
      break;
    }
  }
  if (overflow) *bounded = 1;
  free_names(&snapshots);
  close(primary_fd);
  return result;
}

static int inspect_tree(int root_fd, const struct request *request, struct output_state *output) {
  int private_fd = open_directory_at(root_fd, ".codex-small-loop");
  if (private_fd < 0) {
    return emit_omission(output, "", "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE");
  }
  transition("after-private-open");
  int signals_fd = open_directory_at(private_fd, "signals");
  if (signals_fd < 0) {
    int missing = errno == ENOENT;
    close(private_fd);
    return missing ? 0 : emit_omission(output, "", "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE");
  }
  struct names primaries = {0};
  int primary_overflow = 0;
  if (list_names(signals_fd, &primaries, 1, request, request->primary_count, &primary_overflow) != 0) {
    close(signals_fd); close(private_fd);
    return emit_omission(output, "", "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE");
  }
  uint32_t encountered = 0;
  int bounded = 0;
  int result = primary_overflow
    ? emit_omission(output, "", "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED") : 0;
  for (size_t index = 0; index < primaries.count && !bounded; index++) {
    if (inspect_primary(signals_fd, primaries.items[index], request, output, &encountered, &bounded) != 0) {
      result = -1;
      break;
    }
  }
  free_names(&primaries);
  close(signals_fd); close(private_fd);
  return result;
}

static void free_request(struct request *request) {
  for (uint16_t index = 0; index < request->primary_count; index++) free(request->primary_ids[index]);
  free(request->primary_ids);
}

static int parse_request(struct request *request) {
  unsigned char prefix[4];
  if (read_exact(STDIN_FILENO, prefix, sizeof(prefix)) != 0) return -1;
  uint32_t length = read_u32(prefix);
  if (length == 0 || length > MAX_REQUEST_BYTES) return -1;
  unsigned char *payload = malloc(length);
  if (!payload) return -1;
  if (read_exact(STDIN_FILENO, payload, length) != 0) { free(payload); return -1; }
  size_t offset = 0;
#define NEED(bytes) do { if ((bytes) > length - offset) { free(payload); return -1; } } while (0)
  NEED(1);
  if (payload[offset++] != PROTOCOL_VERSION) { free(payload); return -1; }
  NEED(16);
  request->expected_dev = read_u64(payload + offset); offset += 8;
  request->expected_ino = read_u64(payload + offset); offset += 8;
  NEED(2);
  request->primary_count = read_u16(payload + offset); offset += 2;
  if (request->primary_count > MAX_PRIMARY_IDS) { free(payload); free_request(request); return -1; }
  request->primary_ids = calloc(request->primary_count, sizeof(char *));
  if (request->primary_count && !request->primary_ids) { free(payload); free_request(request); return -1; }
  for (uint16_t index = 0; index < request->primary_count; index++) {
    NEED(2);
    uint16_t item_length = read_u16(payload + offset); offset += 2;
    NEED(item_length);
    if (!valid_component((const char *)payload + offset, item_length)) { free(payload); free_request(request); return -1; }
    request->primary_ids[index] = malloc((size_t)item_length + 1);
    if (!request->primary_ids[index]) { free(payload); free_request(request); return -1; }
    memcpy(request->primary_ids[index], payload + offset, item_length);
    request->primary_ids[index][item_length] = '\0'; offset += item_length;
    if (index > 0 && strcmp(request->primary_ids[index - 1], request->primary_ids[index]) >= 0) {
      free(payload); free_request(request); return -1;
    }
  }
  NEED(12);
  request->max_signals = read_u32(payload + offset); offset += 4;
  request->max_signal_bytes = read_u32(payload + offset); offset += 4;
  request->max_output_bytes = read_u32(payload + offset); offset += 4;
  if (offset != length || request->max_signals > MAX_SIGNALS
      || request->max_signal_bytes > MAX_SIGNAL_BYTES
      || request->max_output_bytes == 0 || request->max_output_bytes > MAX_OUTPUT_BYTES) {
    free(payload); free_request(request); return -1;
  }
  free(payload);
  return 0;
#undef NEED
}

static int adopt_root_fd(const struct request *request) {
  struct stat status;
  if (fstat(3, &status) != 0 || !S_ISDIR(status.st_mode)
      || (uint64_t)status.st_dev != request->expected_dev
      || (uint64_t)status.st_ino != request->expected_ino) {
    if (fcntl(3, F_GETFD) >= 0) close(3);
    return -1;
  }
  int root_fd = fcntl(3, F_DUPFD_CLOEXEC, 5);
  int saved_errno = errno;
  close(3);
  errno = saved_errno;
  if (root_fd < 0) return -1;
#ifdef ACTIVITY_SIGNAL_READER_TEST_HOOKS
  if ((fcntl(root_fd, F_GETFD) & FD_CLOEXEC) == 0 || fcntl(3, F_GETFD) >= 0) {
    close(root_fd);
    return -1;
  }
  transition("root-fd-owned-cloexec");
#endif
  transition("after-root-adopt");
  return root_fd;
}

int main(void) {
  struct request request = {0};
  if (parse_request(&request) != 0) {
    if (fcntl(3, F_GETFD) >= 0) close(3);
    return 64;
  }
  int root_fd = adopt_root_fd(&request);
  if (root_fd < 0) { free_request(&request); return 64; }
  struct output_state output = { .max_bytes = request.max_output_bytes };
  if (emit_hello(&output) != 0) { close(root_fd); free_request(&request); return 70; }
  int inspected = inspect_tree(root_fd, &request, &output);
  int finalized = inspected == 0 ? emit_final(&output) : -1;
  close(root_fd);
  free_request(&request);
  return finalized == 0 ? 0 : 70;
}
