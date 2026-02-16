#ifndef TIMER_ADC_TRIG_H
#define TIMER_ADC_TRIG_H

#include "stm32f7xx_hal.h"
#include <stdint.h>
#include <stdbool.h>

/**
 * @brief Initialize TIM3 CH1 (PB4) as a PWM trigger output.
 *
 * PB4 is configured to AF2 (TIM3_CH1). The timer runs in PWM1 mode.
 * You can select the TRGO source (UPDATE or OC1REF) to feed other peripherals.
 *
 * @param target_hz   Desired trigger frequency in Hz (e.g., 100000 for 100 kHz).
 * @param duty_pct    Duty cycle in percent [0.1 .. 99.9] typical, clamped internally to [0 .. 100].
 * @param trgo_src    TIM_TRGO_UPDATE or TIM_TRGO_OC1 (OC1REF) for master trigger output.
 * @return HAL status.
 */
HAL_StatusTypeDef TIMER_ADC_TRIG_Init(uint32_t target_hz, float duty_pct, uint32_t trgo_src);

/**
 * @brief Start output on PB4 (TIM3 CH1).
 */
HAL_StatusTypeDef TIMER_ADC_TRIG_Start(void);

/**
 * @brief Stop output on PB4 (TIM3 CH1).
 */
HAL_StatusTypeDef TIMER_ADC_TRIG_Stop(void);

/**
 * @brief Change trigger frequency on the fly (glitch-safe as much as HAL allows).
 *
 * Recomputes PSC/ARR and updates duty to preserve the same duty %.
 * If you want a different TRGO after this, call TIMER_ADC_TRIG_SetTRGO().
 *
 * @param target_hz Desired frequency in Hz.
 * @return HAL status.
 */
HAL_StatusTypeDef TIMER_ADC_TRIG_SetFrequency(uint32_t target_hz);

/**
 * @brief Change duty cycle on the fly.
 *
 * @param duty_pct Duty cycle in percent [0 .. 100].
 * @return HAL status.
 */
HAL_StatusTypeDef TIMER_ADC_TRIG_SetDuty(float duty_pct);

/**
 * @brief Set the timer TRGO source (master mode): UPDATE or OC1REF.
 *
 * @param trgo_src TIM_TRGO_UPDATE or TIM_TRGO_OC1.
 * @return HAL status.
 */
HAL_StatusTypeDef TIMER_ADC_TRIG_SetTRGO(uint32_t trgo_src);

/**
 * @brief Obtain the actually programmed frequency after quantization.
 *
 * @return Actual Hz.
 */
uint32_t TIMER_ADC_TRIG_GetActualHz(void);

/**
 * @brief Get currently programmed duty in percent (computed from CCR1/ARR).
 */
float TIMER_ADC_TRIG_GetDuty(void);

/**
 * @brief Return whether TIM3 CH1 is currently running.
 */
bool TIMER_ADC_TRIG_IsRunning(void);

#endif /* TIMER_ADC_TRIG_H */
