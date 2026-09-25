/*
 * DOOM platform layer for the Blue Pill.
 *
 * This exists to show, with a real link, why DOOM cannot run on an
 * STM32F103C8T6: the engine alone is ~300 KB of code against 64 KB of
 * flash, and it needs a zone heap of at least 704 KB (the minimum that ran
 * every demo in tests/sim_headless.mjs) against 20 KB of SRAM. The linker
 * reports both overflows. Use the STM32H743 target to run DOOM.
 */
#include <stdio.h>

#include "board.h"
#include "doomgeneric.h"
#include "doomtype.h"

#define DOOM_MIN_ZONE_BYTES (704 * 1024)

static byte zone[DOOM_MIN_ZONE_BYTES];

byte *DG_ZoneBase(int *size)
{
    *size = sizeof(zone);
    return zone;
}

int DG_ZoneGap(int index, byte **start, byte **end)
{
    (void)index;
    (void)start;
    (void)end;
    return 0;
}

void DG_Init(void) {}
void DG_DrawFrame(void) {}
void DG_SleepMs(uint32_t ms) { delay_ms(ms); }
uint32_t DG_GetTicksMs(void) { return millis(); }
int DG_GetKey(int *pressed, unsigned char *key) { (void)pressed; (void)key; return 0; }
void DG_SetWindowTitle(const char *title) { (void)title; }

int main(void)
{
    static char *argv[] = { "doom", "-iwad", "DOOM1.WAD", NULL };

    board_init();
    doomgeneric_Create(3, argv);
    for (;;)
        doomgeneric_Tick();
}
