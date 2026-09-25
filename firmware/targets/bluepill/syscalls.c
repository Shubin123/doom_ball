/*
 * Minimal newlib system calls: console on USART1, small heap, no files.
 */
#include <errno.h>
#include <stddef.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/times.h>

#include "board.h"

#undef errno
extern int errno;

int _write(int fd, const char *buf, int len)
{
    (void)fd;
    for (int i = 0; i < len; i++) {
        if (buf[i] == '\n')
            console_write("\r", 1);
        console_write(&buf[i], 1);
    }
    return len;
}

int _read(int fd, char *buf, int len)
{
    int c;

    (void)fd;
    (void)len;
    while ((c = console_getc()) < 0) {
    }
    buf[0] = (char)c;
    return 1;
}

int _isatty(int fd) { (void)fd; return 1; }
int _close(int fd) { (void)fd; return -1; }
int _lseek(int fd, int off, int whence) { (void)fd; (void)off; (void)whence; return -1; }
int _fstat(int fd, struct stat *st) { (void)fd; st->st_mode = S_IFCHR; return 0; }
int _open(const char *path, int flags, int mode) { (void)path; (void)flags; (void)mode; errno = ENOENT; return -1; }
int _unlink(const char *path) { (void)path; errno = ENOENT; return -1; }
int mkdir(const char *path, mode_t mode) { (void)path; (void)mode; errno = ENOSYS; return -1; }
int _kill(int pid, int sig) { (void)pid; (void)sig; errno = EINVAL; return -1; }
int _getpid(void) { return 1; }
void _exit(int status) { (void)status; board_panic("exit"); }
int _gettimeofday(struct timeval *tv, void *tz) { (void)tz; tv->tv_sec = millis() / 1000; tv->tv_usec = (millis() % 1000) * 1000; return 0; }
clock_t _times(struct tms *t) { (void)t; return (clock_t)millis(); }

extern char end;
extern char _estack;
extern char _Min_Stack_Size;

void *_sbrk(ptrdiff_t incr)
{
    static char *brk = &end;
    char *limit = &_estack - (size_t)&_Min_Stack_Size;
    char *prev = brk;

    if (brk + incr > limit) {
        errno = ENOMEM;
        return (void *)-1;
    }
    brk += incr;
    return prev;
}
