/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : usbd_cdc_if.c
  * @version        : v1.0_Cube
  * @brief          : Usb device for Virtual Com Port.
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2025 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "usbd_cdc_if.h"

/* USER CODE BEGIN INCLUDE */
#include <string.h>
#include <ctype.h>
#include "state_machine.h"   // for SM_GetStateString() or SM_GetState()
#include "acq_control.h"   // ACQ_Snapshot_Once_mV, ACQ_SnapshotStartN, ...
#include "transfer.h"
#include "usb_xfer.h"
#include "globals.h"
#include "i2c.h"
#include "calib.h"
#include "main.h"




/* USER CODE END INCLUDE */

/* Private typedef -----------------------------------------------------------*/
/* Private define ------------------------------------------------------------*/
/* Private macro -------------------------------------------------------------*/

/* USER CODE BEGIN PV */
/* Private variables ---------------------------------------------------------*/
static char   g_tx_line[96];          // persistent TX buffer (CDC uses pointer asynchronously)
static char   g_cmd_buf[96];          // accumulate one ASCII line here
static size_t g_cmd_len = 0;

static void send_line(const char *prefix, const char *payload);
static void to_upper_inplace(char *s);
static char *trim_inplace(char *s);
static void process_cmd(char *line);
static void send_line(const char *prefix, const char *payload);
static void to_upper_inplace(char *s);
static char *trim_inplace(char *s);
static void process_cmd(char *line);
static int  parse_u32(const char *s, uint32_t *out);
static char *append_s32(char *dst, char *end, int32_t v);
#include "stm32f7xx_hal.h"
extern uint32_t g_dfu_request_flag;

/* USER CODE END PV */

/** @addtogroup STM32_USB_OTG_DEVICE_LIBRARY
  * @brief Usb device library.
  * @{
  */

/** @addtogroup USBD_CDC_IF
  * @{
  */

/** @defgroup USBD_CDC_IF_Private_TypesDefinitions USBD_CDC_IF_Private_TypesDefinitions
  * @brief Private types.
  * @{
  */

/* USER CODE BEGIN PRIVATE_TYPES */

/* USER CODE END PRIVATE_TYPES */

/**
  * @}
  */

/** @defgroup USBD_CDC_IF_Private_Defines USBD_CDC_IF_Private_Defines
  * @brief Private defines.
  * @{
  */

/* USER CODE BEGIN PRIVATE_DEFINES */
/* USER CODE END PRIVATE_DEFINES */

/**
  * @}
  */

/** @defgroup USBD_CDC_IF_Private_Macros USBD_CDC_IF_Private_Macros
  * @brief Private macros.
  * @{
  */

/* USER CODE BEGIN PRIVATE_MACRO */

typedef enum { MODE_IDLE=0, MODE_TX, MODE_RX } usb_mode_t;

static usb_mode_t g_mode = MODE_IDLE;
static const uint8_t *g_src = NULL;  // what to send
static uint32_t g_len = 0;           // total bytes to send
static uint32_t g_off = 0;           // progress

// Optional scratch for tests
uint8_t UserRxBufferHS[APP_RX_DATA_SIZE];
uint8_t UserTxBufferHS[APP_TX_DATA_SIZE];
/* === SDRAM symbols we already have === */
extern uint32_t ACQ_StreamWriteAddress(void);
#ifndef SDRAM_BASE_ADDR
#define SDRAM_BASE_ADDR   ((uint32_t)0xC0000000UL)
#endif

/* === 512-byte blocking sender === */
#define XFER_CHUNK  512u

volatile uint8_t  xfer_ptr   = 0;
volatile uint32_t  xfer_bytes = 0;

static void cdc_blocking_tx(const uint8_t *buf, uint16_t len)
{
  // Wait out USBD_BUSY; do NOT call from ISR
  while (CDC_Transmit_HS((uint8_t*)buf, len) == USBD_BUSY) {
    // optional: __NOP();
  }
}
// Optional helper: send a short line (safe for small messages)
static void send_str(const char* s) {
    while (CDC_Transmit_HS((uint8_t*)s, (uint16_t)strlen(s)) == USBD_BUSY) {
        // short spin; HS is fast
    }
}




/* USER CODE END PRIVATE_MACRO */

/**
  * @}
  */

/** @defgroup USBD_CDC_IF_Private_Variables USBD_CDC_IF_Private_Variables
  * @brief Private variables.
  * @{
  */

/* Create buffer for reception and transmission           */
/* It's up to user to redefine and/or remove those define */
/** Received data over USB are stored in this buffer      */
uint8_t UserRxBufferHS[APP_RX_DATA_SIZE];

/** Data to send over USB CDC are stored in this buffer   */
uint8_t UserTxBufferHS[APP_TX_DATA_SIZE];

/* USER CODE BEGIN PRIVATE_VARIABLES */

/* USER CODE END PRIVATE_VARIABLES */

/**
  * @}
  */

/** @defgroup USBD_CDC_IF_Exported_Variables USBD_CDC_IF_Exported_Variables
  * @brief Public variables.
  * @{
  */

extern USBD_HandleTypeDef hUsbDeviceHS;

/* USER CODE BEGIN EXPORTED_VARIABLES */

/* USER CODE END EXPORTED_VARIABLES */

/**
  * @}
  */

/** @defgroup USBD_CDC_IF_Private_FunctionPrototypes USBD_CDC_IF_Private_FunctionPrototypes
  * @brief Private functions declaration.
  * @{
  */

static int8_t CDC_Init_HS(void);
static int8_t CDC_DeInit_HS(void);
static int8_t CDC_Control_HS(uint8_t cmd, uint8_t* pbuf, uint16_t length);
static int8_t CDC_Receive_HS(uint8_t* pbuf, uint32_t *Len);
static int8_t CDC_TransmitCplt_HS(uint8_t *pbuf, uint32_t *Len, uint8_t epnum);

/* USER CODE BEGIN PRIVATE_FUNCTIONS_DECLARATION */

// Convert unsigned 32-bit to decimal ASCII (no leading zeros)
// dst must be large enough (>= 11 bytes)
// ---------- ultra-lean helpers (no malloc, no printf, no floats) ----------
static void u32_to_dec(char *dst, size_t dstsz, uint32_t v)
{
    if (!dstsz) return;
    char tmp[16]; int n = 0;
    if (v == 0) { if (dstsz>1){dst[0]='0';dst[1]=0;} else dst[0]=0; return; }
    while (v && n < (int)sizeof(tmp)) { tmp[n++] = (char)('0' + (v % 10u)); v /= 10u; }
    size_t i = 0;
    while (n && i + 1 < dstsz) dst[i++] = tmp[--n];
    dst[i] = 0;
}

static int parse_u32(const char *s, uint32_t *out)
{
    while (*s==' '||*s=='\t') ++s;
    if (*s=='+') ++s;
    uint64_t acc=0; int any=0;
    while (*s>='0' && *s<='9') { acc = acc*10u + (uint32_t)(*s - '0'); if (acc>0xFFFFFFFFULL) return 0; any=1; ++s; }
    while (*s==' '||*s=='\t') ++s;
    if (*s!=0 || !any) return 0;
    *out = (uint32_t)acc; return 1;
}

static int parse_u4mask(const char *s, uint8_t *out)
{
    while (*s == ' ' || *s == '\t') ++s;

    uint32_t base = 10u;
    if (s[0] == '0' && (s[1] == 'X' || s[1] == 'x')) {
        base = 16u;
        s += 2;
    }

    uint32_t acc = 0;
    int any = 0;
    while (*s) {
        uint32_t d;
        if (*s >= '0' && *s <= '9') d = (uint32_t)(*s - '0');
        else if (*s >= 'A' && *s <= 'F') d = (uint32_t)(*s - 'A' + 10);
        else if (*s >= 'a' && *s <= 'f') d = (uint32_t)(*s - 'a' + 10);
        else break;

        if (d >= base) return 0;
        acc = (acc * base) + d;
        if (acc > 0x0Fu) return 0;
        any = 1;
        ++s;
    }

    while (*s == ' ' || *s == '\t') ++s;
    if (!any || *s != 0) return 0;

    *out = (uint8_t)acc;
    return 1;
}

// trim both ends in-place
static char *trim_inplace(char *s)
{
    while (*s==' '||*s=='\t'||*s=='\r'||*s=='\n') ++s;
    if (*s==0) return s;
    char *e = s + strlen(s) - 1;
    while (e>=s && (*e==' '||*e=='\t'||*e=='\r'||*e=='\n')) *e-- = 0;
    return s;
}

// uppercase ASCII in-place (small & fast)
static void to_upper_inplace(char *s)
{
    for (; *s; ++s) if (*s>='a' && *s<='z') *s = (char)(*s - 'a' + 'A');
}

// send "prefix + payload + CRLF" with CDC back-pressure
static void send_line(const char *prefix, const char *payload)
{
    size_t n = 0;
    if (prefix) while (*prefix && n + 2 < sizeof(g_tx_line)) g_tx_line[n++] = *prefix++;
    if (payload) while (*payload && n + 2 < sizeof(g_tx_line)) g_tx_line[n++] = *payload++;
    g_tx_line[n++] = '\r'; g_tx_line[n++] = '\n';
    while (CDC_Transmit_HS((uint8_t*)g_tx_line, (uint16_t)n) == USBD_BUSY) { /* spin */ }
}

// write four int32 (mV) as "a b c d"
static void write_four_i32(char *dst, size_t dstsz, const int32_t v[4])
{
    size_t n = 0;
    char num[16];
    for (int i=0;i<4;i++){
        if (i && n+1<dstsz) dst[n++]=' ';
        int32_t x=v[i];
        if (x<0){ if(n+1<dstsz) dst[n++]='-'; x=-x; }
        u32_to_dec(num,sizeof num,(uint32_t)x);
        for(char *p=num; *p && n+1<dstsz; ++p) dst[n++]=*p;
    }
    if (n<dstsz) dst[n]=0;
}

/* Local helper: flush/clear USB CDC IN/OUT safely */
static void USB_CDC_Clear(void)
{
    // Flush low-level endpoints (use class defines for EP addresses)
#ifdef CDC_IN_EP
    (void)USBD_LL_FlushEP(&hUsbDeviceHS, CDC_IN_EP);
#endif
#ifdef CDC_OUT_EP
    (void)USBD_LL_FlushEP(&hUsbDeviceHS, CDC_OUT_EP);
#endif

    // Reset class state if available
    USBD_CDC_HandleTypeDef *hcdc =
        (USBD_CDC_HandleTypeDef*)hUsbDeviceHS.pClassData;
    if (hcdc) {
        hcdc->TxState   = 0U;
#if (USBD_CDC_MULTIBUFFER_ENABLED == 1)
        hcdc->TxState_2 = 0U;
#endif
        // Re-arm OUT EP to receive again
        USBD_CDC_SetRxBuffer(&hUsbDeviceHS, (uint8_t*)UserRxBufferHS);
        USBD_CDC_ReceivePacket(&hUsbDeviceHS);
    }
}

/* Public: perform a full "soft reset" */
void Core_SoftReset(void)
{
    __disable_irq();

    // 1) Stop any acquisition-related timers/IRQs
    TIM3_StopBusyCapture();
    TIM3_StopConvstPWM();
    // If you enabled specific CH IRQs elsewhere, stop them too:
    // HAL_TIM_IC_Stop_IT(&htim3, TIM_CHANNEL_2);
    // HAL_TIM_IC_Stop_IT(&htim3, TIM_CHANNEL_3);

    // 2) Cancel snapshot (if active)
    (void)ACQ_Snapshot_Cancel();

    // 3) Stop streaming and reset SDRAM write pointer/counters
    //    (Re-use your existing ACQ init semantics but keep ADC init untouched)
    {
        extern int16_t *s_sdram_wr;
        extern uint32_t s_frames_tgt, s_frames_cnt;
        extern uint8_t  s_streaming;

        s_sdram_wr   = (int16_t *)(uintptr_t)SDRAM_BASE_ADDR;
        s_frames_tgt = 0;
        s_frames_cnt = 0;
        s_streaming  = 0;
    }

    // 4) Kill any in-flight USB transfer task
    g_xfer_ptr   = 0;
    g_xfer_bytes = 0;

    __enable_irq();

    // 5) Flush USB buffers / reset CDC state
    USB_CDC_Clear();

    // 6) Return to IDLE
    SM_SetState(STATE_IDLE);
}

#include "stm32f7xx_hal.h"
extern ADC_HandleTypeDef hadc1;   // CubeMX-generated

static float _read_die_temp_once(void)
{
    ADC_ChannelConfTypeDef s = {0};

    (void)HAL_ADC_Stop(&hadc1);

    s.Channel      = ADC_CHANNEL_TEMPSENSOR;
    s.Rank         = ADC_REGULAR_RANK_1;
    s.SamplingTime = ADC_SAMPLETIME_480CYCLES;   // safe long sample
    s.Offset       = 0;
    if (HAL_ADC_ConfigChannel(&hadc1, &s) != HAL_OK) return -1000.0f;

    if (HAL_ADC_Start(&hadc1) != HAL_OK) return -1000.0f;
    if (HAL_ADC_PollForConversion(&hadc1, 10) != HAL_OK) return -1000.0f;
    uint32_t raw = HAL_ADC_GetValue(&hadc1);
    HAL_ADC_Stop(&hadc1);

    // Typical constants (use TS_CAL for accuracy if you want)
    const float VDDA      = 3.3f;
    const float V25       = 0.76f;     // V @ 25C
    const float AVG_SLOPE = 0.0025f;   // 2.5 mV/°C
    float v_sense = (raw / 4095.0f) * VDDA;
    return ((v_sense - V25) / AVG_SLOPE) + 25.0f;
}

// tiny helper: format one decimal without pulling in printf float
static void _format_1dec(char *dst, size_t dstsz, float x)
{
    int neg = (x < 0.0f);
    if (neg) x = -x;
    int d10 = (int)(x * 10.0f + 0.5f);
    int ip  = d10 / 10;
    int fp  = d10 % 10;
    size_t n = 0;
    if (neg && n+1<dstsz) dst[n++]='-';
    // write ip
    char tmp[12]; int k=0; if (ip==0) tmp[k++]='0';
    while (ip>0 && k<(int)sizeof(tmp)) { tmp[k++] = '0'+(ip%10); ip/=10; }
    while (k && n+1<dstsz) dst[n++] = tmp[--k];
    if (n+2<dstsz) { dst[n++]='.'; dst[n++] = (char)('0'+fp); }
    if (n<dstsz) dst[n]=0;
}

// ---------- command processor (compact & non-blocking) ----------
static void process_cmd(char *line)
{
    char *s = trim_inplace(line);
    to_upper_inplace(s);

    // ---- simple single-token queries ----
    if (strcmp(s, "IDN?") == 0)     { send_line("OK ", "CoreDAQ_Mk1_InGaAs_LINEAR_FW_v4.0_SNX0001"); return; }
    if (strcmp(s, "ABOUT?") == 0)     { send_line("OK ", "Designed_Developed_Ravi_Pradip"); return; }
    if (strcmp(s, "DFU") == 0)     {
    	send_line("OK ", "Entering Firmware Update Mode..");
    	g_dfu_request_flag = 0xDEADBEEF;
    	//HAL_GPIO_WritePin(GPIOB, GPIO_PIN_12, GPIO_PIN_SET);
    	__DSB();
		__ISB();
		__disable_irq();
		NVIC_SystemReset();    // on next boot, main() will jump to DFU
    	return; }

    if (strcmp(s, "STREAM?") == 0)  { send_line("OK ", ACQ_IsStreaming() ? "STREAMING" : "IDLE"); return; }
    if (strcmp(s, "LEFT?") == 0)    { char b[16]; u32_to_dec(b, sizeof b, ACQ_StreamFramesRemaining()); send_line("OK ", b); return; }
    if (strcmp(s, "CHMASK?") == 0)  {
        char buf[48];
        uint8_t m  = ACQ_GetChannelMask();
        uint8_t ch = ACQ_GetActiveChannelCount();
        uint8_t fb = ACQ_GetFrameBytes();
        (void)snprintf(buf, sizeof buf, "0x%X CH=%u FB=%u", (unsigned)m, (unsigned)ch, (unsigned)fb);
        send_line("OK ", buf);
        return;
    }
    if (strncmp(s, "CHMASK ", 7) == 0) {
        uint8_t mask = 0;
        if (!parse_u4mask(s + 7, &mask) || mask == 0u) { send_line("ERR ", "BAD_PARAM"); return; }
        HAL_StatusTypeDef st = ACQ_SetChannelMask(mask);
        if (st == HAL_OK) {
            char buf[48];
            uint8_t ch = ACQ_GetActiveChannelCount();
            uint8_t fb = ACQ_GetFrameBytes();
            (void)snprintf(buf, sizeof buf, "0x%X CH=%u FB=%u", (unsigned)mask, (unsigned)ch, (unsigned)fb);
            send_line("OK ", buf);
        } else {
            send_line("ERR ", "BUSY");
        }
        return;
    }

    if (strcmp(s, "ADDR?") == 0) {
        char b[12];                      // "0x" + 8 hex + NUL
        uint32_t a = ACQ_StreamWriteAddress();
        static const char hx[] = "0123456789ABCDEF";
        b[0] = '0'; b[1] = 'x';
        for (int i = 7; i >= 0; --i) b[2 + 7 - i] = hx[(a >> (i * 4)) & 0xF];
        b[10] = 0;
        send_line("OK ", b);
        return;
    }

    if (s[0]=='H' && s[1]=='E' && s[2]=='A' && s[3]=='D' && s[4]=='_' &&
        s[5]=='T' && s[6]=='Y' && s[7]=='P' && s[8]=='E' && s[9]=='?' &&
        s[10]==0)
    {
    	send_line("OK ", "TYPE=LINEAR");
        return;
    }

    // ---- Gain control (service-based) ----
    // GAIN <head> <val>

    if (strncmp(s, "GAIN ", 5) == 0) {
        const char *p = s + 5; while (*p == ' ' || *p == '\t') ++p;
        uint32_t head = 0, val = 0;

        const char *p0 = p; while (*p && *p != ' ' && *p != '\t') ++p;
        char save = *p; *(char*)p = 0;
        if (!parse_u32(p0, &head)) { *(char*)p = save; send_line("ERR ", "BAD_PARAM"); return; }
        *(char*)p = save; while (*p == ' ' || *p == '\t') ++p;
        if (!parse_u32(p, &val))   { send_line("ERR ", "BAD_PARAM"); return; }

        if (head < 1 || head > 4 || val > 7) { send_line("ERR ", "BAD_PARAM"); return; }
        I2C_RequestGain((uint8_t)head, (uint8_t)val);
        send_line("OK ", "GAIN_PENDING");
        return;
    }

    // I2C REFRESH  (kick the service to run once)
    if (strcmp(s, "I2C REFRESH") == 0) {
        I2C_RequestRefresh();  // sets the flag; handled in main loop
        send_line("OK ", "REFRESH_PENDING");
        return;
    }

    // GAIN? <head>
    if (strncmp(s, "GAIN?", 5) == 0) {
        const char *p = s + 5; while (*p == ' ' || *p == '\t') ++p;
        uint32_t head = 0;
        if (!parse_u32(p, &head) || head < 1 || head > 4) { send_line("ERR ", "BAD_PARAM"); return; }
        char num[8] = {0}; u32_to_dec(num, sizeof num, g_gain.current_gain[head - 1]);
        send_line("OK ", num);
        return;
    }

    // GAINS?
    if (strcmp(s, "GAINS?") == 0) {
        char buf[64];
        (void)snprintf(buf, sizeof buf, "h1=%u h2=%u h3=%u h4=%u",
                       (unsigned)g_gain.current_gain[0],
                       (unsigned)g_gain.current_gain[1],
                       (unsigned)g_gain.current_gain[2],
                       (unsigned)g_gain.current_gain[3]);
        send_line("OK ", buf);
        return;
    }

    // FACTORY_ZEROS?
    if (strcmp(s, "FACTORY_ZEROS?") == 0) {
        char buf[64];
        (void)snprintf(buf, sizeof buf,
                       "h1=%u h2=%u h3=%u h4=%u",
                       (unsigned)factory_zero_adc[0],
                       (unsigned)factory_zero_adc[1],
                       (unsigned)factory_zero_adc[2],
                       (unsigned)factory_zero_adc[3]);
        send_line("OK ", buf);
        return;
    }

    // TEMP?
    if (strcmp(s, "TEMP?") == 0) {
        char buf[32];
        int t10 = (int)(g_env.temperature_C * 10.0f + (g_env.temperature_C >= 0 ? 0.5f : -0.5f));
        snprintf(buf, sizeof buf, "%d.%d", t10 / 10, (t10 < 0 ? -t10 : t10) % 10);
        send_line("OK ", buf);
        return;
    }

    // HUM?
    if (strcmp(s, "HUM?") == 0) {
        char buf[32];
        int h10 = (int)(g_env.humidity_pct * 10.0f + 0.5f);
        snprintf(buf, sizeof buf, "%d.%d", h10 / 10, h10 % 10);
        send_line("OK ", buf);
        return;
    }

    // ---- Oversampling (OS? / OS <n>) ----
    if (s[0] == 'O' && s[1] == 'S' && (s[2] == 0 || s[2] == ' ' || s[2] == '\t' || s[2] == '?')) {
        const char *p = s + 2; while (*p == ' ' || *p == '\t') ++p;

        if (*p == '?') {
            uint8_t b0 = (HAL_GPIO_ReadPin(GPIOB, OS0_Pin) == GPIO_PIN_SET) ? 1u : 0u;
            uint8_t b1 = (HAL_GPIO_ReadPin(GPIOB, OS1_Pin) == GPIO_PIN_SET) ? 1u : 0u;
            uint8_t b2 = (HAL_GPIO_ReadPin(GPIOB, OS2_Pin) == GPIO_PIN_SET) ? 1u : 0u;
            uint32_t ratio = (uint32_t)(b0 | (b1 << 1) | (b2 << 2));
            char num[4]; u32_to_dec(num, sizeof num, ratio);
            send_line("OK ", num);
            return;
        }

        uint32_t n = 0;
        if (!parse_u32(p, &n) || n > 7u) { send_line("ERR ", "BAD_PARAM"); return; }
        AD7606_SetOversampling((uint8_t)n);
        char num[4]; u32_to_dec(num, sizeof num, n);
        send_line("OK ", num);
        return;
    }

    // STATE?
    if (strcmp(s, "STATE?") == 0) {
        uint32_t v = (uint32_t)SM_GetState();
        char num[12]; u32_to_dec(num, sizeof num, v);
        send_line("OK ", num);
        return;
    }



    // --- SNAPSHOT ---
    // SNAP <N>        : arm N-frame snapshot (1..64)
    // SNAP?           : "OK <mV0> <mV1> <mV2> <mV3>" when ready, "BUSY" otherwise
    // SNAP CANCEL     : cancel active snapshot
    if (s[0] == 'S' && s[1] == 'N' && s[2] == 'A' && s[3] == 'P' &&
        (s[4] == 0 || s[4] == ' ' || s[4] == '\t' || s[4] == '?')) {

        const char *p = s + 4; while (*p == ' ' || *p == '\t') ++p;

        if (*p == '?') {
            int32_t adc[4];
            HAL_StatusTypeDef st = ACQ_Snapshot_Read_adc(adc);

            if (st == HAL_OK) {
                /* mV data */
                char out[128];
                int n = snprintf(out, sizeof(out),
                                 "%ld %ld %ld %ld G=%u %u %u %u",
                                 (long)adc[0], (long)adc[1], (long)adc[2], (long)adc[3],
                                 (unsigned)g_gain.current_gain[0],
                                 (unsigned)g_gain.current_gain[1],
                                 (unsigned)g_gain.current_gain[2],
                                 (unsigned)g_gain.current_gain[3]);

                (void)n;
                send_line("OK ", out);
            }
            else if (st == HAL_BUSY) {
                send_line("BUSY", "");
            }
            else {
                send_line("ERR ", "NO_SNAPSHOT");
            }
            return;
        }

        if (strcmp(p, "CANCEL") == 0) {
            HAL_StatusTypeDef st = ACQ_Snapshot_Cancel();
            if (st == HAL_OK) send_line("OK ", "");
            else              send_line("ERR ", "NOT_ACTIVE");
            return;
        }

        uint32_t n = 0;
        if (!parse_u32(p, &n) || n == 0 || n > 64) { send_line("ERR ", "BAD_PARAM"); return; }
        HAL_StatusTypeDef st = ACQ_Snapshot_Arm((uint8_t)n);
        if (st == HAL_OK) send_line("OK ", "SNAP ARMED");
        else              send_line("ERR ", "ARM_FAIL");
        return;
    }

    // ---- ACQ ARM/START/STOP ----
    if (strncmp(s, "ACQ ARM", 7) == 0) {
        const char *p = s + 7; while (*p == ' ' || *p == '\t') ++p;
        uint32_t frames = 0;
        if (!parse_u32(p, &frames) || frames == 0) { send_line("ERR ", "BAD_PARAM"); return; }
        HAL_StatusTypeDef st = ACQ_Arm(frames);
        send_line((st == HAL_OK) ? "OK " : "ERR ", (st == HAL_OK) ? "ARMED" : "ARM_FAIL");
        return;
    }

    if (strcmp(s, "ACQ START") == 0) {
        HAL_StatusTypeDef st = ACQ_StartStream();
        send_line((st == HAL_OK) ? "OK " : "ERR ", (st == HAL_OK) ? "STARTED" : "START_FAIL");
        return;
    }

    if (strcmp(s, "ACQ STOP") == 0) {
        ACQ_StopStream();
        send_line("OK ", "STOPPED");
        return;
    }

    // ---- TRIGARM <frames> R/F ----
    if (strncmp(s, "TRIGARM", 7) == 0) {
        const char *p = s + 7; while (*p == ' ' || *p == '\t') ++p;
        const char *p0 = p; while (*p && *p != ' ' && *p != '\t') ++p;
        char save = *p; *(char*)p = 0;
        uint32_t frames = 0; int ok = parse_u32(p0, &frames);
        *(char*)p = save; while (*p == ' ' || *p == '\t') ++p;
        if (!ok || frames == 0) { send_line("ERR ", "BAD_PARAM"); return; }
        uint8_t rising = (*p == 'R') ? 1 : (*p == 'F') ? 0 : 2;
        if (rising > 1) { send_line("ERR ", "POLARITY"); return; }

        HAL_StatusTypeDef st = ACQ_ArmForTrigger(frames, rising);
        send_line((st == HAL_OK) ? "OK " : "ERR ", (st == HAL_OK) ? "TRIG ARMED" : "ARM_FAIL");
        return;
    }

    // ---- FREQ? / FREQ <Hz> ----
    if (strcmp(s, "FREQ?") == 0) {
        uint32_t f = TIM3_GetFreqHz();
        char num[16]; u32_to_dec(num, sizeof num, f);
        send_line("OK ", num);
        return;
    }

    if (strncmp(s, "FREQ", 4) == 0 && (s[4] == ' ' || s[4] == '\t')) {
        const char *p = s + 4; while (*p == ' ' || *p == '\t') ++p;
        uint32_t hz = 0;
        if (!parse_u32(p, &hz)) { send_line("ERR ", "BAD_PARAM"); return; }
        if (TIM3_SetFreqHz(hz) == HAL_OK) send_line("OK ", "");
        else                              send_line("ERR ", "FREQ_FAIL");
        return;
    }

    // ---- XFER <bytes> (SDRAM → USB) ----
    if (strncmp(s, "XFER ", 5) == 0) {
        uint32_t n = 0;
        if (!parse_u32(s + 5, &n) || n == 0) { send_line("ERR ", "BAD_PARAM"); return; }

        uint32_t wr = ACQ_StreamWriteAddress();
        uint32_t available = (uint32_t)((uintptr_t)wr - (uintptr_t)SDRAM_BASE_ADDR);
        if (available == 0) { send_line("ERR ", "EMPTY"); return; }
        uint32_t frame_bytes = (uint32_t)ACQ_GetFrameBytes();
        if (frame_bytes == 0u) frame_bytes = 8u;
        available -= (available % frame_bytes);         // whole frames only
        if (n > available) n = available;
        n -= (n % frame_bytes);                         // whole frames only
        if (n == 0u) { send_line("ERR ", "BAD_PARAM"); return; }

        g_xfer_ptr   = (volatile uint8_t*)(uintptr_t)SDRAM_BASE_ADDR;
        g_xfer_bytes = n;
        __DMB();
        SM_SetState(STATE_TRANSFER);

        send_line("OK ", "START XFER");
        return;
    }

    // ---- SOFTRESET ----
    if (strcmp(s, "SOFTRESET") == 0) {
        ACQ_SoftReset();
        USB_CDC_Clear();
        send_line("OK ", "RESET");
        return;
    }

    // ---- DIE_TEMP? ----
    if (strcmp(s, "DIE_TEMP?") == 0) {
        float t = _read_die_temp_once();
        char buf[24];
        if (t < -999.0f) send_line("ERR ", "ADC");
        else { _format_1dec(buf, sizeof buf, t); send_line("OK ", buf); }
        return;
    }

    //For linear head
    // CAL <head> <gain>
    // Returns slope & intercept of that head/gain as hex-encoded IEEE754 floats:
    //   OK H<head> G<gain> S=<SLOPE_HEX> I=<INTERCEPT_HEX>
    if (s[0]=='C' && s[1]=='A' && s[2]=='L' &&
        (s[3]==0 || s[3]==' ' || s[3]=='\t'))
    {
        const char *p = s + 3;
        while (*p==' ' || *p=='\t') ++p;

        // parse <head>
        const char *p0 = p;
        while (*p && *p!=' ' && *p!='\t') ++p;
        char save = *p;
        *(char*)p = 0;

        uint32_t head = 0;
        if (!parse_u32(p0, &head)) {
            *(char*)p = save;
            send_line("ERR ", "BAD_PARAM");
            return;
        }
        *(char*)p = save;
        while (*p==' ' || *p=='\t') ++p;

        // parse <gain>
        uint32_t gain = 0;
        if (!parse_u32(p, &gain)) {
            send_line("ERR ", "BAD_PARAM");
            return;
        }

        float slope = 0.0f;
        float intercept = 0.0f;
        if (!CAL_Get((uint8_t)head, (uint8_t)gain, &slope, &intercept)) {
            send_line("ERR ", "BAD_PARAM");
            return;
        }

        // reinterpret float bits -> uint32_t (no %f used)
        uint32_t slope_bits = 0;
        uint32_t intercept_bits = 0;
        memcpy(&slope_bits, &slope, sizeof(slope_bits));
        memcpy(&intercept_bits, &intercept, sizeof(intercept_bits));

        char buf[80];
        // e.g. "H1 G3 S=499234AB I=41200000"
        snprintf(buf, sizeof(buf),
                 "H%lu G%lu S=%08lX I=%08lX",
                 (unsigned long)head,
                 (unsigned long)gain,
                 (unsigned long)slope_bits,
                 (unsigned long)intercept_bits);

        send_line("OK ", buf);
        return;
    }

    // RANGE <0|1>
    if (strncmp(s, "RANGE ", 6) == 0) {
        int v = atoi(s + 6);

        if (v != 0 && v != 1) {
            send_line("ERR ", "BAD_PARAM");
            return;
        }

        HAL_GPIO_WritePin(
            ADC_RANGE_SEL_GPIO_Port,
            ADC_RANGE_SEL_Pin,
            v ? GPIO_PIN_SET : GPIO_PIN_RESET
        );


        send_line("OK ", v ? "RANGE=10V" : "RANGE=5V");
        return;
    }

    // RANGE?
    if (strcmp(s, "RANGE?") == 0) {
        GPIO_PinState r =
            HAL_GPIO_ReadPin(ADC_RANGE_SEL_GPIO_Port, ADC_RANGE_SEL_Pin);

        if (r == GPIO_PIN_SET)
            send_line("OK ", "1");
        else
            send_line("OK ", "0");

        return;
    }



    // ---- unknown ----
    send_line("ERR ", "UNKNOWN_CMD");
}
/* USER CODE END PRIVATE_FUNCTIONS_DECLARATION */

/**
  * @}
  */

USBD_CDC_ItfTypeDef USBD_Interface_fops_HS =
{
  CDC_Init_HS,
  CDC_DeInit_HS,
  CDC_Control_HS,
  CDC_Receive_HS,
  CDC_TransmitCplt_HS
};

/* Private functions ---------------------------------------------------------*/

/**
  * @brief  Initializes the CDC media low layer over the USB HS IP
  * @retval USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_Init_HS(void)
{
  /* USER CODE BEGIN 8 */
  /* Set Application Buffers */
  USBD_CDC_SetTxBuffer(&hUsbDeviceHS, UserTxBufferHS, 0);
  USBD_CDC_SetRxBuffer(&hUsbDeviceHS, UserRxBufferHS);
  return (USBD_OK);
  /* USER CODE END 8 */
}

/**
  * @brief  DeInitializes the CDC media low layer
  * @param  None
  * @retval USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_DeInit_HS(void)
{
  /* USER CODE BEGIN 9 */
  return (USBD_OK);
  /* USER CODE END 9 */
}

/**
  * @brief  Manage the CDC class requests
  * @param  cmd: Command code
  * @param  pbuf: Buffer containing command data (request parameters)
  * @param  length: Number of data to be sent (in bytes)
  * @retval Result of the operation: USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_Control_HS(uint8_t cmd, uint8_t* pbuf, uint16_t length)
{
  /* USER CODE BEGIN 10 */
  switch(cmd)
  {
  case CDC_SEND_ENCAPSULATED_COMMAND:

    break;

  case CDC_GET_ENCAPSULATED_RESPONSE:

    break;

  case CDC_SET_COMM_FEATURE:

    break;

  case CDC_GET_COMM_FEATURE:

    break;

  case CDC_CLEAR_COMM_FEATURE:

    break;

  /*******************************************************************************/
  /* Line Coding Structure                                                       */
  /*-----------------------------------------------------------------------------*/
  /* Offset | Field       | Size | Value  | Description                          */
  /* 0      | dwDTERate   |   4  | Number |Data terminal rate, in bits per second*/
  /* 4      | bCharFormat |   1  | Number | Stop bits                            */
  /*                                        0 - 1 Stop bit                       */
  /*                                        1 - 1.5 Stop bits                    */
  /*                                        2 - 2 Stop bits                      */
  /* 5      | bParityType |  1   | Number | Parity                               */
  /*                                        0 - None                             */
  /*                                        1 - Odd                              */
  /*                                        2 - Even                             */
  /*                                        3 - Mark                             */
  /*                                        4 - Space                            */
  /* 6      | bDataBits  |   1   | Number Data bits (5, 6, 7, 8 or 16).          */
  /*******************************************************************************/
  case CDC_SET_LINE_CODING:

    break;

  case CDC_GET_LINE_CODING:

    break;

  case CDC_SET_CONTROL_LINE_STATE:

    break;

  case CDC_SEND_BREAK:

    break;

  default:
    break;
  }

  return (USBD_OK);
  /* USER CODE END 10 */
}

/**
  * @brief  Data received over USB OUT endpoint are sent over CDC interface
  *         through this function.
  *
  *         @note
  *         This function will issue a NAK packet on any OUT packet received on
  *         USB endpoint until exiting this function. If you exit this function
  *         before transfer is complete on CDC interface (ie. using DMA controller)
  *         it will result in receiving more data while previous ones are still
  *         not sent.
  *
  * @param  Buf: Buffer of data to be received
  * @param  Len: Number of data received (in bytes)
  * @retval Result of the operation: USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_Receive_HS(uint8_t* Buf, uint32_t *Len)
{
  /* USER CODE BEGIN 11 */

  // accumulate bytes into g_cmd_buf until CR/LF, then process
  for (uint32_t i = 0; i < *Len; ++i) {
	  char c = (char)Buf[i];

	  if (c == '\r' || c == '\n') {
		  if (g_cmd_len > 0) {
			  g_cmd_buf[g_cmd_len] = 0;   // NUL-terminate
			  process_cmd(g_cmd_buf);
			  g_cmd_len = 0;
		  }
	  } else {
		  if (g_cmd_len + 1 < sizeof(g_cmd_buf)) {
			  g_cmd_buf[g_cmd_len++] = c;
		  } else {
			  // overflow → reset buffer and report once
			  g_cmd_len = 0;
			  send_line("ERR ", "LINE_TOO_LONG");
		  }
	  }
  }

  USBD_CDC_SetRxBuffer(&hUsbDeviceHS, &Buf[0]);
  USBD_CDC_ReceivePacket(&hUsbDeviceHS);
  return (USBD_OK);
  /* USER CODE END 11 */
}

/**
  * @brief  Data to send over USB IN endpoint are sent over CDC interface
  *         through this function.
  * @param  Buf: Buffer of data to be sent
  * @param  Len: Number of data to be sent (in bytes)
  * @retval Result of the operation: USBD_OK if all operations are OK else USBD_FAIL or USBD_BUSY
  */
uint8_t CDC_Transmit_HS(uint8_t* Buf, uint16_t Len)
{
  uint8_t result = USBD_OK;
  /* USER CODE BEGIN 12 */
  USBD_CDC_HandleTypeDef *hcdc = (USBD_CDC_HandleTypeDef*)hUsbDeviceHS.pClassData;
  if (hcdc->TxState != 0){
    return USBD_BUSY;
  }
  USBD_CDC_SetTxBuffer(&hUsbDeviceHS, Buf, Len);
  result = USBD_CDC_TransmitPacket(&hUsbDeviceHS);
  /* USER CODE END 12 */
  return result;
}

/**
  * @brief  CDC_TransmitCplt_HS
  *         Data transmitted callback
  *
  *         @note
  *         This function is IN transfer complete callback used to inform user that
  *         the submitted Data is successfully sent over USB.
  *
  * @param  Buf: Buffer of data to be received
  * @param  Len: Number of data received (in bytes)
  * @retval Result of the operation: USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_TransmitCplt_HS(uint8_t *Buf, uint32_t *Len, uint8_t epnum)
{
  uint8_t result = USBD_OK;
  /* USER CODE BEGIN 14 */
  (void)Buf; (void)Len; (void)epnum;
    // If a transfer is active, queue next chunk right away


  /* USER CODE END 14 */
  return result;
}

/* USER CODE BEGIN PRIVATE_FUNCTIONS_IMPLEMENTATION */

/* USER CODE END PRIVATE_FUNCTIONS_IMPLEMENTATION */

/**
  * @}
  */

/**
  * @}
  */
