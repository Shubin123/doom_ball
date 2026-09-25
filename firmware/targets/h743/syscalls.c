/*
 * newlib system calls shared by every H743 project: console on USART1,
 * heap, process stubs. File I/O lives in syscalls_fatfs.c (DOOM only).
 */
#include <errno.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/times.h>
#include <unistd.h>

#include "board.h"

#undef errno
extern int errno;

/* ---- console-only I/O; syscalls_fatfs.c overrides these for DOOM ---- */

__attribute__((weak)) int _write(int fd, const char *buf, int len)
{
    (void)fd;
    for (int i = 0; i < len; i++) {
        if (buf[i] == '\n')
            console_write("\r", 1);
        console_write(&buf[i], 1);
    }
    return len;
}

__attribute__((weak)) int _read(int fd, char *buf, int len)
{
    int c;

    (void)fd;
    (void)len;
    while ((c = console_getc()) < 0) {
    }
    buf[0] = (char)c;
    return 1;
}

__attribute__((weak)) int _isatty(int fd)
{
    (void)fd;
    return 1;
}

/* ---- unused file calls (no filesystem in this project) ---- */

__attribute__((weak)) int _close(int fd) { (void)fd; return -1; }
__attribute__((weak)) int _lseek(int fd, int off, int whence) { (void)fd; (void)off; (void)whence; return -1; }
__attribute__((weak)) int _fstat(int fd, struct stat *st) { (void)fd; st->st_mode = S_IFCHR; return 0; }

/* ---- heap: fixed region in DTCM (the rest of DTCM belongs to the zone) ---- */

extern char __heap_start[], __heap_end[];

void *_sbrk(ptrdiff_t incr)
{
    static char *brk = __heap_start;
    char *prev = brk;

    if (brk + incr > __heap_end) {
        errno = ENOMEM;
        return (void *)-1;
    }
    brk += incr;
    return prev;
}

/* ---- process ---- */

void _exit(int status)
{
    (void)status;
    board_panic("exit");
}

int _kill(int pid, int sig)
{
    (void)pid;
    (void)sig;
    errno = EINVAL;
    return -1;
}

int _getpid(void)
{
    return 1;
}

int _gettimeofday(struct timeval *tv, void *tz)
{
    uint32_t ms = HAL_GetTick();

    (void)tz;
    tv->tv_sec = ms / 1000;
    tv->tv_usec = (ms % 1000) * 1000;
    return 0;
}

clock_t _times(struct tms *t)
{
    (void)t;
    return (clock_t)HAL_GetTick();
}
