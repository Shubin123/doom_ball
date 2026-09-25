/*
 * File system calls for DOOM: stdio on fds 0-2 goes to the USART1 console,
 * other files go to the FAT filesystem on the SD card. This lets the
 * unmodified engine use fopen()/fread()/fwrite() for the WAD, config and
 * savegames.
 */
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "board.h"
#include "ff.h"

#undef errno
extern int errno;

#define MAX_FILES   4
#define FD_BASE     3

static FIL files[MAX_FILES] __attribute__((section(".sram4")));
static uint8_t file_used[MAX_FILES];

static const char *fat_path(const char *path)
{
    while (path[0] == '.' && path[1] == '/')
        path += 2;
    return path;
}

static int fat_errno(FRESULT r)
{
    switch (r) {
    case FR_NO_FILE:
    case FR_NO_PATH:
    case FR_INVALID_NAME:
        return ENOENT;
    case FR_DENIED:
    case FR_WRITE_PROTECTED:
        return EACCES;
    case FR_EXIST:
        return EEXIST;
    case FR_TOO_MANY_OPEN_FILES:
        return EMFILE;
    default:
        return EIO;
    }
}

static FIL *fd_file(int fd)
{
    int i = fd - FD_BASE;

    if (i < 0 || i >= MAX_FILES || !file_used[i])
        return 0;
    return &files[i];
}

int _open(const char *path, int flags, int mode)
{
    BYTE fmode;
    FRESULT r;
    int i;

    (void)mode;
    for (i = 0; i < MAX_FILES && file_used[i]; i++) {
    }
    if (i == MAX_FILES) {
        errno = EMFILE;
        return -1;
    }

    switch (flags & O_ACCMODE) {
    case O_RDONLY: fmode = FA_READ; break;
    case O_WRONLY: fmode = FA_WRITE; break;
    default:       fmode = FA_READ | FA_WRITE; break;
    }
    if (flags & O_CREAT)
        fmode |= (flags & O_TRUNC) ? FA_CREATE_ALWAYS : FA_OPEN_ALWAYS;
    else if (flags & O_TRUNC)
        fmode |= FA_CREATE_ALWAYS;
    if (flags & O_APPEND)
        fmode |= FA_OPEN_APPEND;

    r = f_open(&files[i], fat_path(path), fmode);
    if (r != FR_OK) {
        errno = fat_errno(r);
        return -1;
    }
    file_used[i] = 1;
    return i + FD_BASE;
}

int _close(int fd)
{
    FIL *f = fd_file(fd);

    if (fd < FD_BASE)
        return 0;
    if (!f) {
        errno = EBADF;
        return -1;
    }
    f_close(f);
    file_used[fd - FD_BASE] = 0;
    return 0;
}

int _read(int fd, char *buf, int len)
{
    FIL *f;
    UINT n;
    FRESULT r;

    if (fd == 0) {
        int c;

        while ((c = console_getc()) < 0) {
        }
        buf[0] = (char)c;
        return 1;
    }
    f = fd_file(fd);
    if (!f) {
        errno = EBADF;
        return -1;
    }
    r = f_read(f, buf, (UINT)len, &n);
    if (r != FR_OK) {
        errno = fat_errno(r);
        return -1;
    }
    return (int)n;
}

int _write(int fd, const char *buf, int len)
{
    FIL *f;
    UINT n;
    FRESULT r;

    if (fd == 1 || fd == 2) {
        for (int i = 0; i < len; i++) {
            if (buf[i] == '\n')
                console_write("\r", 1);
            console_write(&buf[i], 1);
        }
        return len;
    }
    f = fd_file(fd);
    if (!f) {
        errno = EBADF;
        return -1;
    }
    r = f_write(f, buf, (UINT)len, &n);
    if (r != FR_OK) {
        errno = fat_errno(r);
        return -1;
    }
    return (int)n;
}

int _lseek(int fd, int offset, int whence)
{
    FIL *f = fd_file(fd);
    FSIZE_t pos;

    if (!f) {
        errno = EBADF;
        return -1;
    }
    switch (whence) {
    case SEEK_SET: pos = (FSIZE_t)offset; break;
    case SEEK_CUR: pos = f_tell(f) + offset; break;
    case SEEK_END: pos = f_size(f) + offset; break;
    default:
        errno = EINVAL;
        return -1;
    }
    if (f_lseek(f, pos) != FR_OK) {
        errno = EIO;
        return -1;
    }
    return (int)pos;
}

int _fstat(int fd, struct stat *st)
{
    FIL *f = fd_file(fd);

    memset(st, 0, sizeof(*st));
    if (fd < FD_BASE) {
        st->st_mode = S_IFCHR;
        return 0;
    }
    if (!f) {
        errno = EBADF;
        return -1;
    }
    st->st_mode = S_IFREG;
    st->st_size = (off_t)f_size(f);
    return 0;
}

int _stat(const char *path, struct stat *st)
{
    FILINFO info;
    FRESULT r = f_stat(fat_path(path), &info);

    memset(st, 0, sizeof(*st));
    if (r != FR_OK) {
        errno = fat_errno(r);
        return -1;
    }
    st->st_mode = (info.fattrib & AM_DIR) ? S_IFDIR : S_IFREG;
    st->st_size = (off_t)info.fsize;
    return 0;
}

int _isatty(int fd)
{
    return fd < FD_BASE;
}

int _unlink(const char *path)
{
    FRESULT r = f_unlink(fat_path(path));

    if (r != FR_OK) {
        errno = fat_errno(r);
        return -1;
    }
    return 0;
}

int _rename(const char *from, const char *to)
{
    FRESULT r;

    f_unlink(fat_path(to));
    r = f_rename(fat_path(from), fat_path(to));
    if (r != FR_OK) {
        errno = fat_errno(r);
        return -1;
    }
    return 0;
}

int rename(const char *from, const char *to)
{
    return _rename(from, to);
}

int mkdir(const char *path, mode_t mode)
{
    FRESULT r;

    (void)mode;
    r = f_mkdir(fat_path(path));
    if (r != FR_OK && r != FR_EXIST) {
        errno = fat_errno(r);
        return -1;
    }
    return 0;
}

int _link(const char *a, const char *b)
{
    (void)a;
    (void)b;
    errno = EMLINK;
    return -1;
}

