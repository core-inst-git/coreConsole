/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.h
  * @brief          : Header for main.c file.
  *                   This file contains the common defines of the application.
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

/* Define to prevent recursive inclusion -------------------------------------*/
#ifndef __MAIN_H
#define __MAIN_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "stm32f7xx_hal.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */

/* USER CODE END Includes */

/* Exported types ------------------------------------------------------------*/
/* USER CODE BEGIN ET */

/* USER CODE END ET */

/* Exported constants --------------------------------------------------------*/
/* USER CODE BEGIN EC */

/* USER CODE END EC */

/* Exported macro ------------------------------------------------------------*/
/* USER CODE BEGIN EM */

/* USER CODE END EM */

void HAL_TIM_MspPostInit(TIM_HandleTypeDef *htim);

/* Exported functions prototypes ---------------------------------------------*/
void Error_Handler(void);

/* USER CODE BEGIN EFP */
extern uint8_t g_sdram_buffer[];
void SDRAM_FillPattern(void);
/* USER CODE END EFP */

/* Private defines -----------------------------------------------------------*/
#define ADC_STNDBY_Pin GPIO_PIN_11
#define ADC_STNDBY_GPIO_Port GPIOG
#define ADC_RANGE_SEL_Pin GPIO_PIN_12
#define ADC_RANGE_SEL_GPIO_Port GPIOG
#define ADC_RESET_Pin GPIO_PIN_13
#define ADC_RESET_GPIO_Port GPIOG
#define ADC_CS_Pin GPIO_PIN_14
#define ADC_CS_GPIO_Port GPIOG
#define ADC_FRSTDATA_Pin GPIO_PIN_6
#define ADC_FRSTDATA_GPIO_Port GPIOB
#define OS0_Pin GPIO_PIN_7
#define OS0_GPIO_Port GPIOB
#define OS1_Pin GPIO_PIN_8
#define OS1_GPIO_Port GPIOB
#define OS2_Pin GPIO_PIN_9
#define OS2_GPIO_Port GPIOB

/* USER CODE BEGIN Private defines */

/* USER CODE END Private defines */

#ifdef __cplusplus
}
#endif

#endif /* __MAIN_H */
