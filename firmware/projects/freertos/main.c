/* FreeRTOS preemption demo for STM32H743, using the CubeMX-style HAL setup. */
#include <stdio.h>
#include "main.h"
#include "FreeRTOS.h"
#include "task.h"

static volatile BaseType_t scheduler_started;
extern void xPortSysTickHandler(void);

static void led_task(void *argument)
{
    uint32_t heartbeat_count = 0;
    (void)argument;
    for (;;) {
        HAL_GPIO_TogglePin(LED_PORT, LED_PIN);
        printf("[LED task] heartbeat %lu\r\n", (unsigned long)++heartbeat_count);
        vTaskDelay(500);
    }
}

static void telemetry_task(void *argument)
{
    (void)argument;
    for (;;) {
        printf("[monitor task] tick %lu\r\n", (unsigned long)xTaskGetTickCount());
        vTaskDelay(1000);
    }
}

/* board.c keeps HAL's millisecond counter and gives the RTOS its SysTick. */
void board_systick_hook(void)
{
    if (scheduler_started)
        xPortSysTickHandler();
}

void vApplicationMallocFailedHook(void)
{
    board_panic("FreeRTOS heap exhausted");
}

void vApplicationStackOverflowHook(TaskHandle_t task, char *name)
{
    (void)task;
    board_panic(name);
}

int main(void)
{
    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART1_UART_Init();
    puts("FreeRTOS 11.1.0: starting LED and monitor tasks.");

    if (xTaskCreate(led_task, "LED", 1024, NULL, 2, NULL) != pdPASS ||
        xTaskCreate(telemetry_task, "Monitor", 1024, NULL, 1, NULL) != pdPASS)
        board_panic("FreeRTOS task creation failed");

    scheduler_started = pdTRUE;
    vTaskStartScheduler();
    board_panic("FreeRTOS scheduler returned");
}
