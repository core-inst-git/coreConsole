#ifndef __I2C_H__
#define __I2C_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"
#include <stdint.h>

/* Cube/HAL handle */

/* Cube init */

/* ================= Your I2C peripherals API =================
   - TCA6424 (GPIO expander for gains)
   - SHT45   (temp/humidity)
   - Service model: CDC only sets flags, main loop calls I2C_Refresh()
*/

/* ===== Device addresses (7-bit) ===== */
#define TCA6424_ADDR     0x22u
#define SHT45_I2C_ADDR   0x45u

/* ===== TCA6424 registers ===== */
#define TCA_REG_INPUT0   0x00
#define TCA_REG_INPUT1   0x01
#define TCA_REG_INPUT2   0x02
#define TCA_REG_OUTPUT0  0x04
#define TCA_REG_OUTPUT1  0x05
#define TCA_REG_OUTPUT2  0x06
#define TCA_REG_POLINV0  0x08
#define TCA_REG_POLINV1  0x09
#define TCA_REG_POLINV2  0x0A
#define TCA_REG_CONFIG0  0x0C  /* 0=output, 1=input */
#define TCA_REG_CONFIG1  0x0D
#define TCA_REG_CONFIG2  0x0E

/* Init TCA defaults (idempotent). Call once after MX_I2C3_Init(). */
void I2C_Init(void);

/* Request a gain change asynchronously (head:1..4, val:0..7).
   Only sets globals/flags; actual I2C happens in I2C_Refresh(). */
void I2C_RequestGain(uint8_t head, uint8_t val);

/* Kick the service to run once */
void I2C_RequestRefresh(void);

/* One service pass (call from main loop when g_i2c_refresh_request!=0):
   - apply pending gain write (atomic on TCA)
   - read back TCA outputs -> g_gain.current_gain[4]
   - read SHT45 (blocking ~20 ms) -> g_env.{temperature_C, humidity_pct}
*/
void I2C_Refresh(void);

/* Optional: direct TCA latch R/W (safe from main thread, not USB ISR) */
int  TCA_WriteOutputs(uint8_t p0, uint8_t p1, uint8_t p2);
int  TCA_ReadOutputs(uint8_t *p0, uint8_t *p1, uint8_t *p2);

/* Optional: direct SHT45 blocking read (returns 1 on success) */
int  SHT_Read(float *tC, float *rhPct);

/* Internal helper (exposed in case you want immediate apply) */
int  I2C_ApplyGainNow(uint8_t head, uint8_t gain);

#ifdef __cplusplus
}
#endif

#endif /* __I2C_H__ */
