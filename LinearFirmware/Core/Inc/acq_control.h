#pragma once
/**
 * @file    acq_control.h
 * @brief   Acquisition control API for AD7606 (4 channels, signed 16-bit codes).
 *
 * This module orchestrates:
 *  - TIM3 timing (CONVST PWM / one-pulse + BUSY input-capture)
 *  - Signed data pulls from AD7606 on each BUSY falling edge
 *  - High-rate streaming of frames (4 × int16) into SDRAM
 *  - Non-destructive snapshot acquisition with on-MCU averaging to mV
 *
 * ISR integration:
 *  Call ACQ_OnBusyFallingISR() from TIM3 IRQ when BUSY (CH2) falls,
 *  after you’ve cleared the CC2 flag/IT in the IRQ handler.
 *
 * Threading/ISR notes:
 *  - All public functions are callable from thread context.
 *  - ACQ_OnBusyFallingISR() is ISR-safe and time-critical.
 *  - Snapshot and stream paths are designed not to collide: snapshots never write SDRAM.
 */

#include <stdint.h>
#include "stm32f7xx_hal.h"
#include "state_machine.h"   // provides SystemState enums + SM_* helpers

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------- */
/*                                 TIM3 hooks                                 */
/* -------------------------------------------------------------------------- */
/**
 * These are provided elsewhere in your project. ACQ_StartStream() will start
 * both the BUSY capture and the CONVST PWM; ACQ_StopStream() will stop them.
 *
 * TIM3 usage convention:
 *  - CH1: CONVST (PWM or One-Pulse)
 *  - CH2: BUSY (input-capture with falling-edge IRQ)
 *  - (Optional) CH3: external trigger/arm, handled elsewhere
 */
extern void TIM3_StartBusyCapture(void);   /**< Enable IC on BUSY (CH2) with IRQ */
extern void TIM3_StopBusyCapture(void);
extern void TIM3_StartConvstPWM(void);     /**< Enable CONVST drive (CH1)      */
extern void TIM3_StopConvstPWM(void);
void ACQ_SoftReset(void);   // <— add this


/* -------------------------------------------------------------------------- */
/*                              SDRAM configuration                           */
/* -------------------------------------------------------------------------- */
/** SDRAM size (bytes). Used for sanity checks in the C file. */
#define SDRAM_SIZE_BYTES    (32u * 1024u * 1024u)

/** One acquisition frame = 4 channels × int16. */
#define ACQ_FRAME_WORDS     4u
#define ACQ_FRAME_BYTES     (ACQ_FRAME_WORDS * sizeof(int16_t))

/** Base address for streaming buffer (FMC SDRAM, 16-bit access). */
#ifndef SDRAM_BASE_ADDR
#define SDRAM_BASE_ADDR     ((uint32_t)0xC0000000UL)
#endif

/* -------------------------------------------------------------------------- */
/*                              Debug / diagnostics                           */
/* -------------------------------------------------------------------------- */
/**
 * @brief  Return & clear ISR overrun counter.
 *         Increments when BUSY IRQ re-enters before the previous read finished.
 */
uint32_t ACQ_GetAndClearOverruns(void);

/**
 * @brief  Return & clear SPI failure counter.
 *         Increments when an SPI read times out or fails inside ISR path.
 */
uint32_t ACQ_GetAndClearSpiFailures(void);

/* -------------------------------------------------------------------------- */
/*                              Module lifecycle                              */
/* -------------------------------------------------------------------------- */
/**
 * @brief  Initialize acquisition bookkeeping and set state to IDLE.
 *         Does not touch timers or the ADC.
 */
void ACQ_Init(void);
HAL_StatusTypeDef ACQ_ArmForTrigger(uint32_t frames, uint8_t rising_edge);
void ACQ_OnTriggerEdge(void);
/* -------------------------------------------------------------------------- */
/*                              Streaming capture                             */
/* -------------------------------------------------------------------------- */
/**
 * @brief  Prepare a streaming capture of @p frames frames into SDRAM.
 *         Does not start timers (use ACQ_StartStream()).
 * @param  frames  Number of frames to collect (each frame has 4×int16 samples).
 * @retval HAL_OK on success, HAL_ERROR on invalid input (e.g., frames==0).
 */
HAL_StatusTypeDef ACQ_Arm(uint32_t frames);

/**
 * @brief  Start streaming to SDRAM: starts BUSY capture + CONVST PWM.
 *         Transitions state to ACQUIRING if previously ARMED.
 * @retval HAL_OK on success, HAL_ERROR if not ARMED.
 */
HAL_StatusTypeDef ACQ_StartStream(void);

/**
 * @brief  Stop streaming immediately. Keeps data already written to SDRAM.
 *         If previously ACQUIRING, sets state to DATA_READY.
 */
void ACQ_StopStream(void);

/* -------------------------------------------------------------------------- */
/*                                 Snapshots                                  */
/* -------------------------------------------------------------------------- */
/**
 * @brief  Begin a non-destructive snapshot of @p n frames (local RAM only).
 *         Timers are started if the system is IDLE to ensure samples arrive.
 * @param  n   Number of frames to collect (1..implementation limit).
 * @retval HAL_OK / HAL_ERROR (invalid @p n).
 */
// ---- Non-blocking snapshot API (no main-loop involvement) ----
HAL_StatusTypeDef ACQ_Snapshot_Arm(uint8_t n);          // arms N-frame snapshot; returns immediately
HAL_StatusTypeDef ACQ_Snapshot_Cancel(void);            // optional: cancel if active
uint8_t           ACQ_Snapshot_IsActive(void);          // 1 while capture in progress, else 0
uint8_t           ACQ_Snapshot_IsReady(void);           // 1 when result ready
HAL_StatusTypeDef ACQ_Snapshot_Read_adc(int32_t adc[4]);  // read and clear ready flag

/* -------------------------------------------------------------------------- */
/*                                   ISR hook                                 */
/* -------------------------------------------------------------------------- */
/**
 * @brief  BUSY-falling edge ISR entry point.
 *
 * Call this from TIM3 IRQ handler when CH2 (BUSY) falls:
 *   1) Clear CC2 IT/flag (TIMx->SR / HAL macros)
 *   2) Call ACQ_OnBusyFallingISR()
 *
 * This routine:
 *  - Pulls 4 signed samples from AD7606 (tight SPI loop)
 *  - Feeds snapshot path (if active)
 *  - Streams frame into SDRAM (if active), and stops when target is reached
 *  - Advances the state machine appropriately
 */
void ACQ_OnBusyFallingISR(void);

/* -------------------------------------------------------------------------- */
/*                                   Status                                   */
/* -------------------------------------------------------------------------- */
/** @return Non-zero while streaming is in progress. */
uint8_t  ACQ_IsStreaming(void);

/** @return Frames still to be written in the current stream (0 if idle). */
uint32_t ACQ_StreamFramesRemaining(void);

/** @return Current SDRAM write pointer (absolute address). */
uint32_t ACQ_StreamWriteAddress(void);
uint8_t  ACQ_GetChannelMask(void);
uint8_t  ACQ_GetActiveChannelCount(void);
uint8_t  ACQ_GetFrameBytes(void);
HAL_StatusTypeDef ACQ_SetChannelMask(uint8_t mask);

// --- at the end of acq_control.h public section ---
/** SDRAM base as uint8_t* (start of capture buffer) */
static inline uint8_t *ACQ_SDRAM_BaseU8(void) {
    return (uint8_t *)(uintptr_t)SDRAM_BASE_ADDR;
}

/** Current write pointer as uint8_t* (one past last written byte) */
static inline uint8_t *ACQ_SDRAM_WriteU8(void) {
    return (uint8_t *)(uintptr_t)ACQ_StreamWriteAddress();
}

HAL_StatusTypeDef AG_StartAutoSnapshot(uint8_t frames);
HAL_StatusTypeDef AG_PollAutoSnapshot(int32_t mv_out[4], uint8_t gain_out[4]);
/* -------------------------------------------------------------------------- */
/*                               Usage examples                               */
/* -------------------------------------------------------------------------- */
/*
    // 1) Initialize
    ACQ_Init();
    // (Set up TIM3, SPI5, AD7606 elsewhere)

    // 2) Single snapshot (8 frames averaged)
    int32_t mv[4];
    if (ACQ_SnapshotStartN(8) == HAL_OK &&
        ACQ_SnapshotWaitAndAverage_mV(mv, 100) == HAL_OK) {
        printf("Snapshot mV: %ld %ld %ld %ld\r\n",
               (long)mv[0], (long)mv[1], (long)mv[2], (long)mv[3]);
    }

    // 3) Stream 100k frames into SDRAM
    if (ACQ_Arm(100000) == HAL_OK && ACQ_StartStream() == HAL_OK) {
        // ... wait for STATE_DATA_READY, then read SDRAM
    }
*/

#ifdef __cplusplus
}
#endif
