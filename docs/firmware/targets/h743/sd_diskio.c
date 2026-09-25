/*
 * microSD on SDMMC1 (4-bit) and the FatFs disk I/O layer on top of it.
 * Transfers use HAL polling mode: the CPU drains the FIFO, so no DMA or
 * cache maintenance is needed and buffers may live in any RAM.
 */
#include <string.h>

#include "board.h"
#include "board_config.h"
#include "ff.h"
#include "diskio.h"

static SD_HandleTypeDef hsd;
static volatile DSTATUS sd_status = STA_NOINIT;

static void sd_gpio_init(void)
{
    GPIO_InitTypeDef gpio = {0};

    __HAL_RCC_GPIOC_CLK_ENABLE();
    __HAL_RCC_GPIOD_CLK_ENABLE();
    __HAL_RCC_SDMMC1_CLK_ENABLE();
    __HAL_RCC_SDMMC1_FORCE_RESET();
    __HAL_RCC_SDMMC1_RELEASE_RESET();

    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF12_SDIO1;
    gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9 | GPIO_PIN_10 | GPIO_PIN_11;
    HAL_GPIO_Init(GPIOC, &gpio);
    gpio.Pull = GPIO_NOPULL;
    gpio.Pin = GPIO_PIN_12;                 /* CK */
    HAL_GPIO_Init(GPIOC, &gpio);
    gpio.Pull = GPIO_PULLUP;
    gpio.Pin = GPIO_PIN_2;                  /* CMD */
    HAL_GPIO_Init(GPIOD, &gpio);
}

int sd_init(void)
{
    sd_gpio_init();

    hsd.Instance = SDMMC1;
    hsd.Init.ClockEdge = SDMMC_CLOCK_EDGE_RISING;
    hsd.Init.ClockPowerSave = SDMMC_CLOCK_POWER_SAVE_DISABLE;
    hsd.Init.BusWide = SDMMC_BUS_WIDE_4B;
    hsd.Init.HardwareFlowControl = SDMMC_HARDWARE_FLOW_CONTROL_ENABLE;
    hsd.Init.ClockDiv = SD_CLOCK_DIV;

    if (HAL_SD_Init(&hsd) != HAL_OK) {
        /* Some cards/sockets only work in 1-bit mode. */
        hsd.Init.BusWide = SDMMC_BUS_WIDE_1B;
        if (HAL_SD_Init(&hsd) != HAL_OK)
            return -1;
    }

    sd_status = 0;
    return 0;
}

static int sd_wait_ready(void)
{
    uint32_t start = HAL_GetTick();

    while (HAL_SD_GetCardState(&hsd) != HAL_SD_CARD_TRANSFER) {
        if (HAL_GetTick() - start > 1000)
            return -1;
    }
    return 0;
}

/* ---- FatFs diskio ---- */

DSTATUS disk_status(BYTE pdrv)
{
    return pdrv ? STA_NOINIT : sd_status;
}

DSTATUS disk_initialize(BYTE pdrv)
{
    if (pdrv)
        return STA_NOINIT;
    if (sd_status & STA_NOINIT)
        sd_init();
    return sd_status;
}

DRESULT disk_read(BYTE pdrv, BYTE *buff, LBA_t sector, UINT count)
{
    if (pdrv || (sd_status & STA_NOINIT))
        return RES_NOTRDY;
    if (HAL_SD_ReadBlocks(&hsd, buff, (uint32_t)sector, count, 1000) != HAL_OK)
        return RES_ERROR;
    return sd_wait_ready() ? RES_ERROR : RES_OK;
}

#if FF_FS_READONLY == 0
DRESULT disk_write(BYTE pdrv, const BYTE *buff, LBA_t sector, UINT count)
{
    if (pdrv || (sd_status & STA_NOINIT))
        return RES_NOTRDY;
    if (HAL_SD_WriteBlocks(&hsd, (uint8_t *)buff, (uint32_t)sector, count, 1000) != HAL_OK)
        return RES_ERROR;
    return sd_wait_ready() ? RES_ERROR : RES_OK;
}
#endif

DRESULT disk_ioctl(BYTE pdrv, BYTE cmd, void *buff)
{
    HAL_SD_CardInfoTypeDef info;

    if (pdrv || (sd_status & STA_NOINIT))
        return RES_NOTRDY;

    switch (cmd) {
    case CTRL_SYNC:
        return sd_wait_ready() ? RES_ERROR : RES_OK;
    case GET_SECTOR_COUNT:
        HAL_SD_GetCardInfo(&hsd, &info);
        *(LBA_t *)buff = info.LogBlockNbr;
        return RES_OK;
    case GET_SECTOR_SIZE:
        *(WORD *)buff = 512;
        return RES_OK;
    case GET_BLOCK_SIZE:
        HAL_SD_GetCardInfo(&hsd, &info);
        *(DWORD *)buff = info.LogBlockSize / 512;
        return RES_OK;
    default:
        return RES_PARERR;
    }
}
