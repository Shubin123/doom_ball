/* USART1 echo example in the normal STM32Cube HAL application style. */
#include "main.h"

int main(void)
{
    uint8_t rxByte;

    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART1_UART_Init();
    const uint8_t ready[] = "UART echo ready (115200 8N1)\r\n";
    HAL_UART_Transmit(&huart1, ready, sizeof(ready) - 1, HAL_MAX_DELAY);

    for (;;) {
        if (HAL_UART_Receive(&huart1, &rxByte, 1, HAL_MAX_DELAY) == HAL_OK) {
            if (rxByte == '\r') {
                static const uint8_t crlf[] = "\r\n";
                HAL_UART_Transmit(&huart1, crlf, sizeof(crlf) - 1, HAL_MAX_DELAY);
            } else if (rxByte != '\n') {
                HAL_UART_Transmit(&huart1, &rxByte, 1, HAL_MAX_DELAY);
            }
        }
    }
}
