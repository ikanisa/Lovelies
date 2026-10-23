#define _GNU_SOURCE
#include <asm/prctl.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* Normal pthread/TLS ownership and mapping-permission checks. This fixture
   does not write outside an object, cause a protection fault, or corrupt TLS. */
static _Thread_local unsigned char tls_bytes[512];
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static int release_workers;

struct observation {
    uintptr_t stack, stack_end, tls_low, tls_high, fs;
    size_t guard;
    int ready, hold, error;
};

struct mapping { uintptr_t lo, hi; char permissions[5]; };

static int mapping_at(uintptr_t address, struct mapping *result)
{
    FILE *f = fopen("/proc/self/maps", "r");
    if (!f) return -1;
    char line[1024];
    while (fgets(line, sizeof line, f)) {
        unsigned long lo, hi;
        char permissions[5];
        if (sscanf(line, "%lx-%lx %4s", &lo, &hi, permissions) == 3 &&
            address >= lo && address < hi) {
            result->lo = lo;
            result->hi = hi;
            memcpy(result->permissions, permissions, 5);
            fclose(f);
            return 1;
        }
    }
    fclose(f);
    return 0;
}

static void *observe(void *argument)
{
    struct observation *o = argument;
    pthread_attr_t attr;
    void *stack;
    size_t size;
    unsigned long fs = 0;
    unsigned char stack_byte = 31;
    struct mapping data, lower, upper, marker;
    tls_bytes[0] = 41;
    tls_bytes[511] = 53;
    if (pthread_getattr_np(pthread_self(), &attr) ||
        pthread_attr_getstack(&attr, &stack, &size) ||
        pthread_attr_getguardsize(&attr, &o->guard) ||
        syscall(SYS_arch_prctl, ARCH_GET_FS, &fs)) {
        o->error = 1;
    } else {
        o->stack = (uintptr_t) stack;
        o->stack_end = o->stack + size;
        o->fs = fs;
        if ((uintptr_t) &stack_byte < o->stack ||
            (uintptr_t) &stack_byte >= o->stack_end ||
            (fs >= o->stack && fs < o->stack_end) ||
            mapping_at(fs, &data) != 1 ||
            strcmp(data.permissions, "rw-p") ||
            mapping_at((uintptr_t) tls_bytes, &marker) != 1 ||
            marker.lo != data.lo || marker.hi != data.hi ||
            mapping_at(data.lo - 1, &lower) != 1 ||
            mapping_at(data.hi, &upper) != 1 ||
            strcmp(lower.permissions, "---p") ||
            strcmp(upper.permissions, "---p") ||
            lower.hi != data.lo || upper.lo != data.hi ||
            lower.hi - lower.lo < (uintptr_t) sysconf(_SC_PAGESIZE) ||
            upper.hi - upper.lo < (uintptr_t) sysconf(_SC_PAGESIZE)) {
            o->error = 2;
        } else {
            o->tls_low = lower.lo;
            o->tls_high = upper.hi;
        }
        pthread_attr_destroy(&attr);
    }
    pthread_mutex_lock(&lock);
    o->ready = 1;
    pthread_cond_broadcast(&changed);
    while (o->hold && !release_workers)
        pthread_cond_wait(&changed, &lock);
    pthread_mutex_unlock(&lock);
    if (tls_bytes[0] != 41 || tls_bytes[511] != 53 || stack_byte != 31)
        o->error = 3;
    return NULL;
}

static int trigger_reaping(void)
{
    struct observation o = {0};
    pthread_t thread;
    int error = pthread_create(&thread, NULL, observe, &o);
    if (error) return error;
    error = pthread_join(thread, NULL);
    return error ? error : o.error;
}

static int unmapped(uintptr_t address)
{
    struct mapping m;
    return address && mapping_at(address, &m) == 0;
}

static int single_case(int caller_stack, size_t guard, int detached)
{
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setguardsize(&attr, guard);
    size_t caller_size = 1024 * 1024;
    void *caller = MAP_FAILED;
    if (caller_stack) {
        caller = mmap(NULL, caller_size, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (caller == MAP_FAILED ||
            pthread_attr_setstack(&attr, caller, caller_size)) return 1;
    }
    if (detached) pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    struct observation o = {.hold = 1};
    pthread_t thread;
    release_workers = 0;
    int error = pthread_create(&thread, &attr, observe, &o);
    pthread_attr_destroy(&attr);
    if (error) return error;
    pthread_mutex_lock(&lock);
    while (!o.ready) pthread_cond_wait(&changed, &lock);
    if (o.error || o.guard != (caller_stack ? 0 : guard) ||
        (caller_stack && (o.stack != (uintptr_t) caller ||
                          o.stack_end != (uintptr_t) caller + caller_size)))
        error = 2;
    release_workers = 1;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
    if (!detached && pthread_join(thread, NULL)) return 3;
    /* Reaping requires kernel completion, including detached rseq/TID cleanup. */
    for (int attempt = 0; attempt < 100; ++attempt) {
        if (trigger_reaping()) return 4;
        if (unmapped(o.fs)) break;
        usleep(1000);
    }
    if (!unmapped(o.fs)) return 5;
    if (caller_stack) {
        struct mapping m;
        if (mapping_at((uintptr_t) caller, &m) != 1) return 6;
        memset(caller, 7, caller_size);
        if (munmap(caller, caller_size)) return 7;
    } else if (!unmapped(o.stack + guard)) return 8;
    printf("PASS tls ownership caller=%d guard=%zu detached=%d\n",
           caller_stack, guard, detached);
    return error;
}

static int fork_case(void)
{
    enum { count = 6 };
    struct observation observations[count] = {{0}};
    pthread_t threads[count];
    void *callers[count] = {0};
    const size_t size = 1024 * 1024;
    release_workers = 0;
    for (int i = 0; i < count; ++i) {
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        observations[i].hold = 1;
        if (i & 1) {
            callers[i] = mmap(NULL, size, PROT_READ | PROT_WRITE,
                             MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
            if (callers[i] == MAP_FAILED ||
                pthread_attr_setstack(&attr, callers[i], size)) return 1;
        }
        int error = pthread_create(&threads[i], &attr, observe, &observations[i]);
        pthread_attr_destroy(&attr);
        if (error) return error;
    }
    pthread_mutex_lock(&lock);
    for (int i = 0; i < count; ++i) {
        while (!observations[i].ready) pthread_cond_wait(&changed, &lock);
        if (observations[i].error) return 2;
    }
    pthread_mutex_unlock(&lock);
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) {
        /* The fixture's vanished waiters are process-private test state. */
        lock = (pthread_mutex_t) PTHREAD_MUTEX_INITIALIZER;
        changed = (pthread_cond_t) PTHREAD_COND_INITIALIZER;
        if (trigger_reaping()) _exit(4);
        for (int i = 0; i < count; ++i) {
            if (!unmapped(observations[i].fs)) _exit(5);
            struct mapping m;
            if (callers[i]) {
                if (mapping_at((uintptr_t) callers[i], &m) != 1) _exit(6);
            } else if (!unmapped(observations[i].stack + observations[i].guard)) {
                _exit(7);
            }
        }
        _exit(0);
    }
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
        WEXITSTATUS(status)) return 8;
    pthread_mutex_lock(&lock);
    release_workers = 1;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
    for (int i = 0; i < count; ++i) {
        if (pthread_join(threads[i], NULL)) return 9;
        if (callers[i] && munmap(callers[i], size)) return 10;
    }
    puts("PASS mixed live-thread fork ownership and child reclamation");
    return 0;
}

int main(void)
{
    size_t page = sysconf(_SC_PAGESIZE);
    if (single_case(0, page, 0) || single_case(0, 0, 0) ||
        single_case(1, page, 0) || single_case(0, page, 1) ||
        single_case(1, 0, 1) || fork_case()) {
        fputs("FAIL TLS layout/ownership fixture\n", stderr);
        return 1;
    }
    puts("PASS separate guarded TLS mapping profile");
    return 0;
}
