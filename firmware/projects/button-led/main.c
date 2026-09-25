/* Active-low PE4 button toggles the PC13 LED on the STM32H743. */
#include <stdio.h>
#include "main.h"

int main(void)
{
    GPIO_PinState previousState = GPIO_PIN_SET;

    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART1_UART_Init();
    puts("Button controlled LED: press PE4 to toggle PC13.");

    for (;;) {
        const GPIO_PinState currentState = HAL_GPIO_ReadPin(BUTTONS_PORT, BTN_FIRE_PIN);
        if (currentState == GPIO_PIN_RESET && previousState == GPIO_PIN_SET) {
            HAL_GPIO_TogglePin(LED_PORT, LED_PIN);
            puts("button press");
            HAL_Delay(30);
        }
        previousState = currentState;
    }
}
