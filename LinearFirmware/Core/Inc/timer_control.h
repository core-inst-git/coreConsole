#pragma once
#include "stm32f7xx_hal.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

extern TIM_HandleTypeDef htim3;

/* Initialize once if you want (optional; you likely already call MX_TIM3_Init) */
HAL_StatusTypeDef TIM3_ReinitPWM_IC(void);

/* Set frequency only (10 … 50000 Hz). Returns HAL_OK on success. */
HAL_StatusTypeDef TIM3_SetFreqHz(uint32_t hz);

/* Report current configured frequency in Hz (rounded). */
uint32_t TIM3_GetFreqHz(void);

/* Helpers used elsewhere in your project */
void TIM3_StartConvstPWM(void);
void TIM3_StopConvstPWM(void);
void TIM3_StartBusyCapture(void);
void TIM3_StopBusyCapture(void);

#ifdef __cplusplus
}
#endif
