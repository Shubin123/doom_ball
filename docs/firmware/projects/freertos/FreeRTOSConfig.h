#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H

#include <stdint.h>
#include "stm32h7xx.h"

#define configUSE_PREEMPTION                    1
#define configUSE_TIME_SLICING                   1
#define configUSE_PORT_OPTIMISED_TASK_SELECTION  0
#define configUSE_TICKLESS_IDLE                  0
#define configCPU_CLOCK_HZ                       400000000UL
#define configSYSTICK_CLOCK_HZ                   configCPU_CLOCK_HZ
#define configTICK_RATE_HZ                       1000U
#define configMAX_PRIORITIES                     5U
#define configMINIMAL_STACK_SIZE                 256U
#define configMAX_TASK_NAME_LEN                  16U
#define configTICK_TYPE_WIDTH_IN_BITS             TICK_TYPE_WIDTH_32_BITS
#define configIDLE_SHOULD_YIELD                   1
#define configUSE_MUTEXES                         0
#define configUSE_RECURSIVE_MUTEXES               0
#define configUSE_COUNTING_SEMAPHORES             0
#define configUSE_QUEUE_SETS                      0
#define configUSE_TIMERS                          0
#define configUSE_EVENT_GROUPS                    0
#define configUSE_STREAM_BUFFERS                  0
#define configUSE_CO_ROUTINES                     0
#define configSUPPORT_STATIC_ALLOCATION           0
#define configSUPPORT_DYNAMIC_ALLOCATION          1
#define configTOTAL_HEAP_SIZE                     (32U * 1024U)
#define configAPPLICATION_ALLOCATED_HEAP          0
#define configCHECK_FOR_STACK_OVERFLOW            2
#define configUSE_MALLOC_FAILED_HOOK              1
#define configUSE_IDLE_HOOK                       0
#define configUSE_TICK_HOOK                       0
#define configUSE_TRACE_FACILITY                  0
#define configUSE_STATS_FORMATTING_FUNCTIONS      0
#define configGENERATE_RUN_TIME_STATS             0
#define configUSE_NEWLIB_REENTRANT                0
#define configUSE_TASK_NOTIFICATIONS              1
#define configTASK_NOTIFICATION_ARRAY_ENTRIES     1
#define configQUEUE_REGISTRY_SIZE                 0
#define configENABLE_BACKWARD_COMPATIBILITY       0
#define configUSE_MINI_LIST_ITEM                  1
#define configSTACK_DEPTH_TYPE                    size_t
#define configMESSAGE_BUFFER_LENGTH_TYPE           size_t
#define configPRIO_BITS                           __NVIC_PRIO_BITS
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY   15U
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 5U
#define configKERNEL_INTERRUPT_PRIORITY           (configLIBRARY_LOWEST_INTERRUPT_PRIORITY << (8U - configPRIO_BITS))
#define configMAX_SYSCALL_INTERRUPT_PRIORITY      (configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << (8U - configPRIO_BITS))
#define configCHECK_HANDLER_INSTALLATION          0
#define vPortSVCHandler                           SVC_Handler
#define xPortPendSVHandler                        PendSV_Handler
#define configASSERT(condition) do { if (!(condition)) { taskDISABLE_INTERRUPTS(); for (;;) {} } } while (0)

#define INCLUDE_vTaskDelay                        1
#define INCLUDE_vTaskDelete                       0
#define INCLUDE_vTaskSuspend                      0
#define INCLUDE_xTaskGetSchedulerState            1

#endif
