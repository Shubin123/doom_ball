/* Nonblocking tick/heartbeat example for the STM32H743. */
#include <stdio.h>

#include "board.h"

int main(void)
{
    uint32_t next_blink, next_report;

    board_init();
    puts("Timer heartbeat ready.");
    next_blink = millis() + 250;
    next_report = millis() + 1000;
    for (;;) {
        const uint32_t now = millis();
        if ((int32_t)(now - next_blink) >= 0) {
            led_toggle();
            next_blink += 250;
        }
        if ((int32_t)(now - next_report) >= 0) {
            printf("uptime %lu ms\r\n", (unsigned long)now);
            next_report += 1000;
        }
    }
}
