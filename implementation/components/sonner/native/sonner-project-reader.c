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

#define PROTOCOL_VERSION 3
#define MAX_REQUEST_BYTES (8U * 1024U * 1024U)
#define MAX_PATHS 100000U
#define MAX_PATH_BYTES 4096U
#define MAX_COMPONENT_BYTES 512U
#define MAX_WORKS 1024U
#define MAX_WORK_BYTES (256U * 1024U)
#define MAX_OUTPUT_BYTES (16U * 1024U * 1024U)
#define MAX_GIT_OUTPUT_BYTES (32U * 1024U * 1024U)
#define MAX_DIRECTORY_ENTRIES 100000U

#define FRAME_HELLO 1
#define FRAME_PATH 2
#define FRAME_WORK 3
#define FRAME_WORK_UNSAFE 4
#define FRAME_FINAL 5
#define FRAME_LEGACY_WORK 6
#define TYPE_FILE 1
#define TYPE_SYMLINK 2

struct path_request { char *path; uint32_t max_bytes; };
struct request {
  uint64_t expected_dev;
  uint64_t expected_ino;
  struct path_request *paths;
  uint32_t path_count;
  uint32_t max_works;
  uint32_t max_work_bytes;
  uint32_t max_output_bytes;
};
struct strings { char **items; size_t count; size_t capacity; };
struct output_state {
  uint32_t bytes;
  uint32_t paths;
  uint32_t works;
  uint32_t legacy_works;
  uint32_t max_bytes;
  int work_unsafe;
};
struct git_request {
  uint64_t expected_dev;
  uint64_t expected_ino;
  uint32_t max_output_bytes;
  uint32_t max_paths;
};
extern char **environ;

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
  target[0] = (unsigned char)(value >> 8); target[1] = (unsigned char)value;
}
static void write_u32(unsigned char *target, uint32_t value) {
  target[0] = (unsigned char)(value >> 24); target[1] = (unsigned char)(value >> 16);
  target[2] = (unsigned char)(value >> 8); target[3] = (unsigned char)value;
}
static int read_exact(int fd, void *target, size_t length) {
  unsigned char *bytes = target; size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(fd, bytes + offset, length - offset);
    if (count == 0) return -1;
    if (count < 0) { if (errno == EINTR) continue; return -1; }
    offset += (size_t)count;
  }
  return 0;
}
static int write_exact(int fd, const void *source, size_t length) {
  const unsigned char *bytes = source; size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0) { if (errno == EINTR) continue; return -1; }
    offset += (size_t)count;
  }
  return 0;
}
static int valid_component(const char *value, size_t length) {
  if (length == 0 || length > MAX_COMPONENT_BYTES) return 0;
  if ((length == 1 && value[0] == '.') || (length == 2 && value[0] == '.' && value[1] == '.')) return 0;
  for (size_t index = 0; index < length; index++) if (value[index] == '/' || value[index] == '\0') return 0;
  return 1;
}
static int valid_path(const char *value, size_t length) {
  if (length == 0 || length > MAX_PATH_BYTES || value[0] == '/') return 0;
  size_t start = 0;
  for (size_t index = 0; index <= length; index++) {
    if (index == length || value[index] == '/') {
      if (!valid_component(value + start, index - start)) return 0;
      start = index + 1;
    } else if (value[index] == '\0') return 0;
  }
  return 1;
}
static int compare_strings(const void *left, const void *right) {
  return strcmp(*(const char *const *)left, *(const char *const *)right);
}
static int add_string(struct strings *values, const char *value, size_t maximum) {
  if (values->count >= maximum) return -1;
  if (values->count == values->capacity) {
    size_t capacity = values->capacity == 0 ? 16 : values->capacity * 2;
    if (capacity > maximum) capacity = maximum;
    char **items = realloc(values->items, capacity * sizeof(char *));
    if (!items) return -1;
    values->items = items; values->capacity = capacity;
  }
  values->items[values->count] = strdup(value);
  if (!values->items[values->count]) return -1;
  values->count += 1;
  return 0;
}
static void free_strings(struct strings *values) {
  for (size_t index = 0; index < values->count; index++) free(values->items[index]);
  free(values->items); memset(values, 0, sizeof(*values));
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

#ifdef SONNER_PROJECT_READER_TEST_HOOKS
static void transition(const char *name, const char *project_path) {
  const char *raw_fd = getenv("SONNER_PROJECT_READER_CONTROL_FD");
  if (!raw_fd) return;
  int fd = atoi(raw_fd);
  if (fd < 3 || fcntl(fd, F_GETFD) < 0) return;
  write_exact(fd, name, strlen(name));
  if (project_path && project_path[0]) { write_exact(fd, ":", 1); write_exact(fd, project_path, strlen(project_path)); }
  write_exact(fd, "\n", 1);
  unsigned char acknowledged;
  read_exact(fd, &acknowledged, 1);
}
#else
static void transition(const char *name, const char *project_path) { (void)name; (void)project_path; }
#endif

static int emit_frame(struct output_state *output, const unsigned char *payload, uint32_t length) {
  uint32_t framed = length + 4U;
  if (length == 0 || framed > output->max_bytes || output->bytes > output->max_bytes - framed) return -1;
  unsigned char prefix[4]; write_u32(prefix, length);
  if (write_exact(STDOUT_FILENO, prefix, 4) != 0 || write_exact(STDOUT_FILENO, payload, length) != 0) return -1;
  output->bytes += framed; return 0;
}
static int emit_hello(struct output_state *output) {
  unsigned char payload[] = { FRAME_HELLO, PROTOCOL_VERSION };
  return emit_frame(output, payload, sizeof(payload));
}
static int emit_path(struct output_state *output, const char *project_path, unsigned char kind,
    const unsigned char *raw, uint32_t raw_length) {
  size_t path_length = strlen(project_path);
  if (path_length > UINT16_MAX) return -1;
  uint32_t length = (uint32_t)(1 + 1 + 2 + path_length + 4 + raw_length);
  unsigned char *payload = malloc(length); if (!payload) return -1;
  size_t offset = 0; payload[offset++] = FRAME_PATH; payload[offset++] = kind;
  write_u16(payload + offset, (uint16_t)path_length); offset += 2;
  memcpy(payload + offset, project_path, path_length); offset += path_length;
  write_u32(payload + offset, raw_length); offset += 4;
  if (raw_length) memcpy(payload + offset, raw, raw_length);
  int result = emit_frame(output, payload, length); free(payload);
  if (result == 0) output->paths += 1;
  return result;
}
static int emit_work(struct output_state *output, const char *project_path,
    const unsigned char *raw, uint32_t raw_length) {
  size_t path_length = strlen(project_path);
  if (path_length > UINT16_MAX) return -1;
  uint32_t length = (uint32_t)(1 + 2 + path_length + 4 + raw_length);
  unsigned char *payload = malloc(length); if (!payload) return -1;
  size_t offset = 0; payload[offset++] = FRAME_WORK;
  write_u16(payload + offset, (uint16_t)path_length); offset += 2;
  memcpy(payload + offset, project_path, path_length); offset += path_length;
  write_u32(payload + offset, raw_length); offset += 4; memcpy(payload + offset, raw, raw_length);
  int result = emit_frame(output, payload, length); free(payload);
  if (result == 0) output->works += 1;
  return result;
}
static int emit_legacy_work(struct output_state *output, const char *project_path) {
  size_t path_length = strlen(project_path);
  if (path_length > UINT16_MAX) return -1;
  uint32_t length = (uint32_t)(1 + 2 + path_length);
  unsigned char *payload = malloc(length); if (!payload) return -1;
  size_t offset = 0; payload[offset++] = FRAME_LEGACY_WORK;
  write_u16(payload + offset, (uint16_t)path_length); offset += 2;
  memcpy(payload + offset, project_path, path_length);
  int result = emit_frame(output, payload, length); free(payload);
  if (result == 0) output->legacy_works += 1;
  return result;
}
static int emit_final(struct output_state *output) {
  if (output->work_unsafe) {
    unsigned char unsafe[] = { FRAME_WORK_UNSAFE };
    if (emit_frame(output, unsafe, sizeof(unsafe)) != 0) return -1;
  }
  unsigned char payload[14]; payload[0] = FRAME_FINAL;
  write_u32(payload + 1, output->paths); write_u32(payload + 5, output->works);
  write_u32(payload + 9, output->legacy_works);
  payload[13] = output->work_unsafe ? 1 : 0;
  return emit_frame(output, payload, sizeof(payload));
}

static int ignored_directory(const char *name) {
  static const char *ignored[] = { ".git", ".codex-small-loop", "coverage", "dist", "node_modules" };
  for (size_t index = 0; index < sizeof(ignored) / sizeof(ignored[0]); index++) if (strcmp(name, ignored[index]) == 0) return 1;
  return 0;
}
static int join_path(char *target, size_t capacity, const char *parent, const char *name) {
  int count = parent[0] ? snprintf(target, capacity, "%s/%s", parent, name) : snprintf(target, capacity, "%s", name);
  return count >= 0 && (size_t)count < capacity ? 0 : -1;
}
static int list_directory_names(int directory_fd, struct strings *names) {
  int duplicate = fcntl(directory_fd, F_DUPFD_CLOEXEC, 5); if (duplicate < 0) return -1;
  DIR *directory = fdopendir(duplicate); if (!directory) { close(duplicate); return -1; }
  errno = 0; struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    size_t length = strlen(entry->d_name);
    if (!valid_component(entry->d_name, length)) continue;
    if (add_string(names, entry->d_name, MAX_DIRECTORY_ENTRIES) != 0) { closedir(directory); return -1; }
  }
  int saved = errno; closedir(directory); if (saved != 0) return -1;
  qsort(names->items, names->count, sizeof(char *), compare_strings); return 0;
}
static int discover_works(int directory_fd, const char *relative, const struct request *request,
    struct strings *works, struct strings *legacy_works, int *unsafe) {
  struct strings names = {0};
  if (list_directory_names(directory_fd, &names) != 0) { *unsafe = 1; return 0; }
  for (size_t index = 0; index < names.count; index++) {
    const char *name = names.items[index];
    if (ignored_directory(name)) continue;
    char project_path[MAX_PATH_BYTES + 1];
    if (join_path(project_path, sizeof(project_path), relative, name) != 0) { *unsafe = 1; continue; }
    struct stat before;
    if (fstatat(directory_fd, name, &before, AT_SYMLINK_NOFOLLOW) != 0) { *unsafe = 1; continue; }
    if (S_ISDIR(before.st_mode)) {
      transition("before-work-directory-open", project_path);
      int child = openat(directory_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      struct stat opened;
      if (child < 0 || fstat(child, &opened) != 0 || !same_file(&before, &opened)) {
        if (child >= 0) close(child); *unsafe = 1; continue;
      }
      if (discover_works(child, project_path, request, works, legacy_works, unsafe) != 0) { close(child); free_strings(&names); return -1; }
      close(child);
    } else if (strcmp(name, ".WORK_NODE.xml") == 0) {
      if (!S_ISREG(before.st_mode) || add_string(works, project_path, request->max_works) != 0) *unsafe = 1;
    } else if (strcmp(name, "WORK_NODE.xml") == 0) {
      if (add_string(legacy_works, project_path, request->max_works) != 0) *unsafe = 1;
    }
  }
  free_strings(&names); return 0;
}

static int open_parent(int root_fd, const char *project_path, const char *prefix,
    int *parent_fd, char final_name[MAX_COMPONENT_BYTES + 1]) {
  char copy[MAX_PATH_BYTES + 1]; size_t length = strlen(project_path);
  if (!valid_path(project_path, length)) return -1;
  memcpy(copy, project_path, length + 1);
  int current = fcntl(root_fd, F_DUPFD_CLOEXEC, 5); if (current < 0) return -1;
  char walked[MAX_PATH_BYTES + 1] = "";
  char *save = NULL; char *component = strtok_r(copy, "/", &save); char *next = strtok_r(NULL, "/", &save);
  while (next) {
    char component_path[MAX_PATH_BYTES + 1];
    if (join_path(component_path, sizeof(component_path), walked, component) != 0) { close(current); return -1; }
    struct stat before;
    if (fstatat(current, component, &before, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(before.st_mode)) { close(current); return -1; }
    transition(prefix, component_path);
    int child = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat opened;
    if (child < 0 || fstat(child, &opened) != 0 || !same_file(&before, &opened)) {
      if (child >= 0) close(child); close(current); return -1;
    }
    close(current); current = child; strcpy(walked, component_path);
    component = next; next = strtok_r(NULL, "/", &save);
  }
  if (!component || strlen(component) > MAX_COMPONENT_BYTES) { close(current); return -1; }
  strcpy(final_name, component); *parent_fd = current; return 0;
}

static int read_stable_file(int parent_fd, const char *name, const char *project_path,
    const char *before_transition, const char *after_open_transition, const char *after_read_transition,
    uint32_t maximum, int require_complete, unsigned char **raw_out, uint32_t *length_out) {
  struct stat inspected;
  if (fstatat(parent_fd, name, &inspected, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(inspected.st_mode)) return -1;
  transition(before_transition, project_path);
  int file = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat first;
  if (file < 0 || fstat(file, &first) != 0 || !same_file(&inspected, &first) || !S_ISREG(first.st_mode) || first.st_size < 0) {
    if (file >= 0) close(file); return -1;
  }
  if (require_complete && (uint64_t)first.st_size > maximum) { close(file); return -1; }
  transition(after_open_transition, project_path);
  uint64_t desired64 = (uint64_t)first.st_size;
  if (desired64 > maximum) desired64 = maximum;
  uint32_t desired = (uint32_t)desired64;
  unsigned char *raw = malloc(desired == 0 ? 1 : desired); if (!raw) { close(file); return -1; }
  size_t offset = 0;
  while (offset < desired) {
    ssize_t count = pread(file, raw + offset, desired - offset, (off_t)offset);
    if (count == 0) { free(raw); close(file); return -1; }
    if (count < 0) { if (errno == EINTR) continue; free(raw); close(file); return -1; }
    offset += (size_t)count;
  }
  transition(after_read_transition, project_path);
  struct stat final; int changed = fstat(file, &final) != 0 || !same_file(&first, &final);
  close(file);
  if (changed) { free(raw); return -1; }
  *raw_out = raw; *length_out = desired; return 0;
}

static int inspect_requested_path(int root_fd, const struct path_request *entry, struct output_state *output) {
  int parent; char name[MAX_COMPONENT_BYTES + 1];
  if (open_parent(root_fd, entry->path, "before-path-ancestor-open", &parent, name) != 0) return 0;
  struct stat inspected;
  if (fstatat(parent, name, &inspected, AT_SYMLINK_NOFOLLOW) != 0) { close(parent); return 0; }
  if (S_ISLNK(inspected.st_mode)) {
    int result = emit_path(output, entry->path, TYPE_SYMLINK, NULL, 0); close(parent); return result;
  }
  unsigned char *raw = NULL; uint32_t length = 0;
  int readable = read_stable_file(parent, name, entry->path, "before-path-open", "after-path-open", "after-path-read",
    entry->max_bytes, 0, &raw, &length);
  close(parent); if (readable != 0) return 0;
  int result = emit_path(output, entry->path, TYPE_FILE, raw, length); free(raw); return result;
}
static int inspect_work(int root_fd, const char *project_path, const struct request *request,
    struct output_state *output) {
  int parent; char name[MAX_COMPONENT_BYTES + 1];
  if (open_parent(root_fd, project_path, "before-work-ancestor-open", &parent, name) != 0) { output->work_unsafe = 1; return 0; }
  unsigned char *raw = NULL; uint32_t length = 0;
  int readable = read_stable_file(parent, name, project_path, "before-work-open", "after-work-open", "after-work-read",
    request->max_work_bytes, 1, &raw, &length);
  close(parent);
  if (readable != 0) { output->work_unsafe = 1; return 0; }
  int result = emit_work(output, project_path, raw, length); free(raw); return result;
}

static void free_request(struct request *request) {
  for (uint32_t index = 0; index < request->path_count; index++) free(request->paths[index].path);
  free(request->paths);
}
static int parse_request(struct request *request) {
  unsigned char prefix[4]; if (read_exact(STDIN_FILENO, prefix, 4) != 0) return -1;
  uint32_t length = read_u32(prefix); if (length == 0 || length > MAX_REQUEST_BYTES) return -1;
  unsigned char *payload = malloc(length); if (!payload) return -1;
  if (read_exact(STDIN_FILENO, payload, length) != 0) { free(payload); return -1; }
  size_t offset = 0;
#define NEED(bytes) do { if ((bytes) > length - offset) { free(payload); free_request(request); return -1; } } while (0)
  NEED(17); if (payload[offset++] != PROTOCOL_VERSION) { free(payload); return -1; }
  request->expected_dev = read_u64(payload + offset); offset += 8;
  request->expected_ino = read_u64(payload + offset); offset += 8;
  NEED(4); request->path_count = read_u32(payload + offset); offset += 4;
  if (request->path_count > MAX_PATHS) { free(payload); return -1; }
  request->paths = calloc(request->path_count, sizeof(struct path_request));
  if (request->path_count && !request->paths) { free(payload); return -1; }
  for (uint32_t index = 0; index < request->path_count; index++) {
    NEED(2); uint16_t item_length = read_u16(payload + offset); offset += 2; NEED((size_t)item_length + 4);
    if (!valid_path((const char *)payload + offset, item_length)) { free(payload); free_request(request); return -1; }
    request->paths[index].path = malloc((size_t)item_length + 1);
    if (!request->paths[index].path) { free(payload); free_request(request); return -1; }
    memcpy(request->paths[index].path, payload + offset, item_length); request->paths[index].path[item_length] = '\0'; offset += item_length;
    request->paths[index].max_bytes = read_u32(payload + offset); offset += 4;
    if (request->paths[index].max_bytes > 64U * 1024U
        || (index > 0 && strcmp(request->paths[index - 1].path, request->paths[index].path) >= 0)) {
      free(payload); free_request(request); return -1;
    }
  }
  NEED(12); request->max_works = read_u32(payload + offset); offset += 4;
  request->max_work_bytes = read_u32(payload + offset); offset += 4;
  request->max_output_bytes = read_u32(payload + offset); offset += 4;
  if (offset != length || request->max_works > MAX_WORKS || request->max_work_bytes > MAX_WORK_BYTES
      || request->max_output_bytes == 0 || request->max_output_bytes > MAX_OUTPUT_BYTES) {
    free(payload); free_request(request); return -1;
  }
  free(payload); unsigned char extra; if (read(STDIN_FILENO, &extra, 1) != 0) { free_request(request); return -1; }
  return 0;
#undef NEED
}
static int adopt_root_fd(const struct request *request) {
  struct stat status;
  if (fstat(3, &status) != 0 || !S_ISDIR(status.st_mode)
      || (uint64_t)status.st_dev != request->expected_dev || (uint64_t)status.st_ino != request->expected_ino) {
    if (fcntl(3, F_GETFD) >= 0) close(3); return -1;
  }
  int root = fcntl(3, F_DUPFD_CLOEXEC, 5); int saved = errno; close(3); errno = saved;
  if (root < 0) return -1;
  transition("after-root-adopt", ""); return root;
}
static int parse_git_request(struct git_request *request) {
  unsigned char prefix[4]; if (read_exact(STDIN_FILENO, prefix, 4) != 0) return -1;
  uint32_t length = read_u32(prefix); if (length != 25) return -1;
  unsigned char payload[25]; if (read_exact(STDIN_FILENO, payload, sizeof(payload)) != 0) return -1;
  if (payload[0] != PROTOCOL_VERSION) return -1;
  request->expected_dev = read_u64(payload + 1);
  request->expected_ino = read_u64(payload + 9);
  request->max_output_bytes = read_u32(payload + 17);
  request->max_paths = read_u32(payload + 21);
  if (request->max_output_bytes == 0 || request->max_output_bytes > MAX_GIT_OUTPUT_BYTES
      || request->max_paths > MAX_PATHS) return -1;
  unsigned char extra; return read(STDIN_FILENO, &extra, 1) == 0 ? 0 : -1;
}
static int run_git_mode(void) {
  struct git_request git = {0};
  if (parse_git_request(&git) != 0) { if (fcntl(3, F_GETFD) >= 0) close(3); return 64; }
  struct request identity = { .expected_dev = git.expected_dev, .expected_ino = git.expected_ino };
  int root = adopt_root_fd(&identity); if (root < 0) return 64;
  transition("before-git-exec", "");
  const char *control = getenv("SONNER_PROJECT_READER_CONTROL_FD");
  if (control) { int control_fd = atoi(control); if (control_fd >= 4) close(control_fd); }
  if (fchdir(root) != 0) { close(root); return 70; }
  close(root);
  char *const arguments[] = {
    "/usr/bin/git", "--no-pager", "--no-optional-locks", "--work-tree=.",
    "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others",
    "--deduplicate", "--exclude-standard", "-z", "--", NULL,
  };
  execve("/usr/bin/git", arguments, environ);
  return 70;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "git-ls-files") == 0) return run_git_mode();
  if (argc != 1) { if (fcntl(3, F_GETFD) >= 0) close(3); return 64; }
  struct request request = {0};
  if (parse_request(&request) != 0) { if (fcntl(3, F_GETFD) >= 0) close(3); return 64; }
  int root = adopt_root_fd(&request); if (root < 0) { free_request(&request); return 64; }
  struct output_state output = { .max_bytes = request.max_output_bytes };
  if (emit_hello(&output) != 0) { close(root); free_request(&request); return 70; }
  int result = 0;
  for (uint32_t index = 0; index < request.path_count && result == 0; index++) result = inspect_requested_path(root, &request.paths[index], &output);
  struct strings works = {0}; struct strings legacy_works = {0}; int unsafe = 0;
  if (result == 0 && discover_works(root, "", &request, &works, &legacy_works, &unsafe) != 0) result = -1;
  qsort(works.items, works.count, sizeof(char *), compare_strings);
  qsort(legacy_works.items, legacy_works.count, sizeof(char *), compare_strings);
  output.work_unsafe = unsafe;
  for (size_t index = 0; index < works.count && result == 0; index++) result = inspect_work(root, works.items[index], &request, &output);
  for (size_t index = 0; index < legacy_works.count && result == 0; index++) result = emit_legacy_work(&output, legacy_works.items[index]);
  if (result == 0) result = emit_final(&output);
  free_strings(&works); free_strings(&legacy_works); close(root); free_request(&request);
  return result == 0 ? 0 : 70;
}
