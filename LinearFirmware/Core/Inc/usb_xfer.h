#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

extern volatile uint8_t  *g_xfer_ptr;
extern volatile uint32_t  g_xfer_bytes;

void USB_TransferTask(void);  // call from main loop

#ifdef __cplusplus
}
#endif
