#define _DARWIN_C_SOURCE
#include "sonner-safe-io.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define VERSION 2
#define MAX_TASKS 512
#define MAX_TASK_ID 512
#define MAX_DEPTH 64
#define MAX_ENTRIES 12000
#define MAX_CANDIDATES 1024
#define MAX_PATH 4096
#define MAX_COMPONENT 512
#define MAX_REQUEST (5U * 1024U * 1024U)
#define MAX_TAIL (2U * 1024U * 1024U)
#define MAX_AGGREGATE (256U * 1024U * 1024U)
#define FRAME_HELLO 1
#define FRAME_BEGIN 2
#define FRAME_CHUNK 3
#define FRAME_END 4
#define FRAME_FINAL 5
#define STATUS_ACTIVE 1
#define STATUS_ARCHIVED 2
#define STATUS_MISSING 3
#define STATUS_UNKNOWN 4

struct task { char *id; char *hint[2]; char *path[2]; unsigned count[2]; };
struct node { int fd; char *path; unsigned depth; };

static uint16_t be16(const unsigned char *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t be32(const unsigned char *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static uint64_t be64(const unsigned char *p) { uint64_t v = 0; for (int i=0;i<8;i++) v=(v<<8)|p[i]; return v; }
static int read_exact(int fd, void *buf, size_t n) { size_t o=0; while(o<n){ssize_t c=read(fd,(char*)buf+o,n-o); if(c<=0)return -1;o+=(size_t)c;}return 0; }
static int write_exact(const void *buf, size_t n) { size_t o=0; while(o<n){ssize_t c=write(1,(const char*)buf+o,n-o);if(c<=0)return -1;o+=(size_t)c;}return 0; }
static int frame(const unsigned char *p,uint32_t n){unsigned char h[4]={(unsigned char)(n>>24),(unsigned char)(n>>16),(unsigned char)(n>>8),(unsigned char)n};return write_exact(h,4)||write_exact(p,n)?-1:0;}
static int cmp_names(const void *a,const void *b){return strcmp(*(char *const*)a,*(char *const*)b);}
static int suffix(const char *name,const char *id){size_t n=strlen(name),m=strlen(id);return n>=m+6&&memcmp(name+n-m-6,id,m)==0&&strcmp(name+n-6,".jsonl")==0;}
static int valid_component(const char *name){size_t n=strlen(name);return n>0&&n<=MAX_COMPONENT&&strcmp(name,".")&&strcmp(name,"..");}
static int valid_hint(const char *hint){size_t n=strlen(hint);if(n==0)return 1;if(n>MAX_PATH||hint[0]=='/'||hint[n-1]=='/'||strstr(hint,"//")||strchr(hint,'\\'))return 0;char *copy=strdup(hint);if(!copy)return 0;char *save=NULL;for(char *part=strtok_r(copy,"/",&save);part;part=strtok_r(NULL,"/",&save))if(!valid_component(part)){free(copy);return 0;}free(copy);return 1;}

static int scan_root(int root_fd, struct task *tasks, unsigned task_count,
                     unsigned location, unsigned *visited, unsigned *candidates) {
  struct node *stack = calloc(MAX_ENTRIES + 1, sizeof(*stack));
  if (!stack) return -1;
  size_t size=1; stack[0]=(struct node){fcntl(root_fd,F_DUPFD_CLOEXEC,5),strdup(""),0};
  if(stack[0].fd<0||!stack[0].path){free(stack);return -1;}
  while(size){
    struct node current=stack[--size];
    DIR *dir=fdopendir(dup(current.fd));
    if(!dir){close(current.fd);free(current.path);goto unsafe;}
    char **names=NULL; size_t count=0,capacity=0; struct dirent *entry;
    while((entry=readdir(dir))){
      if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
      if(!valid_component(entry->d_name)||++(*visited)>MAX_ENTRIES){closedir(dir);close(current.fd);free(current.path);goto unsafe_names;}
      if(count==capacity){size_t next=capacity?capacity*2:32;char **grown=realloc(names,next*sizeof(*names));if(!grown){closedir(dir);close(current.fd);free(current.path);goto unsafe_names;}names=grown;capacity=next;}
      names[count]=strdup(entry->d_name);if(!names[count++]){closedir(dir);close(current.fd);free(current.path);goto unsafe_names;}
    }
    closedir(dir);qsort(names,count,sizeof(*names),cmp_names);
    for(size_t reverse=count;reverse>0;reverse--){
      char *name=names[reverse-1];struct stat st;
      if(fstatat(current.fd,name,&st,AT_SYMLINK_NOFOLLOW)!=0){free(name);continue;}
      size_t plen=strlen(current.path),nlen=strlen(name); if(plen+nlen+2>MAX_PATH){free(name);goto unsafe_current;}
      char *relative=malloc(plen+nlen+2);if(!relative){free(name);goto unsafe_current;}
      snprintf(relative,plen+nlen+2,"%s%s%s",current.path,plen?"/":"",name);
      if(S_ISDIR(st.st_mode)){
        if(current.depth>=MAX_DEPTH||size>=MAX_ENTRIES){free(relative);free(name);goto unsafe_current;}
        int child=openat(current.fd,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat opened;
        if(child<0||fstat(child,&opened)!=0||opened.st_dev!=st.st_dev||opened.st_ino!=st.st_ino||!S_ISDIR(opened.st_mode)){if(child>=0)close(child);free(relative);free(name);goto unsafe_current;}
        stack[size++]=(struct node){child,relative,current.depth+1};
      } else if(S_ISREG(st.st_mode)) {
        for(unsigned i=0;i<task_count;i++) if(suffix(name,tasks[i].id)){
          if(++(*candidates)>MAX_CANDIDATES){free(relative);free(name);goto unsafe_current;}
          tasks[i].count[location]++;
          if(tasks[i].count[location]==1) {
            tasks[i].path[location]=strdup(relative);
            if(!tasks[i].path[location]){free(relative);free(name);goto unsafe_current;}
          }
        }
        free(relative);
      } else free(relative);
      free(name); names[reverse-1]=NULL;
    }
    free(names);close(current.fd);free(current.path);continue;
unsafe_current:
    for(size_t i=0;i<count;i++)free(names[i]);free(names);close(current.fd);free(current.path);goto unsafe;
unsafe_names:
    if(names){for(size_t i=0;i<count;i++)free(names[i]);free(names);}goto unsafe;
  }
  free(stack);return 0;
unsafe:
  while(size){close(stack[size-1].fd);free(stack[size-1].path);size--;}
  free(stack);return -1;
}

static enum sonner_safe_result read_relative(int root_fd,const char *relative,unsigned char **bytes,size_t *length,int *truncated){
  char *copy=strdup(relative);if(!copy)return SONNER_SAFE_UNSAFE;const char *parts[MAX_DEPTH+2];size_t count=0;char *save=NULL;
  for(char *token=strtok_r(copy,"/",&save);token;token=strtok_r(NULL,"/",&save)){if(count>=MAX_DEPTH+2){free(copy);return SONNER_SAFE_UNSAFE;}parts[count++]=token;}
  enum sonner_safe_result result=sonner_safe_read_tail(root_fd,parts,count,MAX_TAIL,bytes,length,truncated);free(copy);return result;
}

static unsigned select_task(struct task *task, unsigned *location) {
  if (task->count[0] > 1) return STATUS_UNKNOWN;
  if (task->count[0] == 1) { *location = 0; return STATUS_ACTIVE; }
  if (task->count[1] > 1) return STATUS_UNKNOWN;
  if (task->count[1] == 1) { *location = 1; return STATUS_ARCHIVED; }
  return STATUS_MISSING;
}

static void clear_task_paths(struct task *task) {
  for (unsigned location = 0; location < 2; location++) {
    free(task->path[location]);
    task->path[location] = NULL;
    task->count[location] = 0;
  }
}

static unsigned read_task_with_retry(int roots[2], struct task *task,
                                     unsigned initial_status,
                                     unsigned initial_location,
                                     unsigned char **bytes, size_t *length,
                                     int *truncated) {
  if (initial_status != STATUS_ACTIVE && initial_status != STATUS_ARCHIVED)
    return initial_status;
  if (read_relative(roots[initial_location], task->path[initial_location], bytes,
                    length, truncated) == SONNER_SAFE_PRESENT)
    return initial_status;
  free(*bytes); *bytes = NULL; *length = 0;
  clear_task_paths(task);
  unsigned visited = 0, candidates = 0;
  for (unsigned location = 0; location < 2; location++)
    if (roots[location] >= 0 &&
        scan_root(roots[location], task, 1, location, &visited, &candidates) != 0)
      return STATUS_UNKNOWN;
  unsigned retry_location = 0;
  unsigned retry_status = select_task(task, &retry_location);
  if (retry_status != STATUS_ACTIVE && retry_status != STATUS_ARCHIVED)
    return retry_status;
  if (read_relative(roots[retry_location], task->path[retry_location], bytes,
                    length, truncated) != SONNER_SAFE_PRESENT) {
    free(*bytes); *bytes = NULL; *length = 0;
    return STATUS_UNKNOWN;
  }
  return retry_status;
}

int main(void){
  unsigned char h[4],*req=NULL,extra; if(read_exact(0,h,4)||be32(h)>MAX_REQUEST||(req=malloc(be32(h)))==NULL)return 2;uint32_t n=be32(h);
  if(read_exact(0,req,n)||read(0,&extra,1)!=0||n<39||req[0]!=VERSION){free(req);return 2;}
  size_t o=1;int roots[2]={-1,-1};for(int i=0;i<2;i++){unsigned present=req[o++];uint64_t dev=be64(req+o);o+=8;uint64_t ino=be64(req+o);o+=8;if(present){if(sonner_safe_adopt_root(3+i,dev,ino,&roots[i])){free(req);return 2;}}else{struct stat st;if(fstat(3+i,&st)==0&&S_ISDIR(st.st_mode)){free(req);return 2;}}}
  if(o+2>n){free(req);return 2;}unsigned tc=be16(req+o);o+=2;if(tc>MAX_TASKS){free(req);return 2;}struct task *tasks=calloc(tc?tc:1,sizeof(*tasks));if(!tasks){free(req);return 2;}
  for(unsigned i=0;i<tc;i++){if(o+2>n){free(req);free(tasks);return 2;}unsigned l=be16(req+o);o+=2;if(!l||l>MAX_TASK_ID||o+l>n||memchr(req+o,0,l)){free(req);free(tasks);return 2;}tasks[i].id=calloc(l+1,1);memcpy(tasks[i].id,req+o,l);o+=l;if(strchr(tasks[i].id,'/')||strchr(tasks[i].id,'\\')||(i&&strcmp(tasks[i-1].id,tasks[i].id)>=0)){free(req);free(tasks);return 2;}for(unsigned location=0;location<2;location++){if(o+2>n){free(req);free(tasks);return 2;}unsigned hl=be16(req+o);o+=2;if(hl>MAX_PATH||o+hl>n||(hl&&memchr(req+o,0,hl))){free(req);free(tasks);return 2;}tasks[i].hint[location]=calloc(hl+1,1);if(!tasks[i].hint[location]){free(req);free(tasks);return 2;}memcpy(tasks[i].hint[location],req+o,hl);o+=hl;if(!valid_hint(tasks[i].hint[location])){free(req);free(tasks);return 2;}}}
  if(o!=n){free(req);free(tasks);return 2;}free(req);unsigned visited=0,candidates=0;int scan_bad=0;for(int i=0;i<2;i++)if(roots[i]>=0&&scan_root(roots[i],tasks,tc,(unsigned)i,&visited,&candidates))scan_bad=1;
  unsigned char hello[2]={FRAME_HELLO,VERSION};if(frame(hello,2))return 3;uint64_t aggregate=0;
  for(unsigned i=0;i<tc;i++){
    unsigned location=0;unsigned status=scan_bad?STATUS_UNKNOWN:select_task(&tasks[i],&location);if((status==STATUS_ACTIVE||status==STATUS_ARCHIVED)&&tasks[i].hint[location][0]&&strcmp(tasks[i].hint[location],tasks[i].path[location])==0){free(tasks[i].path[location]);tasks[i].path[location]=strdup(tasks[i].hint[location]);if(!tasks[i].path[location])status=STATUS_UNKNOWN;}
    unsigned char *bytes=NULL;size_t length=0;int truncated=0;if(status==STATUS_ACTIVE||status==STATUS_ARCHIVED){status=read_task_with_retry(roots,&tasks[i],status,location,&bytes,&length,&truncated);if((status==STATUS_ACTIVE||status==STATUS_ARCHIVED)&&aggregate+length<=MAX_AGGREGATE)aggregate+=length;else{free(bytes);bytes=NULL;length=0;truncated=0;if(status==STATUS_ACTIVE||status==STATUS_ARCHIVED)status=STATUS_UNKNOWN;}}
    unsigned char begin[5]={FRAME_BEGIN,(unsigned char)(i>>8),(unsigned char)i,(unsigned char)status,(unsigned char)truncated};if(frame(begin,5))return 3;
    for(size_t p=0;p<length;){uint32_t chunk=(uint32_t)((length-p)>65536?65536:(length-p));unsigned char *payload=malloc(chunk+7);payload[0]=FRAME_CHUNK;payload[1]=(unsigned char)(i>>8);payload[2]=(unsigned char)i;payload[3]=(unsigned char)(chunk>>24);payload[4]=(unsigned char)(chunk>>16);payload[5]=(unsigned char)(chunk>>8);payload[6]=(unsigned char)chunk;memcpy(payload+7,bytes+p,chunk);if(frame(payload,chunk+7)){free(payload);return 3;}free(payload);p+=chunk;}
    free(bytes);unsigned char end[3]={FRAME_END,(unsigned char)(i>>8),(unsigned char)i};if(frame(end,3))return 3;
  }
  unsigned char final[3]={FRAME_FINAL,(unsigned char)(tc>>8),(unsigned char)tc};int result=frame(final,3);
  for(unsigned i=0;i<tc;i++){free(tasks[i].id);free(tasks[i].hint[0]);free(tasks[i].hint[1]);free(tasks[i].path[0]);free(tasks[i].path[1]);}free(tasks);for(int i=0;i<2;i++)if(roots[i]>=0)close(roots[i]);return result?3:0;
}
