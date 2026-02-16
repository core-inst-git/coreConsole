#include "timer_control.h"
#include "stm32f7xx_hal.h"
#include "stm32f7xx_hal_tim.h"   // <-- required for __HAL_TIM_GET_* macros
#include "stm32f7xx_hal_tim_ex.h"

extern TIM_HandleTypeDef htim3;
/* ---- Local: compute TIM3 kernel clock (APB1 x2 when prescaled) ---- */
static uint32_t tim3_get_clk_hz(void)
{
    uint32_t pclk1 = HAL_RCC_GetPCLK1Freq();
    /* If APB1 prescaler != 1, timer clock is doubled (see RM) */
    uint32_t pres = (RCC->CFGR & RCC_CFGR_PPRE1);
    if (pres != RCC_CFGR_PPRE1_DIV1) pclk1 *= 2u;
    return pclk1; /* typically 108 MHz when HCLK=216 & APB1=DIV4 */
}

/* ---- Local: choose PSC/ARR to approximate target freq with 16-bit ARR ---- */
static void choose_psc_arr(uint32_t timclk, uint32_t target_hz, uint16_t *out_psc, uint16_t *out_arr)
{
    /* clamp target */
    if (target_hz < 10u)      target_hz = 10u;
    if (target_hz > 50000u)   target_hz = 50000u;

    /* total ticks per period (float-safe integer math) */
    uint32_t ticks = (uint32_t)(( (uint64_t)timclk + target_hz/2u ) / target_hz);
    if (ticks < 2u) ticks = 2u;

    /* choose prescaler so ARR fits 16-bit */
    uint32_t psc = (ticks + 65535u) / 65536u; /* ceil(ticks/65536) */
    if (psc == 0u) psc = 1u;                  /* PSC register stores (psc-1) later */
    if (psc > 65536u) psc = 65536u;

    uint32_t arr = (ticks + psc - 1u) / psc;  /* ceil(ticks/psc) */
    if (arr < 2u) arr = 2u;
    if (arr > 65536u) arr = 65536u;

    *out_psc = (uint16_t)(psc - 1u);
    *out_arr = (uint16_t)(arr - 1u);
}

/* Optional: (re)configure TIM3 base + PWM CH1 + IC CH2 in one go */
HAL_StatusTypeDef TIM3_ReinitPWM_IC(void)
{
    HAL_StatusTypeDef st;

    /* Stop channels in case they run */
    HAL_TIM_PWM_Stop(&htim3, TIM_CHANNEL_1);
    HAL_TIM_IC_Stop_IT(&htim3, TIM_CHANNEL_2);

    /* Base init (keep what Cube set; you can override later with SetFreqHz) */
    htim3.Instance               = TIM3;
    htim3.Init.CounterMode       = TIM_COUNTERMODE_UP;
    htim3.Init.ClockDivision     = TIM_CLOCKDIVISION_DIV1;
    htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;

    st = HAL_TIM_Base_Init(&htim3);                             if (st != HAL_OK) return st;

    TIM_ClockConfigTypeDef sClock = { .ClockSource = TIM_CLOCKSOURCE_INTERNAL };
    st = HAL_TIM_ConfigClockSource(&htim3, &sClock);            if (st != HAL_OK) return st;

    st = HAL_TIM_PWM_Init(&htim3);                              if (st != HAL_OK) return st;
    st = HAL_TIM_IC_Init(&htim3);                               if (st != HAL_OK) return st;

    TIM_MasterConfigTypeDef sMaster = {0};
    sMaster.MasterOutputTrigger  = TIM_TRGO_RESET;
    sMaster.MasterSlaveMode      = TIM_MASTERSLAVEMODE_DISABLE;
    st = HAL_TIMEx_MasterConfigSynchronization(&htim3, &sMaster); if (st != HAL_OK) return st;

    /* CH1 = PWM1, HIGH polarity */
    TIM_OC_InitTypeDef sOC = {0};
    sOC.OCMode     = TIM_OCMODE_PWM1;
    sOC.Pulse      = 1u;
    sOC.OCPolarity = TIM_OCPOLARITY_HIGH;
    sOC.OCFastMode = TIM_OCFAST_DISABLE;
    st = HAL_TIM_PWM_ConfigChannel(&htim3, &sOC, TIM_CHANNEL_1); if (st != HAL_OK) return st;

    /* CH2 = input capture, falling edge (AD7606 BUSY) */
    TIM_IC_InitTypeDef sIC = {0};
    sIC.ICPolarity  = TIM_INPUTCHANNELPOLARITY_FALLING;
    sIC.ICSelection = TIM_ICSELECTION_DIRECTTI;
    sIC.ICPrescaler = TIM_ICPSC_DIV1;
    sIC.ICFilter    = 0;
    st = HAL_TIM_IC_ConfigChannel(&htim3, &sIC, TIM_CHANNEL_2);  if (st != HAL_OK) return st;

    HAL_TIM_MspPostInit(&htim3);
    return HAL_OK;
}

/* Return current TIM3 update rate from PSC/ARR */
uint32_t TIM3_GetFreqHz(void)
{
    uint32_t timclk = tim3_get_clk_hz();       // your helper must return the *timer* clock
    uint32_t psc    = htim3.Instance->PSC;     // raw register
    uint32_t arr    = htim3.Instance->ARR;     // raw register
    if ((psc + 1u) == 0u || (arr + 1u) == 0u) return 0u;
    return timclk / ((psc + 1u) * (arr + 1u));
}

/* Recompute PSC/ARR to realize requested frequency (10 Hz … 50 kHz) */
HAL_StatusTypeDef TIM3_SetFreqHz(uint32_t hz)
{
    if (hz < 10u)      hz = 10u;
    if (hz > 200000u)   hz = 200000u;

    uint32_t timclk = tim3_get_clk_hz();  // e.g. 108 MHz or 216 MHz depending on APB1*2
    if (timclk == 0u) return HAL_ERROR;

    /* Total ticks per period */
    uint64_t ticks = (uint64_t)timclk / (uint64_t)hz;
    if (ticks < 2u) ticks = 2u;

    /* Choose PSC so ARR fits in 16 bits.
       We want (ARR+1) = ceil(ticks / (PSC+1)) ≤ 65536  */
    uint32_t psc = (uint32_t)((ticks + 65536ull - 1ull) / 65536ull);
    if (psc > 0u) psc -= 1u;                    // because PSC register stores (PSC)
    if (psc > 0xFFFFu) psc = 0xFFFFu;

    uint32_t arr = (uint32_t)((ticks + (psc + 1u) - 1u) / (psc + 1u));
    if (arr == 0u) arr = 1u;
    if (arr > 65536u) arr = 65536u;
    arr -= 1u;                                  // ARR register is (ARR)

    /* Apply safely */
    __HAL_TIM_DISABLE(&htim3);
    htim3.Instance->PSC = psc;
    htim3.Instance->ARR = arr;
    __HAL_TIM_SET_COUNTER(&htim3, 0);
    htim3.Instance->EGR = TIM_EGR_UG;           // latch PSC/ARR

    /* If you use CH1 PWM for CONVST, keep its duty as a short pulse (~1%) */
    uint32_t ccr = (arr + 1u) / 10u;           // ~1% duty default
    if (ccr == 0u) ccr = 1u;
    if (ccr > arr) ccr = arr;
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, ccr);

    __HAL_TIM_ENABLE(&htim3);
    return HAL_OK;
}

/* Minimal start/stop helpers used by your ACQ code */
void TIM3_StartConvstPWM(void)
{
    HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
}
void TIM3_StopConvstPWM(void)
{
    HAL_TIM_PWM_Stop(&htim3, TIM_CHANNEL_1);
}
void TIM3_StartBusyCapture(void)
{
    HAL_TIM_IC_Start_IT(&htim3, TIM_CHANNEL_2);
}
void TIM3_StopBusyCapture(void)
{
    HAL_TIM_IC_Stop_IT(&htim3, TIM_CHANNEL_2);
}
