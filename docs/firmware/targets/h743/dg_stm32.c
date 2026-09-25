/*
 * doomgeneric platform layer for the STM32H743.
 *
 *   video  : I_VideoBuffer (8-bit) -> RGB565 palette -> ILI9341 over SPI
 *   input  : push buttons and/or the USART1 console
 *   storage: DOOM1.WAD, config and savegames on a FAT-formatted microSD
 *   memory : zone heap spans DTCM, AXI SRAM and SRAM1-3 (see h743.ld)
 *
 * Console key protocol (USART1, 115200 8N1):
 *   0xF0 <doomkey>  key down       (sent by the STM32 Forge IDE gamepad)
 *   0xF1 <doomkey>  key up
 *   ANSI arrows (ESC [ A..D), WASD, Enter, Esc, Space, Ctrl-F/'f' fire and
 *   plain ASCII from any serial terminal; these auto-release after 150 ms.
 */
#include <stdio.h>
#include <string.h>

#include "board.h"
#include "board_config.h"
#include "ff.h"

#include "doomgeneric.h"
#include "doomkeys.h"
#include "doomtype.h"
#include "i_video.h"

extern byte *I_VideoBuffer;
extern struct color colors[256];
extern boolean palette_changed;

extern byte __zone0_start[], __zone0_end[], __zone1_start[], __zone1_end[];
extern byte __zone2_start[], __zone2_end[];
extern uint32_t __itcm_bss_start[], __itcm_bss_end[], __sram4_start[], __sram4_end[];

static FATFS fatfs __attribute__((section(".sram4")));
static uint16_t palette565[256];

/* ---- memory ---- */

byte *DG_ZoneBase(int *size)
{
    *size = (int)(__zone2_end - __zone0_start);
    return __zone0_start;
}

/* Unmapped address ranges between the zone banks, in ascending order. */
int DG_ZoneGap(int index, byte **start, byte **end)
{
    switch (index) {
    case 0: *start = __zone0_end; *end = __zone1_start; return 1;
    case 1: *start = __zone1_end; *end = __zone2_start; return 1;
    default: return 0;
    }
}

static unsigned zone_kb(void)
{
    return (unsigned)((__zone0_end - __zone0_start) + (__zone1_end - __zone1_start) +
                      (__zone2_end - __zone2_start)) / 1024;
}

/* The startup code only clears .bss; clear the arrays placed elsewhere. */
static void clear_extra_bss(void)
{
    for (uint32_t *p = __itcm_bss_start; p < __itcm_bss_end; p++)
        *p = 0;
    for (uint32_t *p = __sram4_start; p < __sram4_end; p++)
        *p = 0;
}

/* ---- input ---- */

#define KEYQ_SIZE 32
static uint16_t keyq[KEYQ_SIZE];
static unsigned keyq_w, keyq_r;

#define MAX_HELD 8
static struct { unsigned char key; uint32_t release_at; } held[MAX_HELD];

static void key_event(int pressed, unsigned char key)
{
    unsigned next = (keyq_w + 1) % KEYQ_SIZE;

    if (next == keyq_r)
        return;
    keyq[keyq_w] = (uint16_t)((pressed ? 0x100 : 0) | key);
    keyq_w = next;
}

/* Terminal keys have no release event: hold them for 150 ms after the
 * last repeat so auto-repeat from the terminal feels continuous. */
static void key_tap(unsigned char key)
{
    uint32_t now = HAL_GetTick();
    int free_slot = -1;

    for (int i = 0; i < MAX_HELD; i++) {
        if (held[i].key == key) {
            held[i].release_at = now + 150;
            return;
        }
        if (!held[i].key && free_slot < 0)
            free_slot = i;
    }
    if (free_slot < 0)
        return;
    held[free_slot].key = key;
    held[free_slot].release_at = now + 150;
    key_event(1, key);
}

static void release_expired(void)
{
    uint32_t now = HAL_GetTick();

    for (int i = 0; i < MAX_HELD; i++) {
        if (held[i].key && (int32_t)(now - held[i].release_at) >= 0) {
            key_event(0, held[i].key);
            held[i].key = 0;
        }
    }
}

static unsigned char ascii_to_doom(int c)
{
    switch (c) {
    case '\r': case '\n': return KEY_ENTER;
    case 0x1b:            return KEY_ESCAPE;
    case ' ':             return KEY_USE;
    case 'w': case 'W':   return KEY_UPARROW;
    case 's': case 'S':   return KEY_DOWNARROW;
    case 'a': case 'A':   return KEY_LEFTARROW;
    case 'd': case 'D':   return KEY_RIGHTARROW;
    case 'f': case 'F':
    case 0x06:            return KEY_FIRE;      /* f / Ctrl-F */
    case 0x7f: case 0x08: return KEY_BACKSPACE;
    default:
        if (c >= 'A' && c <= 'Z')
            return (unsigned char)(c - 'A' + 'a');
        return (unsigned char)c;
    }
}

static void poll_console(void)
{
    static int state;               /* 0 idle, 1 got ESC, 2 got ESC [, 3/4 raw */
    static uint32_t esc_time;
    int c;

    while ((c = console_getc()) >= 0) {
        switch (state) {
        case 0:
            if (c == 0xF0 || c == 0xF1) {
                state = (c == 0xF0) ? 3 : 4;
            } else if (c == 0x1b) {
                state = 1;
                esc_time = HAL_GetTick();
            } else {
                key_tap(ascii_to_doom(c));
            }
            break;
        case 1:
            if (c == '[') {
                state = 2;
            } else {
                key_tap(KEY_ESCAPE);
                state = 0;
                key_tap(ascii_to_doom(c));
            }
            break;
        case 2:
            state = 0;
            switch (c) {
            case 'A': key_tap(KEY_UPARROW); break;
            case 'B': key_tap(KEY_DOWNARROW); break;
            case 'C': key_tap(KEY_RIGHTARROW); break;
            case 'D': key_tap(KEY_LEFTARROW); break;
            default: break;
            }
            break;
        case 3:
        case 4:
            key_event(state == 3, (unsigned char)c);
            state = 0;
            break;
        }
    }

    /* A lone ESC (not followed by '[') is the Escape key. */
    if (state == 1 && HAL_GetTick() - esc_time > 30) {
        key_tap(KEY_ESCAPE);
        state = 0;
    }
}

static void poll_buttons(void)
{
    static const struct { uint32_t pin; unsigned char key; } map[] = {
        { BTN_UP_PIN, KEY_UPARROW },   { BTN_DOWN_PIN, KEY_DOWNARROW },
        { BTN_LEFT_PIN, KEY_LEFTARROW }, { BTN_RIGHT_PIN, KEY_RIGHTARROW },
        { BTN_FIRE_PIN, KEY_FIRE },    { BTN_USE_PIN, KEY_USE },
        { BTN_ENTER_PIN, KEY_ENTER },  { BTN_ESC_PIN, KEY_ESCAPE },
    };
    static uint32_t last;
    uint32_t now = buttons_read();
    uint32_t changed = now ^ last;

    for (unsigned i = 0; i < sizeof(map) / sizeof(map[0]); i++) {
        if (changed & map[i].pin)
            key_event((now & map[i].pin) != 0, map[i].key);
    }
    last = now;
}

int DG_GetKey(int *pressed, unsigned char *key)
{
    if (keyq_r == keyq_w) {
        poll_console();
        poll_buttons();
        release_expired();
    }
    if (keyq_r == keyq_w)
        return 0;

    *pressed = keyq[keyq_r] >> 8;
    *key = keyq[keyq_r] & 0xff;
    keyq_r = (keyq_r + 1) % KEYQ_SIZE;
    return 1;
}

/* ---- video ---- */

void DG_Init(void)
{
}

void DG_DrawFrame(void)
{
    if (palette_changed) {
        for (int i = 0; i < 256; i++) {
            uint16_t c = (uint16_t)(((colors[i].r & 0xf8) << 8) |
                                    ((colors[i].g & 0xfc) << 3) |
                                    (colors[i].b >> 3));
            palette565[i] = (uint16_t)((c >> 8) | (c << 8));   /* SPI is MSB first */
        }
        palette_changed = false;
    }
    lcd_draw_frame(I_VideoBuffer, palette565);
}

/* ---- time ---- */

void DG_SleepMs(uint32_t ms)
{
    HAL_Delay(ms);
}

uint32_t DG_GetTicksMs(void)
{
    return HAL_GetTick();
}

void DG_SetWindowTitle(const char *title)
{
    (void)title;
}

/* ---- entry point ---- */

int main(void)
{
    static char *argv[] = { "doom", "-iwad", WAD_PATH, NULL };
    FRESULT fr;

    clear_extra_bss();
    board_init();
    setvbuf(stdout, NULL, _IONBF, 0);
    printf("\nSTM32 Forge DOOM - STM32H743 @ %lu MHz\n",
           (unsigned long)(HAL_RCC_GetSysClockFreq() / 1000000));
    printf("zone: %u KB (DTCM %u + AXI %u + SRAM1-3 %u KB)\n", zone_kb(),
           (unsigned)(__zone0_end - __zone0_start) / 1024,
           (unsigned)(__zone1_end - __zone1_start) / 1024,
           (unsigned)(__zone2_end - __zone2_start) / 1024);

    lcd_init();

    if (sd_init() != 0) {
        lcd_fill(0xF800);
        board_panic("SD card not found (SDMMC1)");
    }
    fr = f_mount(&fatfs, "0:", 1);
    if (fr != FR_OK) {
        lcd_fill(0xF800);
        printf("f_mount error %d\n", fr);
        board_panic("no FAT filesystem on SD card");
    }

    doomgeneric_Create(3, argv);

    for (;;)
        doomgeneric_Tick();
}
