#pragma once
#include "stm32f7xx_hal.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------- Pin mapping (edit if your PCB differs) ---------- */
#define AD7606_CS_PORT      GPIOG
#define AD7606_CS_PIN       GPIO_PIN_14
#define AD7606_RST_PORT     GPIOG
#define AD7606_RST_PIN      GPIO_PIN_13

/* We read only V1..V4 via DOUTA (single-wire serial) */
extern volatile uint8_t ad7606_frame_ready;   /* set by fast read helper */
extern int16_t          ad7606_last_frame[4]; /* last 4-channel frame    */

typedef struct {
    SPI_HandleTypeDef *hspi;     /* &hspi5 */
    GPIO_TypeDef      *cs_port;  /* AD7606_CS_PORT */
    uint16_t           cs_pin;   /* AD7606_CS_PIN */
    GPIO_TypeDef      *rst_port; /* AD7606_RST_PORT */
    uint16_t           rst_pin;  /* AD7606_RST_PIN */
    float              vfs;      /* full-scale ±V (e.g., 5.0f or 10.0f) */
} AD7606_Handle;

extern AD7606_Handle had7606;

/* ---------- API ---------- */
void AD7606_Init(AD7606_Handle *h);
void AD7606_Reset(AD7606_Handle *h);

/* Oversampling control 3-bit */
void AD7606_SetOversampling(uint8_t ratio_0_to_7);

/* Ensure SPI5: 16-bit, CPOL=0, CPHA=2nd edge, SW-NSS, prescaler /8 */
void SPI5_QuickEnsure_16bit_cpol0_cpha2_swNSS_presc8(void);

/* Read 4×16-bit (V1..V4) tightly under one CS pulse */
void AD7606_Read4Words_Fast(int16_t *dst);   /* blocking, no timeout */

/* Same, but with bounded waits; returns 1 on success, 0 on timeout */
int  AD7606_Read4Words_Tight(int16_t *dst);

/* Low-level timeout counter (tight reader); read & clear */
uint32_t AD7606_GetAndClearSpiTimeouts(void);

#ifdef __cplusplus
}
#endif
