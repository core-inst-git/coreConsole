#pragma once
#include "stm32f7xx_hal.h"

#ifdef __cplusplus
extern "C" {
#endif

void LED_Init(void);

void LED1_On(void);
void LED1_Off(void);
void LED1_Toggle(void);

void LED2_On(void);
void LED2_Off(void);
void LED2_SetDuty01(float duty01);

void LED3_On(void);
void LED3_Off(void);
void LED3_SetDuty01(float duty01);

void LED2_StartBlink(float freq_hz, float duty01);
void LED2_StopBlink(void);

void LED3_StartBlink(float freq_hz, float duty01);
void LED3_StopBlink(void);

void LED_AllOn(void);
void LED_AllOff(void);

#ifdef __cplusplus
}
#endif
