/* Nonblocking HAL tick and LED heartbeat for the STM32H743. */
#include <stdio.h>
#include "main.h"

int main(void)
{
    uint32_t nextBlink;
    uint32_t nextReport;

    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART1_UART_Init();
    puts("Timer heartbeat ready.");
    nextBlink = HAL_GetTick() + 250;
    nextReport = HAL_GetTick() + 1000;

    for (;;) {
        const uint32_t now = HAL_GetTick();
        if ((int32_t)(now - nextBlink) >= 0) {
            HAL_GPIO_TogglePin(LED_PORT, LED_PIN);
            nextBlink += 250;
        }
        if ((int32_t)(now - nextReport) >= 0) {
            printf("uptime %lu ms\n", (unsigned long)now);
            nextReport += 1000;
        }
    }
}
