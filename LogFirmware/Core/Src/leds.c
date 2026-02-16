#include "leds.h"

extern TIM_HandleTypeDef htim13;   // PA6 -> TIM13_CH1
extern TIM_HandleTypeDef htim14;   // PA7 -> TIM14_CH1

#define LED1_PORT GPIOA
#define LED1_PIN  GPIO_PIN_5

static inline uint32_t _arr(TIM_HandleTypeDef *h) {
    return __HAL_TIM_GET_AUTORELOAD(h);
}

static inline void _setCCR01(TIM_HandleTypeDef *h, uint32_t ch, float d) {
    if (d < 0.0f) d = 0.0f;
    if (d > 1.0f) d = 1.0f;
    uint32_t arr = _arr(h);
    uint32_t ccr = (uint32_t)((arr + 1U) * d + 0.5f);
    if (ccr > arr) ccr = arr;
    __HAL_TIM_SET_COMPARE(h, ch, ccr);
}

void LED_Init(void)
{
    HAL_GPIO_WritePin(LED1_PORT, LED1_PIN, GPIO_PIN_RESET);

    HAL_TIM_PWM_Start(&htim13, TIM_CHANNEL_1);
    HAL_TIM_PWM_Start(&htim14, TIM_CHANNEL_1);

    __HAL_TIM_SET_COMPARE(&htim13, TIM_CHANNEL_1, 0);
    __HAL_TIM_SET_COMPARE(&htim14, TIM_CHANNEL_1, 0);
}

// Smooth breathing pattern on LED2 + LED3
// cycles = number of full breathe cycles (0→1→0)
// period_ms = time for one full cycle (e.g., 1000ms for smooth breathing)
void LED_BreatheBoth(uint8_t cycles, uint32_t period_ms)
{
    if (period_ms < 100) period_ms = 100;   // avoid divide-by-zero / silly fast
    const uint16_t steps = 100;             // resolution of fade
    uint32_t step_delay = period_ms / (steps * 2); // up+down = 2×steps

    for (uint8_t c = 0; c < cycles; c++)
    {
        // Fade up
        for (uint16_t i = 0; i <= steps; i++)
        {
            float t = (float)i / (float)steps;   // 0 → 1
            LED2_SetDuty01(t);
            LED3_SetDuty01(t);
            HAL_Delay(step_delay);
        }

        // Fade down
        for (uint16_t i = steps; i > 0; i--)
        {
            float t = (float)i / (float)steps;   // 1 → 0
            LED2_SetDuty01(t);
            LED3_SetDuty01(t);
            HAL_Delay(step_delay);
        }
    }

    // End with LEDs OFF (optional → can choose ON if desired)
    LED2_Off();
    LED3_Off();
}
void LED1_On(void)     { HAL_GPIO_WritePin(LED1_PORT, LED1_PIN, GPIO_PIN_SET); }
void LED1_Off(void)    { HAL_GPIO_WritePin(LED1_PORT, LED1_PIN, GPIO_PIN_RESET); }
void LED1_Toggle(void) { HAL_GPIO_TogglePin(LED1_PORT, LED1_PIN); }

void LED2_On(void)     { __HAL_TIM_SET_COMPARE(&htim13, TIM_CHANNEL_1, _arr(&htim13)); }
void LED2_Off(void)    { __HAL_TIM_SET_COMPARE(&htim13, TIM_CHANNEL_1, 0); }
void LED2_SetDuty01(float d) { _setCCR01(&htim13, TIM_CHANNEL_1, d); }

void LED3_On(void)     { __HAL_TIM_SET_COMPARE(&htim14, TIM_CHANNEL_1, _arr(&htim14)); }
void LED3_Off(void)    { __HAL_TIM_SET_COMPARE(&htim14, TIM_CHANNEL_1, 0); }
void LED3_SetDuty01(float d) { _setCCR01(&htim14, TIM_CHANNEL_1, d); }

void LED_AllOn(void)  { LED1_On();  LED2_On();  LED3_On(); }
void LED_AllOff(void) { LED1_Off(); LED2_Off(); LED3_Off(); }


extern TIM_HandleTypeDef htim13;
extern TIM_HandleTypeDef htim14;

static uint32_t _tim_get_clk_hz(TIM_HandleTypeDef *htim)
{
    // Works for STM32 where TIM13/14 are on APB1 (common on F4).
    // If your MCU is different, adjust the APB mapping.
    uint32_t pclk = HAL_RCC_GetPCLK1Freq();
    uint32_t ppre = (RCC->CFGR & RCC_CFGR_PPRE1) >> RCC_CFGR_PPRE1_Pos;
    uint8_t apb_div = (ppre < 4) ? 1 : (1U << (ppre - 3)); // 0xxx => /1, 100 => /2, 101 => /4, 110 => /8, 111 => /16

    // Timer clock doubles when APB prescaler != 1
    return (apb_div == 1) ? pclk : (2U * pclk);
}

static void _pwm_set_freq_and_duty(TIM_HandleTypeDef *htim, uint32_t channel,
                                  uint32_t freq_hz, float duty01)
{
    if (freq_hz == 0) freq_hz = 1;
    if (duty01 < 0.0f) duty01 = 0.0f;
    if (duty01 > 1.0f) duty01 = 1.0f;

    uint32_t timclk = _tim_get_clk_hz(htim);

    // Choose a prescaler so ARR fits in 16-bit (TIM13/14 are 16-bit on many STM32)
    uint32_t presc = 0;
    uint32_t arr   = 0;

    // target timer tick ~ 1 MHz..10 MHz is fine; we’ll solve directly:
    // f_pwm = timclk / ((PSC+1)*(ARR+1))
    // pick PSC so ARR <= 0xFFFF
    for (presc = 0; presc <= 0xFFFF; presc++) {
        uint32_t denom = (presc + 1U) * freq_hz;
        if (denom == 0) denom = 1;
        arr = (timclk / denom);
        if (arr > 0) arr -= 1U;
        if (arr <= 0xFFFFU) break;
    }
    if (arr > 0xFFFFU) arr = 0xFFFFU;

    // Apply safely (disable, update, enable)
    __HAL_TIM_DISABLE(htim);

    __HAL_TIM_SET_PRESCALER(htim, presc);
    __HAL_TIM_SET_AUTORELOAD(htim, arr);
    __HAL_TIM_SET_COUNTER(htim, 0);

    uint32_t ccr = (uint32_t)((arr + 1U) * duty01 + 0.5f);
    if (ccr > arr) ccr = arr;
    __HAL_TIM_SET_COMPARE(htim, channel, ccr);

    // Force update so PSC/ARR latch immediately
    htim->Instance->EGR = TIM_EGR_UG;

    __HAL_TIM_ENABLE(htim);
}

void LED2_BlinkStart(uint32_t freq_hz, float duty01)
{
    HAL_TIM_PWM_Start(&htim13, TIM_CHANNEL_1);
    _pwm_set_freq_and_duty(&htim13, TIM_CHANNEL_1, freq_hz, duty01);
}

void LED2_BlinkStop(void)
{
    __HAL_TIM_SET_COMPARE(&htim13, TIM_CHANNEL_1, 0);
    // optionally HAL_TIM_PWM_Stop(&htim13, TIM_CHANNEL_1);
}

void LED3_BlinkStart(uint32_t freq_hz, float duty01)
{
    HAL_TIM_PWM_Start(&htim14, TIM_CHANNEL_1);
    _pwm_set_freq_and_duty(&htim14, TIM_CHANNEL_1, freq_hz, duty01);
}

void LED3_BlinkStop(void)
{
    __HAL_TIM_SET_COMPARE(&htim14, TIM_CHANNEL_1, 0);
    // optionally HAL_TIM_PWM_Stop(&htim14, TIM_CHANNEL_1);
}
