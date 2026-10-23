/* Bounded Linux amd64 diagnostic for CVE-2019-1010024/1010025.
   This reports observed addresses and checks public pthread/malloc semantics.
   A finite sample does not establish ASLR entropy or universal CVE closure.
   Build with the final candidate libc's headers/compiler, then launch under
   its matching loader.  No tunable is changed after libc initialization. */
#define _GNU_SOURCE 1
#include <errno.h>
#include <inttypes.h>
#include <malloc.h>
#include <pthread.h>
#include <stdint.h>
#include <stdatomic.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { SAMPLES = 64, STACK_BYTES = 256 * 1024, PAYLOAD_BYTES = 16384 };
struct observation
{
  uintptr_t stack_base;
  size_t stack_size;
  uintptr_t local_address;
  uintptr_t heap_address;
  void *retained;
  int error;
};
static unsigned char payload (size_t i)
{
  return (unsigned char) (i * 37 + 19);
}
static void *observe (void *argument)
{
  struct observation *out = argument;
  volatile unsigned char marker = 0x51;
  pthread_attr_t actual;
  void *base;
  size_t bytes;
  int r = pthread_getattr_np (pthread_self (), &actual);
  if (r != 0) { out->error = r; return NULL; }
  r = pthread_attr_getstack (&actual, &base, &bytes);
  pthread_attr_destroy (&actual);
  if (r != 0) { out->error = r; return NULL; }
  out->stack_base = (uintptr_t) base;
  out->stack_size = bytes;
  out->local_address = (uintptr_t) &marker;
  if (out->local_address < out->stack_base
      || out->local_address - out->stack_base >= bytes)
    { out->error = EFAULT; return NULL; }
  unsigned char *p = malloc (PAYLOAD_BYTES);
  if (p == NULL) { out->error = ENOMEM; return NULL; }
  for (size_t i = 0; i < PAYLOAD_BYTES; ++i)
    p[i] = payload (i);
  out->heap_address = (uintptr_t) p;
  out->retained = p;
  return NULL;
}
static size_t distinct (const struct observation *samples, int stack)
{
  size_t count = 0;
  for (size_t i = 0; i < SAMPLES; ++i)
    {
      uintptr_t value = stack ? samples[i].stack_base : samples[i].heap_address;
      size_t j;
      for (j = 0; j < i; ++j)
        if (value == (stack ? samples[j].stack_base : samples[j].heap_address))
          break;
      count += j == i;
    }
  return count;
}

/* No-cache behavior must be measured while the freeing thread is still alive:
   otherwise its tcache would drain on exit even in an unpatched binary. */
enum { CACHE_CHUNKS = 64, CONCURRENT_THREADS = 12, LIVE_CHUNKS = 32 };
static pthread_barrier_t cache_phase;
static int cache_worker_error;
static void *cache_probe_worker (void *unused)
{
  (void) unused;
  void *chunks[CACHE_CHUNKS];
  for (size_t i = 0; i < CACHE_CHUNKS; ++i)
    {
      chunks[i] = malloc (64);
      if (chunks[i] == NULL) cache_worker_error = ENOMEM;
    }
  pthread_barrier_wait (&cache_phase);
  pthread_barrier_wait (&cache_phase);
  for (size_t i = 0; i < CACHE_CHUNKS; ++i)
    free (chunks[i]);
  pthread_barrier_wait (&cache_phase);
  pthread_barrier_wait (&cache_phase);
  return NULL;
}
static int check_no_tcache (void)
{
  if (mallopt (M_MXFAST, 0) != 1 || mallopt (M_MXFAST, 80) != 1)
    return 2;
  if (pthread_barrier_init (&cache_phase, NULL, 2) != 0) return 2;
  pthread_t worker;
  if (pthread_create (&worker, NULL, cache_probe_worker, NULL) != 0) return 2;
  pthread_barrier_wait (&cache_phase);
  struct mallinfo2 before = mallinfo2 ();
  pthread_barrier_wait (&cache_phase);
  pthread_barrier_wait (&cache_phase);
  struct mallinfo2 after = mallinfo2 ();
  pthread_barrier_wait (&cache_phase);
  if (pthread_join (worker, NULL) != 0) return 2;
  pthread_barrier_destroy (&cache_phase);
  if (cache_worker_error != 0) return 2;
  printf ("tcache_probe chunks=%d fastbin_before=%zu fastbin_after=%zu\n",
          CACHE_CHUNKS, before.smblks, after.smblks);
  if (after.smblks < before.smblks
      || after.smblks - before.smblks < CACHE_CHUNKS)
    {
      fprintf (stderr, "per-thread cache exclusion failed\n");
      return 1;
    }
  return 0;
}

static pthread_barrier_t allocation_phase;
static _Atomic int stop_churn;
static _Atomic int allocation_error;
static void *churn_worker (void *unused)
{
  (void) unused;
  void *chunks[LIVE_CHUNKS] = { 0 };
  for (size_t i = 0; i < LIVE_CHUNKS; ++i)
    {
      chunks[i] = calloc (1, 96 + i * 32);
      if (chunks[i] == NULL) atomic_store (&allocation_error, ENOMEM);
    }
  pthread_barrier_wait (&allocation_phase);
  pthread_barrier_wait (&allocation_phase);
  do
    {
      for (size_t i = 0; i < LIVE_CHUNKS; ++i)
        {
          void *p = realloc (chunks[i], 160 + i * 32);
          if (p == NULL)
            atomic_store (&allocation_error, ENOMEM);
          else
            { chunks[i] = p; memset (p, 0x5a, 160 + i * 32); }
        }
      void *aligned = NULL;
      int r = posix_memalign (&aligned, 4096, 8192);
      if (r != 0)
        atomic_store (&allocation_error, r);
      else
        {
          if (((uintptr_t) aligned & 4095) != 0)
            atomic_store (&allocation_error, EFAULT);
          memset (aligned, 0xa5, 8192);
          free (aligned);
        }
    }
  while (!atomic_load (&stop_churn));
  for (size_t i = 0; i < LIVE_CHUNKS; ++i) free (chunks[i]);
  return NULL;
}
static int arena_count (void)
{
  char buffer[16384];
  char line[512];
  FILE *stream = tmpfile ();
  if (stream == NULL) return -1;
  if (setvbuf (stream, buffer, _IOFBF, sizeof (buffer)) != 0
      || malloc_info (0, stream) != 0
      || fflush (stream) != 0
      || fseek (stream, 0, SEEK_SET) != 0)
    { fclose (stream); return -1; }
  int count = 0;
  while (fgets (line, sizeof (line), stream) != NULL)
    if (strstr (line, "<heap nr=") != NULL) ++count;
  int error = ferror (stream);
  fclose (stream);
  return error ? -1 : count;
}
static int child_allocation_control (void)
{
  unsigned char *p = calloc (128, 1);
  if (p == NULL) return 1;
  for (size_t i = 0; i < 128; ++i)
    if (p[i] != 0) { free (p); return 1; }
  p[31] = 0x93;
  unsigned char *q = realloc (p, 8192);
  if (q == NULL) { free (p); return 1; }
  if (q[31] != 0x93) { free (q); return 1; }
  free (q);
  return arena_count () == 1 ? 0 : 1;
}
static int check_concurrency_and_fork (void)
{
  pthread_t workers[CONCURRENT_THREADS];
  /* An application and loader environment must not restore nonmain arenas. */
  if (mallopt (M_ARENA_MAX, 128) != 1
      || mallopt (M_ARENA_TEST, 1) != 1)
    return 2;
  if (pthread_barrier_init (&allocation_phase, NULL, CONCURRENT_THREADS + 1) != 0)
    return 2;
  for (size_t i = 0; i < CONCURRENT_THREADS; ++i)
    if (pthread_create (&workers[i], NULL, churn_worker, NULL) != 0)
      { fprintf (stderr, "concurrent pthread_create failed\n"); return 2; }
  pthread_barrier_wait (&allocation_phase);
  int count = arena_count ();
  printf ("arena_probe threads=%d mallopt_requested=128 arenas=%d\n",
          CONCURRENT_THREADS, count);
  pthread_barrier_wait (&allocation_phase);
  int result = count == 1 ? 0 : 1;
  for (size_t n = 0; n < 8; ++n)
    {
      pid_t child = fork ();
      if (child < 0) { result = 2; break; }
      if (child == 0)
        _exit (child_allocation_control ());
      int status;
      if (waitpid (child, &status, 0) != child
          || !WIFEXITED (status) || WEXITSTATUS (status) != 0)
        { fprintf (stderr, "fork allocator control failed\n"); result = 1; break; }
    }
  atomic_store (&stop_churn, 1);
  for (size_t i = 0; i < CONCURRENT_THREADS; ++i)
    if (pthread_join (workers[i], NULL) != 0) result = 2;
  pthread_barrier_destroy (&allocation_phase);
  if (atomic_load (&allocation_error) != 0) result = 1;
  if (result == 0)
    puts ("concurrency=pass alignment=pass fork_allocator=pass");
  return result;
}
static int check_oom (void)
{
  volatile size_t excessive = SIZE_MAX;
  errno = 0;
  void *p = malloc (excessive);
  if (p != NULL || errno != ENOMEM) { free (p); return 1; }
  errno = 0;
  p = calloc (excessive, 2);
  if (p != NULL || errno != ENOMEM) { free (p); return 1; }
  /* Exercise main-arena/sysmalloc allocation failure under real address
     space pressure in a child, then require ordinary small allocation. */
  pid_t child = fork ();
  if (child < 0) return 2;
  if (child == 0)
    {
      struct rlimit limit = { 64 * 1024 * 1024, 64 * 1024 * 1024 };
      if (setrlimit (RLIMIT_AS, &limit) != 0) _exit (2);
      volatile size_t pressure = 128 * 1024 * 1024;
      errno = 0;
      void *large = malloc (pressure);
      if (large != NULL || errno != ENOMEM) _exit (1);
      unsigned char *small = malloc (128);
      if (small == NULL) _exit (1);
      memset (small, 0x4b, 128);
      free (small);
      _exit (0);
    }
  int status;
  if (waitpid (child, &status, 0) != child
      || !WIFEXITED (status) || WEXITSTATUS (status) != 0)
    return 1;
  puts ("oversize_oom=pass calloc_overflow=pass pressure_oom=pass");
  return 0;
}

int main (int argc, char **argv)
{
  int require_stack_variation = argc == 2
    && strcmp (argv[1], "--require-stack-variation") == 0;
  if (argc > 2 || (argc == 2 && !require_stack_variation))
    { fprintf (stderr, "usage: %s [--require-stack-variation]\n", argv[0]); return 2; }
  alarm (60);
  int checks = check_no_tcache ();
  if (checks != 0) return checks;
  checks = check_concurrency_and_fork ();
  if (checks != 0) return checks;
  checks = check_oom ();
  if (checks != 0) return checks;
  struct observation samples[SAMPLES] = { 0 };
  pthread_attr_t requested;
  int r = pthread_attr_init (&requested);
  if (r != 0) { fprintf (stderr, "pthread_attr_init: %d\n", r); return 2; }
  r = pthread_attr_setstacksize (&requested, STACK_BYTES);
  if (r != 0) { fprintf (stderr, "pthread_attr_setstacksize: %d\n", r); return 2; }
  /* The allocating thread exits before its object is inspected, reallocated,
     and freed by the caller.  Detached arenas cannot safely be unmapped just
     because attached_threads reaches zero. */
  for (size_t n = 0; n < SAMPLES; ++n)
    {
      pthread_t worker;
      r = pthread_create (&worker, &requested, observe, &samples[n]);
      if (r == 0) r = pthread_join (worker, NULL);
      if (r != 0 || samples[n].error != 0)
        {
          fprintf (stderr, "sample %zu: pthread/worker error %d/%d\n",
                   n, r, samples[n].error);
          return 2;
        }
      unsigned char *p = samples[n].retained;
      for (size_t i = 0; i < PAYLOAD_BYTES; ++i)
        if (p[i] != payload (i))
          { fprintf (stderr, "sample %zu: cross-thread lifetime failure\n", n); return 1; }
      unsigned char *grown = realloc (p, PAYLOAD_BYTES * 2);
      if (grown == NULL) { free (p); fprintf (stderr, "realloc failure\n"); return 2; }
      for (size_t i = 0; i < PAYLOAD_BYTES; ++i)
        if (grown[i] != payload (i))
          { free (grown); fprintf (stderr, "realloc content failure\n"); return 1; }
      memset (grown + PAYLOAD_BYTES, 0xa5, PAYLOAD_BYTES);
      free (grown);
      samples[n].retained = NULL;
      printf ("sample=%zu stack=0x%" PRIxPTR " size=%zu local=0x%" PRIxPTR
              " heap=0x%" PRIxPTR " heap_low26=0x%" PRIxPTR "\n",
              n, samples[n].stack_base, samples[n].stack_size,
              samples[n].local_address, samples[n].heap_address,
              samples[n].heap_address & ((((uintptr_t) 1) << 26) - 1));
    }
  pthread_attr_destroy (&requested);
  size_t stack_distinct = distinct (samples, 1);
  size_t heap_distinct = distinct (samples, 0);
  printf ("summary samples=%d distinct_stack_bases=%zu distinct_heap_pointers=%zu"
          " cross_thread_lifetime=pass realloc_contents=pass"
          " entropy_certification=unverified\n",
          SAMPLES, stack_distinct, heap_distinct);
  /* This catches a deterministic stack-cache/mmap route.  Passing establishes
     observed variation only; it is not a statistical entropy estimate. */
  if (require_stack_variation && stack_distinct < SAMPLES / 4)
    { fprintf (stderr, "insufficient observed stack variation\n"); return 1; }
  return 0;
}
