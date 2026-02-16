################################################################################
# Automatically-generated file. Do not edit!
# Toolchain: GNU Tools for STM32 (13.3.rel1)
################################################################################

# Add inputs and outputs from these tool invocations to the build variables 
C_SRCS += \
../Core/Src/acq_control.c \
../Core/Src/ad7606.c \
../Core/Src/calib.c \
../Core/Src/dfu_jump.c \
../Core/Src/globals.c \
../Core/Src/i2c.c \
../Core/Src/leds.c \
../Core/Src/main.c \
../Core/Src/sht40.c \
../Core/Src/state_machine.c \
../Core/Src/stm32f7xx_hal_msp.c \
../Core/Src/stm32f7xx_it.c \
../Core/Src/syscalls.c \
../Core/Src/sysmem.c \
../Core/Src/system_stm32f7xx.c \
../Core/Src/timer_adc_trig.c \
../Core/Src/timer_control.c \
../Core/Src/transfer.c \
../Core/Src/usb_xfer.c 

OBJS += \
./Core/Src/acq_control.o \
./Core/Src/ad7606.o \
./Core/Src/calib.o \
./Core/Src/dfu_jump.o \
./Core/Src/globals.o \
./Core/Src/i2c.o \
./Core/Src/leds.o \
./Core/Src/main.o \
./Core/Src/sht40.o \
./Core/Src/state_machine.o \
./Core/Src/stm32f7xx_hal_msp.o \
./Core/Src/stm32f7xx_it.o \
./Core/Src/syscalls.o \
./Core/Src/sysmem.o \
./Core/Src/system_stm32f7xx.o \
./Core/Src/timer_adc_trig.o \
./Core/Src/timer_control.o \
./Core/Src/transfer.o \
./Core/Src/usb_xfer.o 

C_DEPS += \
./Core/Src/acq_control.d \
./Core/Src/ad7606.d \
./Core/Src/calib.d \
./Core/Src/dfu_jump.d \
./Core/Src/globals.d \
./Core/Src/i2c.d \
./Core/Src/leds.d \
./Core/Src/main.d \
./Core/Src/sht40.d \
./Core/Src/state_machine.d \
./Core/Src/stm32f7xx_hal_msp.d \
./Core/Src/stm32f7xx_it.d \
./Core/Src/syscalls.d \
./Core/Src/sysmem.d \
./Core/Src/system_stm32f7xx.d \
./Core/Src/timer_adc_trig.d \
./Core/Src/timer_control.d \
./Core/Src/transfer.d \
./Core/Src/usb_xfer.d 


# Each subdirectory must supply rules for building sources it contributes
Core/Src/%.o Core/Src/%.su Core/Src/%.cyclo: ../Core/Src/%.c Core/Src/subdir.mk
	arm-none-eabi-gcc "$<" -mcpu=cortex-m7 -std=gnu11 -DUSE_HAL_DRIVER -DSTM32F730xx -c -I../Core/Inc -I../Drivers/STM32F7xx_HAL_Driver/Inc -I../Drivers/STM32F7xx_HAL_Driver/Inc/Legacy -I../Drivers/CMSIS/Device/ST/STM32F7xx/Include -I../Drivers/CMSIS/Include -I../USB_DEVICE/App -I../USB_DEVICE/Target -I../Middlewares/ST/STM32_USB_Device_Library/Core/Inc -I../Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc -Os -ffunction-sections -fdata-sections -fstack-usage -fcyclomatic-complexity -MMD -MP -MF"$(@:%.o=%.d)" -MT"$@" --specs=nano.specs -mfpu=fpv5-sp-d16 -mfloat-abi=hard -mthumb -o "$@"

clean: clean-Core-2f-Src

clean-Core-2f-Src:
	-$(RM) ./Core/Src/acq_control.cyclo ./Core/Src/acq_control.d ./Core/Src/acq_control.o ./Core/Src/acq_control.su ./Core/Src/ad7606.cyclo ./Core/Src/ad7606.d ./Core/Src/ad7606.o ./Core/Src/ad7606.su ./Core/Src/calib.cyclo ./Core/Src/calib.d ./Core/Src/calib.o ./Core/Src/calib.su ./Core/Src/dfu_jump.cyclo ./Core/Src/dfu_jump.d ./Core/Src/dfu_jump.o ./Core/Src/dfu_jump.su ./Core/Src/globals.cyclo ./Core/Src/globals.d ./Core/Src/globals.o ./Core/Src/globals.su ./Core/Src/i2c.cyclo ./Core/Src/i2c.d ./Core/Src/i2c.o ./Core/Src/i2c.su ./Core/Src/leds.cyclo ./Core/Src/leds.d ./Core/Src/leds.o ./Core/Src/leds.su ./Core/Src/main.cyclo ./Core/Src/main.d ./Core/Src/main.o ./Core/Src/main.su ./Core/Src/sht40.cyclo ./Core/Src/sht40.d ./Core/Src/sht40.o ./Core/Src/sht40.su ./Core/Src/state_machine.cyclo ./Core/Src/state_machine.d ./Core/Src/state_machine.o ./Core/Src/state_machine.su ./Core/Src/stm32f7xx_hal_msp.cyclo ./Core/Src/stm32f7xx_hal_msp.d ./Core/Src/stm32f7xx_hal_msp.o ./Core/Src/stm32f7xx_hal_msp.su ./Core/Src/stm32f7xx_it.cyclo ./Core/Src/stm32f7xx_it.d ./Core/Src/stm32f7xx_it.o ./Core/Src/stm32f7xx_it.su ./Core/Src/syscalls.cyclo ./Core/Src/syscalls.d ./Core/Src/syscalls.o ./Core/Src/syscalls.su ./Core/Src/sysmem.cyclo ./Core/Src/sysmem.d ./Core/Src/sysmem.o ./Core/Src/sysmem.su ./Core/Src/system_stm32f7xx.cyclo ./Core/Src/system_stm32f7xx.d ./Core/Src/system_stm32f7xx.o ./Core/Src/system_stm32f7xx.su ./Core/Src/timer_adc_trig.cyclo ./Core/Src/timer_adc_trig.d ./Core/Src/timer_adc_trig.o ./Core/Src/timer_adc_trig.su ./Core/Src/timer_control.cyclo ./Core/Src/timer_control.d ./Core/Src/timer_control.o ./Core/Src/timer_control.su ./Core/Src/transfer.cyclo ./Core/Src/transfer.d ./Core/Src/transfer.o ./Core/Src/transfer.su ./Core/Src/usb_xfer.cyclo ./Core/Src/usb_xfer.d ./Core/Src/usb_xfer.o ./Core/Src/usb_xfer.su

.PHONY: clean-Core-2f-Src

