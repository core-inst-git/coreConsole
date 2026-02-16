#include "acq_control.h"
#include "ad7606.h"
#include <string.h>
#include "main.h"
#include "globals.h"

extern TIM_HandleTypeDef htim3;

/* ======================= Config ======================= */
#define FRAME_SAMPLES   4
#define FRAME_BYTES     (FRAME_SAMPLES * (int)sizeof(int16_t))

/* If your header defines ACQ_FRAME_BYTES, keep them consistent. */
#ifndef ACQ_FRAME_BYTES
#define ACQ_FRAME_BYTES FRAME_BYTES
#endif

#define SNAP_MAX 64

/* ======================= Externals ======================= */
/* These must exist in your project */
extern void TIM3_StartConvstPWM(void);
extern void TIM3_StopConvstPWM(void);
extern void TIM3_SetFreqHz(uint32_t hz);

/* BUSY capture is TIM3 CH2 falling (HAL IC) */
static inline void Busy_StartIT(void)  { (void)HAL_TIM_IC_Start_IT(&htim3, TIM_CHANNEL_2); }
static inline void Busy_StopIT(void)   { (void)HAL_TIM_IC_Stop_IT(&htim3, TIM_CHANNEL_2); }

/* Trigger capture is TIM3 CH3 (HAL IC) */
static inline void Trig_StartIT(void)  { (void)HAL_TIM_IC_Start_IT(&htim3, TIM_CHANNEL_3); }
static inline void Trig_StopIT(void)   { (void)HAL_TIM_IC_Stop_IT(&htim3, TIM_CHANNEL_3); }

/* SPI helpers (you already have these somewhere) */
extern void SPI5_ClearRxFifo(void);
extern void CS_HIGH(void);

/* State machine (you already have this) */
extern void SM_SetState(uint8_t st);

/* ADC read (your tight read) */
extern int AD7606_Read4Words_Tight(int16_t *dst);

/* ======================= Internal state ======================= */

/* SDRAM writer */
static int16_t  *s_sdram_wr   = (int16_t *)(uintptr_t)SDRAM_BASE_ADDR;
static uint32_t  s_frames_tgt = 0;
static uint32_t  s_frames_cnt = 0;
static uint8_t   s_streaming  = 0;

/* Triggered mode flag: ADC running warm but not saving until trigger */
static uint8_t   s_armed_wait_trigger = 0;

/* Snapshot (ISR-driven averaging) */
static volatile uint8_t  s_snap_active      = 0;
static volatile uint8_t  s_snap_need        = 0;
static volatile uint8_t  s_snap_count       = 0;
static volatile uint8_t  s_snap_ready       = 0;
static volatile uint8_t  s_snap_owns_timers = 0;

static volatile int32_t  s_snap_acc0 = 0, s_snap_acc1 = 0, s_snap_acc2 = 0, s_snap_acc3 = 0;
static volatile int32_t  s_snap_avg_adc[4];

/* Diagnostics */
static volatile uint8_t  s_in_isr       = 0;
static volatile uint32_t s_overruns     = 0;
static volatile uint32_t s_spi_failures = 0;

/* ======================= Local utils ======================= */

static inline void sdram_reset_writer(void)
{
    s_sdram_wr = (int16_t *)(uintptr_t)SDRAM_BASE_ADDR;
}

static inline uint8_t popcount4(uint8_t m)
{
    return (uint8_t)((m & 1u) + ((m >> 1) & 1u) + ((m >> 2) & 1u) + ((m >> 3) & 1u));
}

uint8_t ACQ_GetChannelMask(void)
{
    uint8_t m = (uint8_t)(g_acq_channel_mask & 0x0Fu);
    return (m == 0u) ? 0x0Fu : m;
}

uint8_t ACQ_GetActiveChannelCount(void)
{
    return popcount4(ACQ_GetChannelMask());
}

uint8_t ACQ_GetFrameBytes(void)
{
    return (uint8_t)(ACQ_GetActiveChannelCount() * (uint8_t)sizeof(int16_t));
}

HAL_StatusTypeDef ACQ_SetChannelMask(uint8_t mask)
{
    SystemState st = SM_GetState();
    mask &= 0x0Fu;

    if (mask == 0u) return HAL_ERROR;
    if (s_streaming || s_armed_wait_trigger || s_snap_active) return HAL_BUSY;
    if (st == STATE_ARMED || st == STATE_ARMED_WAIT_TRIGGER || st == STATE_ACQ_ACTIVE || st == STATE_TRANSFER) return HAL_BUSY;

    __disable_irq();
    g_acq_channel_mask = mask;
    __enable_irq();
    return HAL_OK;
}

static inline void sdram_store_frame_masked(const int16_t src[4], uint8_t mask)
{
    if (mask == 0x0Fu) {
        /* Common case: all channels enabled, keep fastest path. */
        s_sdram_wr[0] = src[0];
        s_sdram_wr[1] = src[1];
        s_sdram_wr[2] = src[2];
        s_sdram_wr[3] = src[3];
        s_sdram_wr += 4;
        return;
    }

    if (mask & 0x01u) *s_sdram_wr++ = src[0];
    if (mask & 0x02u) *s_sdram_wr++ = src[1];
    if (mask & 0x04u) *s_sdram_wr++ = src[2];
    if (mask & 0x08u) *s_sdram_wr++ = src[3];
}

static inline void stop_all_timing(void)
{
    Busy_StopIT();
    Trig_StopIT();
    TIM3_StopConvstPWM();

    /* Clear pending flags to avoid stale IRQs on next start */
    __HAL_TIM_CLEAR_IT(&htim3,  TIM_IT_CC2);
    __HAL_TIM_CLEAR_FLAG(&htim3, TIM_FLAG_CC2);
    __HAL_TIM_CLEAR_IT(&htim3,  TIM_IT_CC3);
    __HAL_TIM_CLEAR_FLAG(&htim3, TIM_FLAG_CC3);
    __HAL_TIM_CLEAR_IT(&htim3,  TIM_IT_UPDATE);
    __HAL_TIM_CLEAR_FLAG(&htim3, TIM_FLAG_UPDATE);
}

/* ======================= Public API ======================= */

void ACQ_Init(void)
{
    if ((g_acq_channel_mask & 0x0Fu) == 0u) {
        g_acq_channel_mask = 0x0Fu;
    }

    sdram_reset_writer();
    s_frames_tgt = 0;
    s_frames_cnt = 0;
    s_streaming  = 0;
    s_armed_wait_trigger = 0;

    s_snap_active = 0;
    s_snap_need   = 0;
    s_snap_count  = 0;
    s_snap_ready  = 0;
    s_snap_owns_timers = 0;

    s_overruns     = 0;
    s_spi_failures = 0;

    /* ADC init if needed */
    AD7606_Init(&had7606);

    /* Default sample freq */
    TIM3_SetFreqHz(50000);

    SM_SetState(STATE_IDLE);
}

HAL_StatusTypeDef ACQ_Arm(uint32_t frames)
{
    if (frames == 0) return HAL_ERROR;

    const uint32_t frame_bytes = (uint32_t)ACQ_GetFrameBytes();
    const uint32_t max_frames = SDRAM_SIZE_BYTES / frame_bytes;
    if (frames > max_frames) return HAL_ERROR;

    /* You can’t arm while armed-wait-trigger is active */
    if (s_armed_wait_trigger) return HAL_BUSY;

    sdram_reset_writer();
    s_frames_tgt = frames;
    s_frames_cnt = 0;
    s_streaming  = 0;

    SM_SetState(STATE_ARMED);
    return HAL_OK;
}

HAL_StatusTypeDef ACQ_StartStream(void)
{
    if (s_frames_tgt == 0) return HAL_ERROR;
    if (s_armed_wait_trigger) return HAL_BUSY;

    /* Reset writer & counters */
    sdram_reset_writer();
    s_frames_cnt = 0;
    s_streaming  = 1;

    /* Clean SPI state before first read */
    SPI5_ClearRxFifo();
    CS_HIGH();

    /* Enable BUSY capture + start conversions */
    __HAL_TIM_CLEAR_IT(&htim3,  TIM_IT_CC2);
    __HAL_TIM_CLEAR_FLAG(&htim3, TIM_FLAG_CC2);

    Busy_StartIT();
    TIM3_StartConvstPWM();

    SM_SetState(STATE_ACQ_ACTIVE);
    return HAL_OK;
}

/* Arm capture that will START saving on first external edge on TIM3 CH3.
   IMPORTANT: we start CONVST PWM immediately (warm ADC), but we do NOT save
   until trigger arrives. This removes “first few frames weirdness”. */
HAL_StatusTypeDef ACQ_ArmForTrigger(uint32_t frames, uint8_t rising_edge)
{
    if (frames == 0) return HAL_ERROR;

    const uint32_t frame_bytes = (uint32_t)ACQ_GetFrameBytes();
    const uint32_t max_frames = SDRAM_SIZE_BYTES / frame_bytes;
    if (frames > max_frames) return HAL_ERROR;

    if (ACQ_IsStreaming()) return HAL_BUSY;
    if (s_snap_active)     return HAL_BUSY;

    /* Stop everything first */
    stop_all_timing();

    /* Reset SDRAM */
    sdram_reset_writer();
    s_frames_tgt = frames;
    s_frames_cnt = 0;
    s_streaming  = 0;

    /* Mark “armed waiting trigger” */
    s_armed_wait_trigger = 1;

    /* Clean SPI */
    SPI5_ClearRxFifo();
    CS_HIGH();

    /* Configure CH3 edge */
    TIM_IC_InitTypeDef sIC = {0};
    sIC.ICPolarity  = rising_edge ? TIM_INPUTCHANNELPOLARITY_RISING
                                  : TIM_INPUTCHANNELPOLARITY_FALLING;
    sIC.ICSelection = TIM_ICSELECTION_DIRECTTI;
    sIC.ICPrescaler = TIM_ICPSC_DIV1;
    sIC.ICFilter    = 0;

    if (HAL_TIM_IC_ConfigChannel(&htim3, &sIC, TIM_CHANNEL_3) != HAL_OK)
        return HAL_ERROR;

    __HAL_TIM_CLEAR_IT(&htim3,  TIM_IT_CC3);
    __HAL_TIM_CLEAR_FLAG(&htim3, TIM_FLAG_CC3);

    /* Enable trigger IRQ */
    Trig_StartIT();

    /* Start conversions now (warm-up), but BUSY IRQ stays OFF until trigger */
    TIM3_StartConvstPWM();

    SM_SetState(STATE_ARMED_WAIT_TRIGGER);
    return HAL_OK;
}

/* Called by TIM3 IRQ when the trigger edge (CH3) fires */
void ACQ_OnTriggerEdge(void)
{
    if (!s_armed_wait_trigger) return;
    if (s_streaming) return;

    /* Disable further trigger edges (single-shot) */
    Trig_StopIT();

    /* Clear BUSY pending and enable BUSY IRQ now */
    __HAL_TIM_CLEAR_IT(&htim3,  TIM_IT_CC2);
    __HAL_TIM_CLEAR_FLAG(&htim3, TIM_FLAG_CC2);

    Busy_StartIT();

    /* Start saving from next BUSY-falling ISR */
    s_frames_cnt = 0;
    s_streaming  = 1;
    s_armed_wait_trigger = 0;

    SM_SetState(STATE_ACQ_ACTIVE);
}

void ACQ_StopStream(void)
{
    stop_all_timing();

    s_streaming = 0;
    s_armed_wait_trigger = 0;

    SM_SetState(STATE_DATA_READY);
}

void ACQ_SoftReset(void)
{
    __disable_irq();

    stop_all_timing();

    /* Cancel snapshot */
    s_snap_active = 0;
    s_snap_ready  = 0;
    s_snap_owns_timers = 0;

    /* Reset stream state */
    sdram_reset_writer();
    s_frames_tgt = 0;
    s_frames_cnt = 0;
    s_streaming  = 0;
    s_armed_wait_trigger = 0;

    /* Diagnostics */
    s_overruns     = 0;
    s_spi_failures = 0;

    __enable_irq();

    SM_SetState(STATE_IDLE);
}

/* ======================= Snapshot ======================= */

HAL_StatusTypeDef ACQ_Snapshot_Arm(uint8_t n)
{
    if (n == 0 || n > SNAP_MAX) return HAL_ERROR;

    /* Don’t allow snapshot during streaming or armed-wait-trigger warm-up */
    if (ACQ_IsStreaming()) return HAL_BUSY;
    if (s_armed_wait_trigger) return HAL_BUSY;

    __disable_irq();
    s_snap_need   = n;
    s_snap_count  = 0;
    s_snap_ready  = 0;
    s_snap_acc0 = s_snap_acc1 = s_snap_acc2 = s_snap_acc3 = 0;
    s_snap_active = 1;
    s_snap_owns_timers = 0;
    __enable_irq();

    /* Start timing so ISR runs */
    SPI5_ClearRxFifo();
    CS_HIGH();

    __HAL_TIM_CLEAR_IT(&htim3,  TIM_IT_CC2);
    __HAL_TIM_CLEAR_FLAG(&htim3, TIM_FLAG_CC2);

    Busy_StartIT();
    TIM3_StartConvstPWM();
    s_snap_owns_timers = 1;

    return HAL_OK;
}

HAL_StatusTypeDef ACQ_Snapshot_Cancel(void)
{
    __disable_irq();
    s_snap_active = 0;
    s_snap_ready  = 0;
    __enable_irq();

    if (s_snap_owns_timers) {
        stop_all_timing();
        s_snap_owns_timers = 0;
    }
    return HAL_OK;
}

uint8_t ACQ_Snapshot_IsActive(void) { return s_snap_active; }
uint8_t ACQ_Snapshot_IsReady(void)  { return s_snap_ready;  }

HAL_StatusTypeDef ACQ_Snapshot_Read_adc(int32_t adc[4])
{
    if (!s_snap_ready) return HAL_BUSY;

    __disable_irq();
    adc[0] = s_snap_avg_adc[0];
    adc[1] = s_snap_avg_adc[1];
    adc[2] = s_snap_avg_adc[2];
    adc[3] = s_snap_avg_adc[3];
    s_snap_ready = 0;
    __enable_irq();

    return HAL_OK;
}

/* ======================= ISR hook ======================= */
/* Call this from TIM3 IRQ when CC2 (BUSY falling) fires, after clearing flags */
void ACQ_OnBusyFallingISR(void)
{
    if (s_in_isr) { s_overruns++; return; }
    s_in_isr = 1;

    int16_t raw[FRAME_SAMPLES];

    if (!AD7606_Read4Words_Tight(raw)) {
        s_spi_failures++;
        s_in_isr = 0;
        return;
    }

    /* Snapshot accumulation (runs even if not streaming) */
    if (s_snap_active && !s_snap_ready) {
        s_snap_acc0 += raw[0];
        s_snap_acc1 += raw[1];
        s_snap_acc2 += raw[2];
        s_snap_acc3 += raw[3];

        uint8_t c = ++s_snap_count;
        if (c >= s_snap_need) {
            s_snap_avg_adc[0] = (int16_t)(s_snap_acc0 / (int32_t)c);
            s_snap_avg_adc[1] = (int16_t)(s_snap_acc1 / (int32_t)c);
            s_snap_avg_adc[2] = (int16_t)(s_snap_acc2 / (int32_t)c);
            s_snap_avg_adc[3] = (int16_t)(s_snap_acc3 / (int32_t)c);

            s_snap_active = 0;
            s_snap_ready  = 1;

            if (s_snap_owns_timers) {
                stop_all_timing();
                s_snap_owns_timers = 0;
            }
        }
    }

    /* Streaming store */
    if (s_streaming) {
        const uint8_t mask = ACQ_GetChannelMask();
        sdram_store_frame_masked(raw, mask);
        s_frames_cnt++;

        if (s_frames_cnt >= s_frames_tgt) {
            stop_all_timing();
            s_streaming = 0;
            SM_SetState(STATE_DATA_READY);
        }
    }

    s_in_isr = 0;
}

/* ======================= Status / diagnostics ======================= */

uint8_t  ACQ_IsStreaming(void)           { return s_streaming; }
uint32_t ACQ_StreamFramesRemaining(void) { return (s_frames_tgt > s_frames_cnt) ? (s_frames_tgt - s_frames_cnt) : 0; }
uint32_t ACQ_StreamWriteAddress(void)    { return (uint32_t)(uintptr_t)s_sdram_wr; }

uint32_t ACQ_GetAndClearOverruns(void)     { uint32_t v = s_overruns;     s_overruns = 0;     return v; }
uint32_t ACQ_GetAndClearSpiFailures(void)  { uint32_t v = s_spi_failures; s_spi_failures = 0; return v; }
