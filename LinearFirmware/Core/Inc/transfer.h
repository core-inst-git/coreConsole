// transfer.h
#pragma once
#include "stm32f7xx_hal.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define XFER_CHUNK_FRAMES   256u
#define XFER_CHUNK_BYTES    (XFER_CHUNK_FRAMES * 8u)   // 4ch * int16 = 8B per frame
#define XFER_HDR_MAGIC      0x314B4C55u                // 'ULK1'

// Init once at boot
void XFER_Init(void);

// Arm a bulk dump of exactly total_frames starting at SDRAM base.
// Sends a final 0-frame footer chunk to mark completion.
HAL_StatusTypeDef XFER_ArmDump(uint32_t total_frames);

// Called by CDC TX complete to queue next chunk/footer
void XFER_OnTxDone(void);

// Optional: remaining frames in an active dump (0 means finished; footer might still be in flight)
uint32_t XFER_FramesRemaining(void);

#ifdef __cplusplus
}
#endif
