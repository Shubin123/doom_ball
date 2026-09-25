/* ILI9341 SPI display and RGB565 color-cycle example for the STM32H743. */
#include "board.h"

int main(void)
{
    static const uint16_t colors[] = {
        0xf800, 0xfd20, 0xffe0, 0x07e0, 0x07ff, 0x001f, 0xf81f, 0xffff,
    };
    unsigned index = 0;

    board_init();
    lcd_init();
    for (;;) {
        lcd_fill(colors[index]);
        index = (index + 1) % (sizeof(colors) / sizeof(colors[0]));
        delay_ms(700);
    }
}
