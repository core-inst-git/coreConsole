#pragma once
#include "stm32f7xx_hal.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SHT40_ADDR   (0x44 << 1)
extern I2C_HandleTypeDef hi2c3;
#define SHT40_I2C    (&hi2c3)

typedef struct {
    float temperature_c;
    float humidity_rh;
} SHT40_Result;

HAL_StatusTypeDef SHT40_Read(float *tempC, float *relHumidity);

#ifdef __cplusplus
}
#endif
