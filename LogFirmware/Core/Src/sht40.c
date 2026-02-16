#include "sht40.h"
#include <stdio.h>

HAL_StatusTypeDef SHT40_Read(float *tempC, float *relHumidity)
{
    uint8_t cmd = 0xFD; // High precision measurement
    uint8_t rx[6];

    // Send measurement command
    if (HAL_I2C_Master_Transmit(SHT40_I2C, SHT40_ADDR, &cmd, 1, 50) != HAL_OK)
        return HAL_ERROR;

    HAL_Delay(10);  // Wait 8-15 ms

    // Read result
    if (HAL_I2C_Master_Receive(SHT40_I2C, SHT40_ADDR, rx, 6, 50) != HAL_OK)
        return HAL_ERROR;

    uint16_t t_raw  = (uint16_t)rx[0] << 8 | rx[1];
    uint16_t rh_raw = (uint16_t)rx[3] << 8 | rx[4];

    float t = -45.0f + 175.0f * ((float)t_raw / 65535.0f);
    float rh = -6.0f + 125.0f * ((float)rh_raw / 65535.0f);

    if (rh > 100.0f) rh = 100.0f;
    if (rh < 0.0f)   rh = 0.0f;

    *tempC = t;
    *relHumidity = rh;
    return HAL_OK;
}
