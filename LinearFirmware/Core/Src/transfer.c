#include "transfer.h"
#include "acq_control.h"
#include "usbd_cdc_if.h"
#include <string.h>

extern USBD_HandleTypeDef hUsbDeviceHS;

// Read cursor and remaining
static const int16_t *s_sdram_rd = (const int16_t *)(uintptr_t)SDRAM_BASE_ADDR;
static uint32_t s_frames_left    = 0;

// Double buffer for header + payload
typedef struct {
    uint32_t magic;   // XFER_HDR_MAGIC
    uint16_t nframes; // payload frames, 0 = footer
    uint16_t rsv;
    uint8_t  payload[XFER_CHUNK_BYTES];
} __attribute__((packed, aligned(4))) chunk_t;

static chunk_t txA, txB;
static chunk_t *s_cur = &txA, *s_alt = &txB;

static volatile uint8_t s_tx_busy     = 0;
static volatile uint8_t s_need_footer = 0;

static int queue_chunk(uint32_t frames_to_send)
{
    if (s_tx_busy) return 0;

    // Footer?
    if (frames_to_send == 0) {
        s_cur->magic   = XFER_HDR_MAGIC;
        s_cur->nframes = 0;
        s_cur->rsv     = 0;
        uint16_t len = sizeof(uint32_t)+sizeof(uint16_t)+sizeof(uint16_t);
        if (CDC_Transmit_HS((uint8_t*)s_cur, len) == USBD_OK) {
            s_tx_busy = 1;
            chunk_t *t = s_cur; s_cur = s_alt; s_alt = t;
            s_need_footer = 0;
            return 1;
        }
        return 0;
    }

    uint32_t nf = frames_to_send;
    if (nf > XFER_CHUNK_FRAMES) nf = XFER_CHUNK_FRAMES;
    uint32_t bytes = nf * 8u;

    // Invalidate DCache for SDRAM read
    const uint8_t *src = (const uint8_t *)s_sdram_rd;
    uint32_t addr = ((uint32_t)(uintptr_t)src) & ~31u;
    uint32_t span = ((uint32_t)(uintptr_t)src + bytes + 31u) - addr;
    SCB_InvalidateDCache_by_Addr((uint32_t*)addr, (int32_t)span);

    // Header + payload
    s_cur->magic   = XFER_HDR_MAGIC;
    s_cur->nframes = (uint16_t)nf;
    s_cur->rsv     = 0;
    memcpy(s_cur->payload, src, bytes);

    // Advance
    s_sdram_rd    += nf * 4u;
    s_frames_left  = (s_frames_left >= nf) ? (s_frames_left - nf) : 0;

    uint16_t total = (uint16_t)(sizeof(uint32_t)+sizeof(uint16_t)+sizeof(uint16_t) + bytes);
    if (CDC_Transmit_HS((uint8_t*)s_cur, total) == USBD_OK) {
        s_tx_busy = 1;
        chunk_t *t = s_cur; s_cur = s_alt; s_alt = t;
        return 1;
    }
    return 0;
}

void XFER_Init(void)
{
    s_sdram_rd = (const int16_t *)(uintptr_t)SDRAM_BASE_ADDR;
    s_frames_left = 0;
    s_tx_busy = 0;
    s_need_footer = 0;
}

HAL_StatusTypeDef XFER_ArmDump(uint32_t total_frames)
{
    s_sdram_rd     = (const int16_t *)(uintptr_t)SDRAM_BASE_ADDR;
    s_frames_left  = total_frames;
    s_tx_busy      = 0;
    s_need_footer  = 1;  // will send a 0-frame footer at the end

    // Kick first chunk; rest continues on TX-complete
    (void)queue_chunk(s_frames_left ? s_frames_left : 0);
    return HAL_OK;
}

void XFER_OnTxDone(void)
{
    s_tx_busy = 0;

    if (s_frames_left) {
        (void)queue_chunk(s_frames_left);
        return;
    }
    if (s_need_footer) {
        (void)queue_chunk(0);
        return;
    }
    // done (no-op)
}

uint32_t XFER_FramesRemaining(void)
{
    return s_frames_left;
}
