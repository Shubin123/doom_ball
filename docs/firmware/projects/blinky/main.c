/*
 * Blinky: CubeMX-style HAL application for the STM32H743. The fallback keeps
 * this same example available on the register-level Blue Pill and
 * Nucleo-F401RE targets.
 */
#include <stdio.h>

#if defined(USE_HAL_DRIVER)
#include "main.h"

int main(void)
{
    uint32_t count = 0;

    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART1_UART_Init();

    printf("STM32 Forge blinky @ %lu MHz\n",
           (unsigned long)(SystemCoreClock / 1000000));
    for (;;) {
        HAL_GPIO_TogglePin(LED_PORT, LED_PIN);
        printf("blink %lu\n", (unsigned long)count++);
        HAL_Delay(3000);
    }
}

#else
#include "board.h"

int main(void)
{
    uint32_t count = 0;

    board_init();
    printf("STM32 Forge blinky on %s @ %lu MHz\n", BOARD_NAME,
           (unsigned long)(SystemCoreClock / 1000000));
    for (;;) {
        led_toggle();
        printf("blink %lu\n", (unsigned long)count++);
        delay_ms(3000);
    }
}
#endif
