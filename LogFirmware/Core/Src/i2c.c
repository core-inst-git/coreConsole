#include "i2c.h"
#include "globals.h"
#include <string.h>
#include "main.h"
/* ===== Extern globals (defined in globals.c) ===== */
extern EnvState  g_env;
extern GainState g_gain;
extern volatile uint8_t g_i2c_refresh_request;

/* ===== HAL handle ===== */
extern I2C_HandleTypeDef hi2c3;

/* HAL wants 8-bit address = (7-bit << 1) */
#define TCA_ADDR8   (TCA6424_ADDR << 1)
#define SHT_ADDR8   (SHT45_I2C_ADDR << 1)

/* Keep timeouts short; this runs in main loop */
#define I2C_TO_MS   10u

/* ===================== Optional: local MSP init =====================
   If your project ALREADY has HAL_I2C_MspInit() in stm32xxxx_hal_msp.c
   then DO NOT enable this, or you'll get duplicate symbols.

   If you do NOT have MSP init for I2C3 anywhere, you can enable this:
   - add:  #define I2C3_MSP_INIT_LOCAL 1
   either here or in compiler flags.
*/
#ifdef I2C3_MSP_INIT_LOCAL
void HAL_I2C_MspInit(I2C_HandleTypeDef* hi2c)
{
    GPIO_InitTypeDef GPIO_InitStruct = {0};

    if (hi2c->Instance == I2C3)
    {
        /* Peripheral clock enable (exact RCC call depends on STM32 family) */
        __HAL_RCC_I2C3_CLK_ENABLE();
        __HAL_RCC_GPIOA_CLK_ENABLE();
        __HAL_RCC_GPIOC_CLK_ENABLE();

        /* PA8 -> I2C3_SCL, PC9 -> I2C3_SDA (as per your Cube mapping) */
        GPIO_InitStruct.Pin = GPIO_PIN_8;
        GPIO_InitStruct.Mode = GPIO_MODE_AF_OD;
        GPIO_InitStruct.Pull = GPIO_PULLUP; /* external pullups preferred */
        GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
        GPIO_InitStruct.Alternate = GPIO_AF4_I2C3; /* verify AF for your MCU */
        HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

        GPIO_InitStruct.Pin = GPIO_PIN_9;
        GPIO_InitStruct.Mode = GPIO_MODE_AF_OD;
        GPIO_InitStruct.Pull = GPIO_PULLUP;
        GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
        GPIO_InitStruct.Alternate = GPIO_AF4_I2C3; /* verify AF for your MCU */
        HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);
    }
}

void HAL_I2C_MspDeInit(I2C_HandleTypeDef* hi2c)
{
    if (hi2c->Instance == I2C3)
    {
        __HAL_RCC_I2C3_CLK_DISABLE();
        HAL_GPIO_DeInit(GPIOA, GPIO_PIN_8);
        HAL_GPIO_DeInit(GPIOC, GPIO_PIN_9);
    }
}
#endif /* I2C3_MSP_INIT_LOCAL */

/* ===================== Cube init ===================== */
void MX_I2C3_Init(void)
{
    hi2c3.Instance = I2C3;
    hi2c3.Init.Timing = 0x20404768;  /* keep what CubeMX generated */
    hi2c3.Init.OwnAddress1 = 0;
    hi2c3.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
    hi2c3.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
    hi2c3.Init.OwnAddress2 = 0;
    hi2c3.Init.OwnAddress2Masks = I2C_OA2_NOMASK;
    hi2c3.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
    hi2c3.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;

    if (HAL_I2C_Init(&hi2c3) != HAL_OK)
    {
        Error_Handler();
    }

    if (HAL_I2CEx_ConfigAnalogFilter(&hi2c3, I2C_ANALOGFILTER_ENABLE) != HAL_OK)
    {
        Error_Handler();
    }

    if (HAL_I2CEx_ConfigDigitalFilter(&hi2c3, 0) != HAL_OK)
    {
        Error_Handler();
    }
}

/* ===================== Low-level reg ops ===================== */
static int TCA_WriteReg(uint8_t reg, uint8_t val)
{
    if (HAL_I2C_Mem_Write(&hi2c3, TCA_ADDR8, reg, I2C_MEMADD_SIZE_8BIT,
                          &val, 1, I2C_TO_MS) != HAL_OK)
        return 0;
    return 1;
}

static int TCA_ReadReg(uint8_t reg, uint8_t *val)
{
    if (HAL_I2C_Mem_Read(&hi2c3, TCA_ADDR8, reg, I2C_MEMADD_SIZE_8BIT,
                         val, 1, I2C_TO_MS) != HAL_OK)
        return 0;
    return 1;
}

/* ===================== Public TCA helpers ===================== */
void I2C_Init(void)
{
    /* Configure all TCA pins as outputs, no inversion, default low. */
    (void)TCA_WriteReg(TCA_REG_POLINV0, 0x00);
    (void)TCA_WriteReg(TCA_REG_POLINV1, 0x00);
    (void)TCA_WriteReg(TCA_REG_POLINV2, 0x00);

    (void)TCA_WriteReg(TCA_REG_OUTPUT0, 0x00);
    (void)TCA_WriteReg(TCA_REG_OUTPUT1, 0x00);
    (void)TCA_WriteReg(TCA_REG_OUTPUT2, 0x00);

    (void)TCA_WriteReg(TCA_REG_CONFIG0, 0x00);
    (void)TCA_WriteReg(TCA_REG_CONFIG1, 0x00);
    (void)TCA_WriteReg(TCA_REG_CONFIG2, 0x00);
}

int TCA_WriteOutputs(uint8_t p0, uint8_t p1, uint8_t p2)
{
    if (!TCA_WriteReg(TCA_REG_OUTPUT0, p0)) return 0;
    if (!TCA_WriteReg(TCA_REG_OUTPUT1, p1)) return 0;
    if (!TCA_WriteReg(TCA_REG_OUTPUT2, p2)) return 0;
    return 1;
}

int TCA_ReadOutputs(uint8_t *p0, uint8_t *p1, uint8_t *p2)
{
    uint8_t a=0,b=0,c=0;
    if (!TCA_ReadReg(TCA_REG_OUTPUT0, &a)) return 0;
    if (!TCA_ReadReg(TCA_REG_OUTPUT1, &b)) return 0;
    if (!TCA_ReadReg(TCA_REG_OUTPUT2, &c)) return 0;
    if (p0) *p0=a; if (p1) *p1=b; if (p2) *p2=c;
    return 1;
}

/*
 * HARD-CODED MAPPING (direct, no remap):
 *
 *   Head 1 (Channel 1): A0,A1,A2 -> P11, P12, P13
 *   Head 2 (Channel 2): A0,A1,A2 -> P06, P07, P10
 *   Head 3 (Channel 3): A0,A1,A2 -> P03, P04, P05
 *   Head 4 (Channel 4): A0,A1,A2 -> P00, P01, P02
 */

static void encode_gain_to_ports(uint8_t head, uint8_t val,
                                 uint8_t *p0, uint8_t *p1, uint8_t *p2)
{
    uint8_t b0 = (val >> 0) & 1u;   /* A0 (LSB) */
    uint8_t b1 = (val >> 1) & 1u;   /* A1 */
    uint8_t b2 = (val >> 2) & 1u;   /* A2 (MSB) */

    switch (head)
    {
    case 1: /* Head1: P11(A0), P12(A1), P13(A2) */
        *p1 = (uint8_t)(
              (*p1 & ~((1u << 1) | (1u << 2) | (1u << 3)))
            | (b0 << 1)
            | (b1 << 2)
            | (b2 << 3)
        );
        break;

    case 2: /* Head2: P06(A0), P07(A1), P10(A2) */
        *p0 = (uint8_t)(
              (*p0 & ~((1u << 6) | (1u << 7)))
            | (b0 << 6)
            | (b1 << 7)
        );
        *p1 = (uint8_t)(
              (*p1 & ~(1u << 0))
            | (b2 << 0)
        );
        break;

    case 3: /* Head3: P03(A0), P04(A1), P05(A2) */
        *p0 = (uint8_t)(
              (*p0 & ~((1u << 3) | (1u << 4) | (1u << 5)))
            | (b0 << 3)
            | (b1 << 4)
            | (b2 << 5)
        );
        break;

    case 4: /* Head4: P00(A0), P01(A1), P02(A2) */
        *p0 = (uint8_t)(
              (*p0 & ~((1u << 0) | (1u << 1) | (1u << 2)))
            | (b0 << 0)
            | (b1 << 1)
            | (b2 << 2)
        );
        break;

    default:
        break;
    }
}

static uint8_t decode_gain_head1(uint8_t p1)
{
    return ((p1 >> 1) & 1u)
         | (((p1 >> 2) & 1u) << 1)
         | (((p1 >> 3) & 1u) << 2);
}

static uint8_t decode_gain_head2(uint8_t p0, uint8_t p1)
{
    return ((p0 >> 6) & 1u)
         | (((p0 >> 7) & 1u) << 1)
         | (((p1 >> 0) & 1u) << 2);
}

static uint8_t decode_gain_head3(uint8_t p0)
{
    return ((p0 >> 3) & 1u)
         | (((p0 >> 4) & 1u) << 1)
         | (((p0 >> 5) & 1u) << 2);
}

static uint8_t decode_gain_head4(uint8_t p0)
{
    return ((p0 >> 0) & 1u)
         | (((p0 >> 1) & 1u) << 1)
         | (((p0 >> 2) & 1u) << 2);
}

static int ApplyGainWrite(uint8_t head, uint8_t val)
{
    if (head < 1u || head > 4u) return 0;
    val &= 0x07u;

    uint8_t p0=0, p1=0, p2=0;
    if (!TCA_ReadOutputs(&p0,&p1,&p2)) return 0;

    encode_gain_to_ports(head, val, &p0, &p1, &p2);

    return TCA_WriteOutputs(p0, p1, p2);
}

int I2C_ApplyGainNow(uint8_t head, uint8_t gain)
{
    if (head < 1u || head > 4u) return 0;
    gain &= 0x07u;
    return ApplyGainWrite(head, gain);
}

/* ===================== SHT45 ===================== */
static uint8_t sht_crc8(const uint8_t *data, int len)
{
    uint8_t crc=0xFF;
    for (int i=0;i<len;i++){
        crc ^= data[i];
        for (int b=0;b<8;b++)
            crc = (crc&0x80) ? (uint8_t)((crc<<1)^0x31) : (uint8_t)(crc<<1);
    }
    return crc;
}

static int sht_write_cmd(uint8_t cmd)
{
    if (HAL_I2C_Master_Transmit(&hi2c3, SHT_ADDR8, &cmd, 1, I2C_TO_MS) != HAL_OK)
        return 0;
    return 1;
}

int SHT_Read(float *tC, float *rhPct)
{
    if (!sht_write_cmd(0xFD)) return 0; /* High repeatability */
    HAL_Delay(20);

    uint8_t rx[6];
    if (HAL_I2C_Master_Receive(&hi2c3, SHT_ADDR8, rx, 6, 20) != HAL_OK)
        return 0;

    if (sht_crc8(rx,2)     != rx[2]) return 0;
    if (sht_crc8(&rx[3],2) != rx[5]) return 0;

    uint16_t t_ticks  = ((uint16_t)rx[0]<<8) | rx[1];
    uint16_t rh_ticks = ((uint16_t)rx[3]<<8) | rx[4];

    float t  = -45.0f + 175.0f * ((float)t_ticks  / 65535.0f);
    float rh =  -6.0f + 125.0f * ((float)rh_ticks / 65535.0f);
    if (rh < 0.f)   rh = 0.f;
    if (rh > 100.f) rh = 100.f;

    if (tC)    *tC    = t;
    if (rhPct) *rhPct = rh;
    return 1;
}

/* ===================== Service API ===================== */
void I2C_RequestGain(uint8_t head, uint8_t val)
{
    if (head < 1u || head > 4u) return;
    val &= 0x07u;
    g_gain.gain_write_head = head;
    g_gain.gain_write_val  = val;
    g_gain.pending_write   = 1;
    g_i2c_refresh_request  = 1;
}

void I2C_RequestRefresh(void)
{
    g_i2c_refresh_request  = 1;
}

void I2C_Refresh(void)
{
    g_i2c_refresh_request = 0;

    /* Apply pending gain write first */
    if (g_gain.pending_write){
        (void)ApplyGainWrite(g_gain.gain_write_head, g_gain.gain_write_val);
        g_gain.pending_write = 0;
    }

    /* Read back OUT latches -> decode to per-head gains (1..4) */
    uint8_t p0=0,p1=0,p2=0;
    if (TCA_ReadOutputs(&p0,&p1,&p2)) {
        g_gain.current_gain[0] = decode_gain_head1(p1);
        g_gain.current_gain[1] = decode_gain_head2(p0,p1);
        g_gain.current_gain[2] = decode_gain_head3(p0);
        g_gain.current_gain[3] = decode_gain_head4(p0);
    }

    /* Read SHT45 (blocking) */
    float t,h;
    if (SHT_Read(&t,&h)){
        g_env.temperature_C = t;
        g_env.humidity_pct  = h;
    }
}
