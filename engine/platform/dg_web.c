/*
 * doomgeneric platform layer for the STM32 Forge browser simulator.
 *
 * Compiled with emscripten from the same engine sources that the H743
 * firmware uses. The zone size is supplied by the page so the simulator
 * runs under the same heap budget as the selected MCU target.
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <emscripten.h>

#include "doomgeneric.h"
#include "doomtype.h"
#include "i_video.h"

extern byte *I_VideoBuffer;
extern struct color colors[256];

static uint32_t rgba[SCREENWIDTH * SCREENHEIGHT];

#define KEYQUEUE_SIZE 64
static uint16_t key_queue[KEYQUEUE_SIZE];
static unsigned key_w, key_r;

static int zone_bytes = 6 * 1024 * 1024;
static byte *zone_mem;

EMSCRIPTEN_KEEPALIVE void dg_push_key(int pressed, int doomkey)
{
    key_queue[key_w] = (uint16_t)((pressed ? 0x100 : 0) | (doomkey & 0xff));
    key_w = (key_w + 1) % KEYQUEUE_SIZE;
}

EMSCRIPTEN_KEEPALIVE void dg_set_zone_size(int bytes)
{
    zone_bytes = bytes;
}

EMSCRIPTEN_KEEPALIVE uint32_t *dg_frame_ptr(void)
{
    return rgba;
}

byte *DG_ZoneBase(int *size)
{
    zone_mem = malloc(zone_bytes);
    if (!zone_mem) {
        fprintf(stderr, "zone: cannot allocate %d bytes\n", zone_bytes);
        abort();
    }
    *size = zone_bytes;
    return zone_mem;
}

void DG_Init(void) {}

void DG_DrawFrame(void)
{
    const byte *src = I_VideoBuffer;
    for (int i = 0; i < SCREENWIDTH * SCREENHEIGHT; i++) {
        struct color c = colors[src[i]];
        rgba[i] = 0xff000000u | ((uint32_t)c.b << 16) | ((uint32_t)c.g << 8) | c.r;
    }
    EM_ASM({ if (Module.onFrame) Module.onFrame($0, $1, $2); },
           rgba, SCREENWIDTH, SCREENHEIGHT);
}

void DG_SleepMs(uint32_t ms) { (void)ms; }

uint32_t DG_GetTicksMs(void)
{
    return (uint32_t)emscripten_get_now();
}

int DG_GetKey(int *pressed, unsigned char *key)
{
    if (key_r == key_w)
        return 0;
    uint16_t k = key_queue[key_r];
    key_r = (key_r + 1) % KEYQUEUE_SIZE;
    *pressed = k >> 8;
    *key = k & 0xff;
    return 1;
}

void DG_SetWindowTitle(const char *title) { (void)title; }

int main(int argc, char **argv)
{
    doomgeneric_Create(argc, argv);
    emscripten_set_main_loop(doomgeneric_Tick, 35, 1);
    return 0;
}
