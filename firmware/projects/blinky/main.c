/*
 * Blinky: toggles the board LED every 500 ms and prints a counter on the
 * USART1 console (PA9/PA10, 115200 8N1). Builds for both targets.
 */
#include <stdio.h>

#include "board.h"

int main(void)
{
    uint32_t count = 0;

    board_init();
    printf("\nSTM32 Forge blinky on %s @ %lu MHz\n", BOARD_NAME,
           (unsigned long)(SystemCoreClock / 1000000));

    for (;;) {
        led_toggle();
        printf("blink %lu\n", (unsigned long)count++);
        delay_ms(500);
    }
}
