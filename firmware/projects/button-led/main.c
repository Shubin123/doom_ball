/* Button-controlled PC13 LED example for the STM32H743. */
#include <stdio.h>

#include "board.h"
#include "board_config.h"

int main(void)
{
    const uint32_t button = (uint32_t)BTN_FIRE_PIN;
    uint32_t was_pressed = 0;

    board_init();
    puts("Button controlled LED: press PE4 to toggle PC13.");
    for (;;) {
        const uint32_t pressed = (buttons_read() & button) != 0;
        if (pressed && !was_pressed) {
            led_toggle();
            puts("button press");
            delay_ms(30);
        }
        was_pressed = pressed;
    }
}
