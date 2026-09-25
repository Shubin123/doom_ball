/* ILI9341 SPI display and RGB565 color-cycle example for the STM32H743. */
#include "main.h"

int main(void)
{
    static const uint16_t colors[] = {
        0xf800, 0xfd20, 0xffe0, 0x07e0, 0x07ff, 0x001f, 0xf81f, 0xffff,
    };
    unsigned index = 0;

    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART1_UART_Init();
    lcd_init();
    for (;;) {
        lcd_fill(colors[index]);
        index = (index + 1) % (sizeof(colors) / sizeof(colors[0]));
        HAL_Delay(700);
    }
}
