#define _DARWIN_C_SOURCE 1
#include <CoreFoundation/CoreFoundation.h>
#include <CoreServices/CoreServices.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define PROTOCOL_VERSION 1
#define MAX_PATH_BYTES 4096
#ifndef O_NOFOLLOW_ANY
#define O_NOFOLLOW_ANY 0x20000000
#endif

enum result { RESULT_OK = 0, RESULT_INVALID = 1, RESULT_CHANGED = 2, RESULT_UNAVAILABLE = 3 };

static int read_exact(int fd, void *target, size_t length) {
  unsigned char *bytes = target; size_t offset = 0;
  while (offset < length) { ssize_t count = read(fd, bytes + offset, length - offset); if (count == 0) return -1; if (count < 0) { if (errno == EINTR) continue; return -1; } offset += (size_t)count; }
  return 0;
}
static int write_exact(int fd, const void *source, size_t length) {
  const unsigned char *bytes = source; size_t offset = 0;
  while (offset < length) { ssize_t count = write(fd, bytes + offset, length - offset); if (count < 0) { if (errno == EINTR) continue; return -1; } offset += (size_t)count; }
  return 0;
}
static uint32_t read_u32(const unsigned char *value) { return ((uint32_t)value[0] << 24) | ((uint32_t)value[1] << 16) | ((uint32_t)value[2] << 8) | value[3]; }
static uint64_t read_u64(const unsigned char *value) { uint64_t result = 0; for (int i = 0; i < 8; i++) result = (result << 8) | value[i]; return result; }
static void write_u32(unsigned char *value, uint32_t number) { value[0]=(number>>24)&255; value[1]=(number>>16)&255; value[2]=(number>>8)&255; value[3]=number&255; }

#ifdef SONNER_OPEN_FILE_TEST_HOOKS
static void transition(const char *name) {
  const char *raw = getenv("SONNER_OPEN_CONTROL_FD"); if (!raw) return; int fd = atoi(raw); if (fd < 3 || fcntl(fd, F_GETFD) < 0) return;
  write_exact(fd, name, strlen(name)); write_exact(fd, "\n", 1); unsigned char ack; read_exact(fd, &ack, 1);
}
#else
static void transition(const char *name) { (void)name; }
#endif

static int emit_result(enum result result) {
  unsigned char output[12]; write_u32(output, 2); output[4]=1; output[5]=PROTOCOL_VERSION; write_u32(output+6, 2); output[10]=2; output[11]=(unsigned char)result;
  return write_exact(STDOUT_FILENO, output, sizeof(output));
}
static int valid_component(const char *value, size_t length) {
  if (length == 0 || length > 512 || (length == 1 && value[0] == '.') || (length == 2 && value[0] == '.' && value[1] == '.')) return 0;
  for (size_t i=0;i<length;i++) if (value[i]=='/' || value[i]=='\0') return 0; return 1;
}
static int valid_path(const char *value, size_t length) {
  if (length == 0 || length > MAX_PATH_BYTES || value[0] == '/') return 0; size_t start=0;
  for (size_t i=0;i<=length;i++) { if (i==length || value[i]=='/') { if (!valid_component(value+start,i-start)) return 0; start=i+1; } else if (value[i]=='\0') return 0; } return 1;
}
static int supported_target(const struct stat *value) { return S_ISREG(value->st_mode) || S_ISDIR(value->st_mode); }
static int same_identity(const struct stat *left, const struct stat *right) {
  return supported_target(left) && supported_target(right)
    && ((S_ISREG(left->st_mode) && S_ISREG(right->st_mode)) || (S_ISDIR(left->st_mode) && S_ISDIR(right->st_mode)))
    && left->st_dev==right->st_dev && left->st_ino==right->st_ino;
}

static enum result open_relative(int root, char *relative, int *final_out, struct stat *final_stat) {
  int directory = fcntl(root, F_DUPFD_CLOEXEC, 5); if (directory < 0) return RESULT_UNAVAILABLE;
  char *cursor=relative;
  while (1) {
    char *slash=strchr(cursor,'/'); if (slash) *slash='\0';
    struct stat inspected; if (fstatat(directory,cursor,&inspected,AT_SYMLINK_NOFOLLOW)<0) { close(directory); return errno==ENOENT?RESULT_CHANGED:RESULT_UNAVAILABLE; }
    if (S_ISLNK(inspected.st_mode)) { close(directory); return RESULT_INVALID; }
    transition(slash ? "before-ancestor-open" : "before-final-open");
    if (slash) {
      if (!S_ISDIR(inspected.st_mode)) { close(directory); return RESULT_INVALID; }
      int next=openat(directory,cursor,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if (next<0) { close(directory); return errno==ELOOP?RESULT_INVALID:RESULT_CHANGED; }
      struct stat opened; if (fstat(next,&opened)<0 || opened.st_dev!=inspected.st_dev || opened.st_ino!=inspected.st_ino || !S_ISDIR(opened.st_mode)) { close(next); close(directory); return RESULT_CHANGED; }
      close(directory); directory=next; *slash='/'; cursor=slash+1;
    } else {
      if (!supported_target(&inspected)) { close(directory); return RESULT_INVALID; }
      int flags=O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(S_ISDIR(inspected.st_mode)?O_DIRECTORY:0);
      int final=openat(directory,cursor,flags); if (final<0) { close(directory); return errno==ELOOP?RESULT_INVALID:RESULT_CHANGED; }
      struct stat opened; if (fstat(final,&opened)<0 || !same_identity(&inspected,&opened) || opened.st_nlink==0) { close(final); close(directory); return RESULT_CHANGED; }
      close(directory); *final_out=final; *final_stat=opened; return RESULT_OK;
    }
  }
}

static enum result reference_for_fd(int final, const struct stat *identity, CFURLRef *reference_out, int *verification_out) {
  transition("after-final-retention");
  char pathname[PATH_MAX]; if (fcntl(final,F_GETPATH,pathname)<0) return RESULT_CHANGED;
  transition("during-reference-creation");
  CFURLRef ordinary=CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault,(const UInt8 *)pathname,(CFIndex)strlen(pathname),S_ISDIR(identity->st_mode)); if (!ordinary) return RESULT_UNAVAILABLE;
  CFErrorRef error=NULL; CFURLRef reference=CFURLCreateFileReferenceURL(kCFAllocatorDefault,ordinary,&error); CFRelease(ordinary); if (error) CFRelease(error);
  if (!reference || !CFURLIsFileReferenceURL(reference)) { if(reference)CFRelease(reference); return RESULT_CHANGED; }
  CFURLRef resolved=CFURLCreateFilePathURL(kCFAllocatorDefault,reference,&error); if (error) CFRelease(error); if (!resolved) { CFRelease(reference); return RESULT_CHANGED; }
  transition("after-reference-resolution");
  UInt8 resolved_path[PATH_MAX]; if (!CFURLGetFileSystemRepresentation(resolved,true,resolved_path,sizeof(resolved_path))) { CFRelease(resolved); CFRelease(reference); return RESULT_CHANGED; }
  CFRelease(resolved);
  int flags=O_RDONLY|O_NOFOLLOW_ANY|O_CLOEXEC|(S_ISDIR(identity->st_mode)?O_DIRECTORY:0);
  int verification=open((const char *)resolved_path,flags); if(verification<0){CFRelease(reference);return RESULT_CHANGED;}
  struct stat verified; if(fstat(verification,&verified)<0 || !same_identity(identity,&verified)){close(verification);CFRelease(reference);return RESULT_CHANGED;}
  transition("after-verification-reopen"); *reference_out=reference; *verification_out=verification; return RESULT_OK;
}

#ifdef SONNER_OPEN_FILE_TEST_HOOKS
static OSStatus launch_reference(CFURLRef reference, const struct stat *identity) {
  if (!CFURLIsFileReferenceURL(reference)) return paramErr; CFErrorRef error=NULL; CFURLRef resolved=CFURLCreateFilePathURL(kCFAllocatorDefault,reference,&error); if(error)CFRelease(error); if(!resolved)return paramErr;
  UInt8 pathname[PATH_MAX]; Boolean ok=CFURLGetFileSystemRepresentation(resolved,true,pathname,sizeof(pathname)); CFRelease(resolved); if(!ok)return paramErr;
  int flags=O_RDONLY|O_NOFOLLOW_ANY|O_CLOEXEC|(S_ISDIR(identity->st_mode)?O_DIRECTORY:0);
  int fd=open((const char *)pathname,flags); if(fd<0)return paramErr; struct stat status; int match=fstat(fd,&status)==0&&same_identity(identity,&status); close(fd); return match?noErr:paramErr;
}
#else
static OSStatus launch_reference(CFURLRef reference, const struct stat *identity) { (void)identity; return LSOpenCFURLRef(reference,NULL); }
#endif

int main(void) {
  unsigned char header[4]; if(read_exact(STDIN_FILENO,header,4)<0)return 2; uint32_t length=read_u32(header); if(length<19||length>19+MAX_PATH_BYTES)return 2;
  unsigned char *request=malloc(length); if(!request||read_exact(STDIN_FILENO,request,length)<0){free(request);return 2;} unsigned char extra; if(read(STDIN_FILENO,&extra,1)!=0){free(request);return 2;}
  if(request[0]!=PROTOCOL_VERSION){free(request);return 2;} uint64_t expected_dev=read_u64(request+1),expected_ino=read_u64(request+9); uint16_t path_length=((uint16_t)request[17]<<8)|request[18];
  if((uint32_t)path_length+19!=length){free(request);return 2;} char *relative=malloc((size_t)path_length+1); if(!relative){free(request);return 2;} memcpy(relative,request+19,path_length);relative[path_length]='\0';free(request);
  if(!valid_path(relative,path_length)){free(relative);emit_result(RESULT_INVALID);return 0;}
  int root=fcntl(3,F_DUPFD_CLOEXEC,5); close(3); if(root<0){free(relative);return 2;} struct stat root_stat; if(fstat(root,&root_stat)<0||!S_ISDIR(root_stat.st_mode)||(uint64_t)root_stat.st_dev!=expected_dev||(uint64_t)root_stat.st_ino!=expected_ino){close(root);free(relative);emit_result(RESULT_CHANGED);return 0;}
  int final=-1,verification=-1; struct stat identity; enum result result=open_relative(root,relative,&final,&identity); free(relative);
  CFURLRef reference=NULL; if(result==RESULT_OK) result=reference_for_fd(final,&identity,&reference,&verification);
  if(result==RESULT_OK){transition("before-launch-services");if(launch_reference(reference,&identity)!=noErr)result=RESULT_UNAVAILABLE;}
  if(reference)CFRelease(reference);if(verification>=0)close(verification);if(final>=0)close(final);close(root);emit_result(result);return 0;
}
