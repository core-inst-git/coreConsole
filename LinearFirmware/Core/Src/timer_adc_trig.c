#include "timer_adc_trig.h"
#include "main.h"

/* ---- Internal state ---- */
extern TIM_HandleTypeDef htim3;
static uint32_t g_tim_clk_hz = 0;     // TIM3 input clock after APB1 prescaler doubling rule
static uint32_t g_actual_hz  = 0;
static float    g_duty_pct   = 50.0f;
static bool     g_started    = false;

/* ---- Helpers ---- */
static uint32_t calc_tim_clk_apb1(void) {
    /* On STM32F7, if APB prescaler != 1, timer clock = 2 * PCLK */
    uint32_t pclk1 = HAL_RCC_GetPCLK1Freq();
    RCC_ClkInitTypeDef clk;
    uint32_t flash_latency;
    HAL_RCC_GetClockConfig(&clk, &flash_latency);

    if (clk.APB1CLKDivider == RCC_HCLK_DIV1) {
        return pclk1;
    } else {
        return pclk1 * 2U;
    }
}

static void clamp_float(float *v, float lo, float hi) {
    if (*v < lo) *v = lo;
    if (*v > hi) *v = hi;
}

/**
 * @brief Find PSC and ARR for closest frequency.
 *        TIM3 is 16-bit for PSC and ARR (ARR must be 1..65535, PSC 0..65535).
 */
static void choose_psc_arr(uint32_t tim_clk, uint32_t target_hz, uint16_t *psc_out, uint16_t *arr_out, uint32_t *achieved_hz) {
    if (target_hz == 0) target_hz = 1;

    /* We seek tim_clk / ((PSC+1)*(ARR+1)) ~= target_hz
       Strategy: sweep PSC to keep ARR in 1..65535, choose closest. */
    uint32_t best_err = 0xFFFFFFFFu;
    uint16_t best_psc = 0;
    uint16_t best_arr = 0;
    uint32_t best_hz  = 0;

    /* Limit PSC sweep to something reasonable to keep runtime tiny. */
    uint32_t max_psc = 65535u;
    for (uint32_t psc = 0; psc <= max_psc; ++psc) {
        uint32_t nom = tim_clk / (psc + 1U);
        if (nom == 0) break;
        uint32_t arr_plus1 = (nom + target_hz/2) / target_hz;  // round
        if (arr_plus1 < 1U || arr_plus1 > 65536U) continue;

        uint32_t hz = nom / arr_plus1;
        uint32_t err = (hz > target_hz) ? (hz - target_hz) : (target_hz - hz);
        if (err < best_err) {
            best_err = err;
            best_psc = (uint16_t)psc;
            best_arr = (uint16_t)(arr_plus1 - 1U);
            best_hz  = hz;
            if (err == 0) break;
        }
        /* Early stop heuristic: if nom < target_hz, increasing PSC only lowers nom. */
        if (nom < target_hz) break;
    }

    *psc_out = best_psc;
    *arr_out = best_arr;
    *achieved_hz = best_hz;
}

static HAL_StatusTypeDef gpio_pb4_tim3ch1_init(void) {
    __HAL_RCC_GPIOB_CLK_ENABLE();
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin       = GPIO_PIN_4;           // PB4
    gpio.Mode      = GPIO_MODE_AF_PP;
    gpio.Pull      = GPIO_NOPULL;
    gpio.Speed     = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF2_TIM3;        // TIM3_CH1
    HAL_GPIO_Init(GPIOB, &gpio);
    return HAL_OK;
}

static HAL_StatusTypeDef tim3_master_set_trgo(uint32_t trgo_src) {
    TIM_MasterConfigTypeDef master = {0};
    master.MasterOutputTrigger = trgo_src;     // TIM_TRGO_UPDATE or TIM_TRGO_OC1
    master.MasterSlaveMode     = TIM_MASTERSLAVEMODE_DISABLE;
    return HAL_TIMEx_MasterConfigSynchronization(&htim3, &master);
}

static HAL_StatusTypeDef tim3_reconfigure_core(uint32_t target_hz, float keep_duty_pct) {
    uint16_t psc=0, arr=0;
    uint32_t hz=0;
    choose_psc_arr(g_tim_clk_hz, target_hz, &psc, &arr, &hz);

    htim3.Instance = TIM3;
    htim3.Init.Prescaler         = psc;
    htim3.Init.CounterMode       = TIM_COUNTERMODE_UP;
    htim3.Init.Period            = arr;            // ARR
    htim3.Init.ClockDivision     = TIM_CLOCKDIVISION_DIV1;
    htim3.Init.RepetitionCounter = 0;
    htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;

    if (HAL_TIM_PWM_Init(&htim3) != HAL_OK) return HAL_ERROR;

    TIM_OC_InitTypeDef oc = {0};
    oc.OCMode       = TIM_OCMODE_PWM1;
    oc.Pulse        = (uint32_t)((float)(arr + 1U) * (keep_duty_pct * 0.01f)); // CCR1
    if (oc.Pulse > arr) oc.Pulse = arr; // clamp
    oc.OCPolarity   = TIM_OCPOLARITY_HIGH;
    oc.OCFastMode   = TIM_OCFAST_DISABLE;

    if (HAL_TIM_PWM_ConfigChannel(&htim3, &oc, TIM_CHANNEL_1) != HAL_OK) return HAL_ERROR;

    // Write CCR1 directly to ensure exact pulse level if HAL didn't already.
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, oc.Pulse);

    g_actual_hz = hz;
    g_duty_pct  = keep_duty_pct;
    return HAL_OK;
}

/* ---- Public API ---- */

HAL_StatusTypeDef TIMER_ADC_TRIG_Init(uint32_t target_hz, float duty_pct, uint32_t trgo_src) {
    __HAL_RCC_TIM3_CLK_ENABLE();

    g_tim_clk_hz = calc_tim_clk_apb1();
    clamp_float(&duty_pct, 0.0f, 100.0f);

    if (gpio_pb4_tim3ch1_init() != HAL_OK) return HAL_ERROR;

    if (tim3_reconfigure_core(target_hz, duty_pct) != HAL_OK) return HAL_ERROR;

    if (tim3_master_set_trgo(trgo_src) != HAL_OK) return HAL_ERROR;

    return HAL_OK;
}

HAL_StatusTypeDef TIMER_ADC_TRIG_Start(void) {
    HAL_StatusTypeDef st = HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
    if (st == HAL_OK) g_started = true;
    return st;
}

HAL_StatusTypeDef TIMER_ADC_TRIG_Stop(void) {
    HAL_StatusTypeDef st = HAL_TIM_PWM_Stop(&htim3, TIM_CHANNEL_1);
    if (st == HAL_OK) g_started = false;
    return st;
}

HAL_StatusTypeDef TIMER_ADC_TRIG_SetFrequency(uint32_t target_hz) {
    bool was_running = g_started;
    if (was_running) TIMER_ADC_TRIG_Stop();

    HAL_StatusTypeDef st = tim3_reconfigure_core(target_hz, g_duty_pct);

    if (st == HAL_OK && was_running) st = TIMER_ADC_TRIG_Start();
    return st;
}

HAL_StatusTypeDef TIMER_ADC_TRIG_SetDuty(float duty_pct) {
    clamp_float(&duty_pct, 0.0f, 100.0f);
    g_duty_pct = duty_pct;

    uint32_t arr = __HAL_TIM_GET_AUTORELOAD(&htim3);
    uint32_t ccr = (uint32_t)((float)(arr + 1U) * (duty_pct * 0.01f));
    if (ccr > arr) ccr = arr;
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, ccr);
    return HAL_OK;
}

HAL_StatusTypeDef TIMER_ADC_TRIG_SetTRGO(uint32_t trgo_src) {
    return tim3_master_set_trgo(trgo_src);
}

uint32_t TIMER_ADC_TRIG_GetActualHz(void) {
    return g_actual_hz;
}

float TIMER_ADC_TRIG_GetDuty(void) {
    uint32_t arr = __HAL_TIM_GET_AUTORELOAD(&htim3);
    uint32_t ccr = __HAL_TIM_GET_COMPARE(&htim3, TIM_CHANNEL_1);
    if (arr == 0) return 0.0f;
    float pct = (100.0f * (float)ccr) / (float)(arr + 1U);
    return pct;
}

bool   TIMER_ADC_TRIG_IsRunning(void) {
    return g_started;
}
// Add after your PWM functions

HAL_StatusTypeDef TIMER_ADC_TRIG_InitBusyIC(GPIO_TypeDef *port, uint16_t pin, uint32_t af)
{
    __HAL_RCC_GPIOB_CLK_ENABLE(); // or GPIOA depending on pin

    GPIO_InitTypeDef g = {0};
    g.Pin       = pin;
    g.Mode      = GPIO_MODE_AF_PP;
    g.Pull      = GPIO_PULLUP;
    g.Speed     = GPIO_SPEED_FREQ_VERY_HIGH;
    g.Alternate = af; // AF2_TIM3
    HAL_GPIO_Init(port, &g);

    TIM_IC_InitTypeDef sConfigIC = {0};
    sConfigIC.ICPolarity  = TIM_INPUTCHANNELPOLARITY_FALLING;
    sConfigIC.ICSelection = TIM_ICSELECTION_DIRECTTI;
    sConfigIC.ICPrescaler = TIM_ICPSC_DIV1;
    sConfigIC.ICFilter    = 4;
    if (HAL_TIM_IC_ConfigChannel(&htim3, &sConfigIC, TIM_CHANNEL_2) != HAL_OK) return HAL_ERROR;

    HAL_NVIC_SetPriority(TIM3_IRQn, 5, 0);
    HAL_NVIC_EnableIRQ(TIM3_IRQn);

    return HAL_TIM_IC_Start_IT(&htim3, TIM_CHANNEL_2);
}

// Weak hook so AD7606 can subscribe
__attribute__((weak)) void TIMER_ADC_TRIG_BusyFallingCallback(void) {}


