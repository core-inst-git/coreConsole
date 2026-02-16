#include "ad7606.h"
#include "acq_control.h"
#include "main.h"
#include <string.h>

/* ---------- SPI & GPIO ---------- */
extern SPI_HandleTypeDef hspi5;

/* Public frame latch (optional convenience) */
volatile uint8_t ad7606_frame_ready = 0;
int16_t          ad7606_last_frame[4] = {0};

/* Device handle (defaults; edit vfs if you switch range) */
AD7606_Handle had7606 = {
    .hspi     = &hspi5,
    .cs_port  = AD7606_CS_PORT,
    .cs_pin   = AD7606_CS_PIN,
    .rst_port = AD7606_RST_PORT,
    .rst_pin  = AD7606_RST_PIN,
    .vfs      = 5.0f   /* ±5 V mode by default */
};

/* ---------- Internals ---------- */
static volatile uint32_t s_spi_timeouts = 0;

void CS_LOW(void)  { had7606.cs_port->BSRR = (uint32_t)had7606.cs_pin << 16; }
void CS_HIGH(void) { had7606.cs_port->BSRR = (uint32_t)had7606.cs_pin; }

static inline void SPI5_Drain(void)
{
    SPI_TypeDef *S = SPI5;
    if (S->SR & SPI_SR_RXNE) (void)*(__IO int16_t*)&S->DR;  /* signed read clears RXNE */
    (void)S->SR; /* completes OVR clear if any */
}

/* ---------- Public: init / reset ---------- */
void AD7606_Init(AD7606_Handle *h)
{
    (void)h;
    CS_HIGH();
    /* Hardware reset pulse (active-high pin per your wiring) */
    /* Be resilient if Cube tweaked SPI: enforce the format we need */
    SPI5_Ensure_Mode0_16bit_FullDuplex_SwNSS_Presc8();
    HAL_Delay(10);
    AD7606_Reset(h);
    HAL_Delay(10);
    AD7606_SetOversampling(0);
}

void AD7606_Reset(AD7606_Handle *h)
{
    HAL_GPIO_WritePin(h->rst_port, h->rst_pin, GPIO_PIN_SET);
    HAL_Delay(2);
    HAL_GPIO_WritePin(h->rst_port, h->rst_pin, GPIO_PIN_RESET);
    HAL_Delay(2);
}

static inline void delay_cycles(volatile uint32_t cycles)
{
    while (cycles--) {
        __NOP();
    }
}

void SPI5_Ensure_Mode0_16bit_FullDuplex_SwNSS_Presc8(void)
{
    SPI_TypeDef *S = SPI5;

    /* Wait for idle and disable SPI */
    while (S->SR & SPI_SR_BSY) {}
    S->CR1 &= ~SPI_CR1_SPE;

    /* Clear RX overrun if any */
    (void)S->DR;
    (void)S->SR;

    /* Mode 0: CPOL=0, CPHA=0, prescaler /8 */
    S->CR1 =
        SPI_CR1_MSTR |
        SPI_CR1_BR_1 |        /* BR = 010 → /8 */
        /* no SPI_CR1_CPOL */ /* CPOL = 0 */
        /* no SPI_CR1_CPHA */ /* CPHA = 0 */
        SPI_CR1_SSM  |
        SPI_CR1_SSI;

    /* Ensure full-duplex, no CRC */
    S->CR1 &= ~(SPI_CR1_RXONLY | SPI_CR1_BIDIMODE | SPI_CR1_CRCEN);

    /* 16-bit data size, RXNE on 16-bit */
    S->CR2 = (S->CR2 & ~(SPI_CR2_DS_Msk | SPI_CR2_FRXTH | SPI_CR2_NSSP))
           | (15U << SPI_CR2_DS_Pos);
    S->CR2 &= ~SPI_CR2_FRXTH;

    /* Enable SPI */
    S->CR1 |= SPI_CR1_SPE;
}
/* ---------- SPI format helper ---------- */
/* 16-bit, CPOL=1, CPHA=1st edge, SW-NSS, presc=/8 */
void SPI5_Ensure_Mode1_16bit_FullDuplex_SwNSS_Presc8(void)
{
    SPI_TypeDef *S = SPI5;

    /* Wait for idle and disable SPI */
    while (S->SR & SPI_SR_BSY) {}
    S->CR1 &= ~SPI_CR1_SPE;

    /* Clear RX overrun if any */
    (void)S->DR;
    (void)S->SR;

    /* Mode 1: CPOL=0, CPHA=1, prescaler /8 */
    S->CR1 =
        SPI_CR1_MSTR |
        SPI_CR1_BR_1 |        // BR = 010 → /8
        SPI_CR1_CPHA |        // CPHA = 1
        SPI_CR1_SSM  |
        SPI_CR1_SSI;

    /* Ensure full-duplex, no CRC */
    S->CR1 &= ~(SPI_CR1_RXONLY | SPI_CR1_BIDIMODE | SPI_CR1_CRCEN);

    /* 16-bit data size, RXNE on 16-bit */
    S->CR2 = (S->CR2 & ~(SPI_CR2_DS_Msk | SPI_CR2_FRXTH | SPI_CR2_NSSP))
           | (15U << SPI_CR2_DS_Pos);

    /* Enable SPI */
    S->CR1 |= SPI_CR1_SPE;
}

/* ---------- Readers ---------- */
/* Blocking tight burst: 4×16 clocks under one CS. No timeouts. */


/* Oversampling Control. */

void AD7606_SetOversampling(uint8_t ratio_0_to_7)
{
    if (ratio_0_to_7 > 6) ratio_0_to_7 = 6; // clamp

    // Extract bits
    uint8_t b0 = (ratio_0_to_7 >> 0) & 0x1;  // OS0 LSB
    uint8_t b1 = (ratio_0_to_7 >> 1) & 0x1;  // OS1
    uint8_t b2 = (ratio_0_to_7 >> 2) & 0x1;  // OS2 MSB

    // Write pins (OSx pins are active high)
    HAL_GPIO_WritePin(GPIOB, OS0_Pin, b0 ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_GPIO_WritePin(GPIOB, OS1_Pin, b1 ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_GPIO_WritePin(GPIOB, OS2_Pin, b2 ? GPIO_PIN_SET : GPIO_PIN_RESET);
    ACQ_Snapshot_Arm(10);
}


static inline uint8_t FRSTDATA_IS_HIGH(void)
{
    return (ADC_FRSTDATA_GPIO_Port->IDR & ADC_FRSTDATA_Pin) ? 1U : 0U;
}

void SPI5_ClearRxFifo(void)
{
    SPI_TypeDef *S = SPI5;
    volatile uint32_t tmp;

    // Drain RXNE
    while (S->SR & SPI_SR_RXNE) { tmp = S->DR; (void)tmp; }

    // Clear OVR by reading DR then SR (standard sequence)
    tmp = S->DR; (void)tmp;
    tmp = S->SR; (void)tmp;
}

static inline int wait_frstdata_high(uint32_t spins)
{
    while (spins--) {
        if (FRSTDATA_IS_HIGH()) return 1;
    }
    return 0;
}


int AD7606_Read4Words_Tight(int16_t *dst)
{
    SPI_TypeDef *S = SPI5;

    // Tune these
    const uint32_t SPIN_TXRX   = 200000;  // your existing timeout
    const uint32_t SPIN_FRST   = 2000;    // small wait for FRSTDATA (<< 1us typically)

    SPI5_ClearRxFifo();

    CS_LOW();

    // Wait a tiny moment for AD7606 to drive DOUT/FRSTDATA after CS falling
    // (Your single-sample check was too aggressive)
    if (!wait_frstdata_high(SPIN_FRST)) {
        CS_HIGH();
        s_spi_timeouts++;
        SPI5_ClearRxFifo();
        return 0;
    }

    // Read 4 x 16-bit words (clocking with dummy 0xFFFF)
    for (int i = 0; i < 4; i++) {

        uint32_t spins = SPIN_TXRX;
        while (!(S->SR & SPI_SR_TXE)) { if (--spins == 0) goto fail; }
        *(__IO uint16_t *)&S->DR = 0xFFFF;

        spins = SPIN_TXRX;
        while (!(S->SR & SPI_SR_RXNE)) { if (--spins == 0) goto fail; }

        // Keep your original mapping if you want V1..V4
        dst[3 - i] = *(__IO int16_t *)&S->DR;
    }

    // Ensure last bit fully shifted out before CS high
    uint32_t spins = SPIN_TXRX;
    while (S->SR & SPI_SR_BSY) { if (--spins == 0) goto fail; }

    CS_HIGH();
    return 1;

fail:
    CS_HIGH();
    s_spi_timeouts++;
    SPI5_ClearRxFifo();
    return 0;
}
