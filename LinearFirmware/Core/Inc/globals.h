#ifndef GLOBALS_H
#define GLOBALS_H

#include <stdint.h>

/* -------- Environment (SHT45) -------- */
typedef struct {
    float temperature_C;
    float humidity_pct;
} EnvState;

/* -------- Gain state (TCA6424 -> your 3-bit gain per head) -------- */
typedef struct {
    uint8_t current_gain[4];     /* per head: 0..7 */
    uint8_t pending_write;       /* 1 if a write was requested */
    uint8_t gain_write_head;     /* 1..4 */
    uint8_t gain_write_val;      /* 0..7 */
} GainState;

/* Externs (define them ONCE in globals.c) */
extern EnvState  g_env;
extern GainState g_gain;
extern volatile uint8_t g_i2c_refresh_request;
/* Acquisition channel mask (bit0..bit3 => CH1..CH4), default 0x0F */
extern volatile uint8_t g_acq_channel_mask;

#endif /* GLOBALS_H */
