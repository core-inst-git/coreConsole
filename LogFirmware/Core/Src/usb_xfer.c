#include "usb_xfer.h"
#include "usbd_cdc_if.h"
#include "state_machine.h"
#include "leds.h"

volatile uint8_t  *g_xfer_ptr   = 0;
volatile uint32_t  g_xfer_bytes = 0;

static inline void clean_dcache_range(const void *addr, size_t len)
{
#if (__DCACHE_PRESENT == 1)
    uintptr_t a = (uintptr_t)addr;
    uintptr_t e = a + len;
    a &= ~((uintptr_t)31);                    // 32-byte align start
    len = (size_t)((e - a + 31) & ~31u);      // 32-byte sized
    SCB_CleanDCache_by_Addr((uint32_t*)a, (int32_t)len);
#endif
}

void USB_TransferTask(void)
{
    if (SM_GetState() != STATE_TRANSFER) return;

    uint32_t remain = g_xfer_bytes;     // volatile read
    if (remain == 0) {
        SM_SetState(STATE_DATA_READY);  // done
        LED2_BlinkStop();   // 2 Hz, 50% duty

        return;
    }

    uint16_t chunk = (remain > 512u) ? 512u : (uint16_t)remain;

    clean_dcache_range((const void*)g_xfer_ptr, chunk);
    // back-pressure: only send when IN EP free
    if (CDC_Transmit_HS((uint8_t*)g_xfer_ptr, chunk) != USBD_OK)
        return; // try again next tick

    g_xfer_ptr   += chunk;
    g_xfer_bytes  = remain - chunk;     // volatile write
}
